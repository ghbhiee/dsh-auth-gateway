/**
 * Browser terminal gateway: one WebSocket per browser tab, many PTY sessions
 * behind it.
 *
 * Why not `ctx.terminals`: that registry is the agent-facing PTY surface. It
 * runs its shells under `TERM=dumb`, strips every CSI/OSC sequence on the way
 * out, rewrites the prompt, allows one in-flight send per session, and keys
 * every call on an owning `Agent`. All four are right for a model and wrong for
 * xterm.js. This gateway sits one layer down, on raw PTY bytes.
 *
 * node-pty is resolved at runtime from the profile's installed tree (dsh
 * already depends on it) rather than vendored a second time.
 *
 * Known limitation: a session spawned under one sandbox mode keeps that
 * confinement for its lifetime. Lowering the mode later does not retroactively
 * tighten a running shell — close it and open a new one.
 *
 * @module dsh-plugin-workbench/pty
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { createRequire } from 'node:module'
import { accessSync, chmodSync, constants, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isSameOrigin } from './origin.ts'
import { composeRoots, resolveCwdWithinRoots } from './roots.ts'

/** Minimal shape this module needs from node-pty. */
interface Pty {
  pid: number
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (event: { exitCode: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

interface NodePty {
  spawn: (file: string, args: readonly string[], options: {
    name: string
    cols: number
    rows: number
    cwd: string
    env: Record<string, string>
  }) => Pty
}

/** Chunks buffered for a background session before its tab is looked at again. */
const MAX_BUFFERED_CHUNKS = 5000

/** terminfo entry advertised to the shell; matches what xterm.js implements. */
const TERM_NAME = 'xterm-256color'

interface PtySession {
  id: string
  pty: Pty
  shell: string
  createdAt: number
}

interface Connection {
  sessions: Map<string, PtySession>
  activeSessionId: string | null
  buffers: Map<string, string[]>
  /** The browser socket, so teardown can hang up rather than leave it dangling. */
  socket: WebSocket
}

/** Settings the gateway reads per connection. */
export interface PtyOptions {
  /** Refuse non-loopback callers. */
  loopbackOnly: boolean
  /** Shell to spawn; empty means detect from the environment. */
  shell: string
  /** Extra absolute read roots — the same fence the file API uses, so a shell can
   * open in the session's cwd but never outside an allowed root. */
  readRoots: string[]
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Restore the execute bit on node-pty's `spawn-helper`.
 *
 * Package managers that extract from a content-addressed store (pnpm, and any
 * tarball copy that loses modes) can leave the helper at 0644. node-pty then
 * fails every spawn with a bare `posix_spawnp failed.`, which says nothing
 * about the cause. Cheap to check, and it turns an opaque failure into none.
 * @param requireFrom - a require bound to the tree node-pty was resolved from.
 */
function ensureSpawnHelperExecutable(requireFrom: NodeRequire): void {
  if (process.platform === 'win32') return
  try {
    const root = dirname(requireFrom.resolve('node-pty/package.json'))
    const candidates = [
      join(root, 'build', 'Release', 'spawn-helper'),
      join(root, 'build', 'Debug', 'spawn-helper'),
      join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ]
    for (const helper of candidates) {
      if (!existsSync(helper)) continue
      try {
        accessSync(helper, constants.X_OK)
      } catch {
        chmodSync(helper, 0o755)
      }
    }
  } catch {
    // Best effort: if the layout is unfamiliar, let the spawn error speak.
  }
}

/**
 * Load node-pty from whichever tree actually has it.
 *
 * A plugin installed with `link:` keeps its own node_modules, so resolving
 * from this module alone misses the copy dsh already installed in the profile.
 * `ctx.baseUrl` is the profile directory (where cordis.yml lives), and pnpm's
 * hoisted profile layout puts node-pty directly under it.
 * @param baseUrl - the loader's base URL for this entry, when it has one.
 * @returns the node-pty module.
 * @throws when no anchor resolves it, naming every path tried.
 */
function loadNodePty(baseUrl: string | undefined): NodePty {
  const anchors = [import.meta.url, ...(baseUrl === undefined ? [] : [baseUrl])]
  const failures: string[] = []
  for (const anchor of anchors) {
    try {
      const requireFrom = createRequire(anchor)
      requireFrom.resolve('node-pty')
      ensureSpawnHelperExecutable(requireFrom)
      return requireFrom('node-pty') as NodePty
    } catch (error) {
      failures.push(`${anchor}: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`)
    }
  }
  throw new Error(
    'workbench: ptyEnabled is on but node-pty could not be resolved. '
    + 'Install it into the profile (dsh plugin --profile <name> add node-pty) or into this plugin. Tried:\n'
    + failures.map(line => `  - ${line}`).join('\n'),
  )
}

/** Pick a login shell for the platform. */
export function detectShell(configured: string): string {
  if (configured !== '') return configured
  if (process.platform === 'win32') return 'powershell.exe'
  for (const candidate of [process.env.SHELL, '/bin/zsh', '/bin/bash']) {
    if (candidate !== undefined && candidate !== '' && existsSync(candidate)) return candidate
  }
  return '/bin/bash'
}

function shellName(shell: string): string {
  return shell.split('/').pop() ?? 'shell'
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * Wrap the shell argv in the kernel-level sandbox unless the policy is
 * full access — the same rule `terminal-bash` applies to agent PTYs.
 * @param ctx - plugin context.
 * @param shell - shell executable.
 * @returns argv to spawn (confined when the mode requires it) and the policy's
 * workspace root, which is both the fence anchor and the fallback cwd.
 */
function confinedArgv(ctx: Context, shell: string): { argv: string[]; mode: string; workspaceRoot: string } {
  const policy = ctx.sandboxPolicy.resolve()
  const argv = [shell]
  if (policy.mode === 'danger-full-access') return { argv, mode: policy.mode, workspaceRoot: policy.workspaceRoot }
  const sandbox = ctx.get('sandbox')
  if (sandbox === undefined) {
    throw new Error(`workbench: sandbox mode "${policy.mode}" needs a ctx.sandbox provider to open a terminal`)
  }
  return {
    argv: [...sandbox.confine(argv, { ...policy, mode: policy.mode }).argv],
    mode: policy.mode,
    workspaceRoot: policy.workspaceRoot,
  }
}

/**
 * Build the upgrade handler that serves browser terminals.
 * @param ctx - plugin context (reads `ctx.sandboxPolicy` and optionally `ctx.sandbox`).
 * @param options - live plugin settings.
 * @returns the upgrade handler plus a disposer that kills every live shell.
 */
export function createPtyGateway(ctx: Context, options: PtyOptions): {
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  dispose: () => void
} {
  const pty = loadNodePty(ctx.baseUrl)
  const server = new WebSocketServer({ noServer: true })
  const connections = new Set<Connection>()

  /**
   * Where a new shell should open.
   *
   * The browser asks for the session's cwd; anything the client chose is as
   * untrusted as a file path, so it is fenced exactly the same way — canonical,
   * inside an allowed root, or rejected. A rejected or absent request falls back
   * to the workspace root, never to whatever was asked for.
   * @param requested - the client's desired cwd, or undefined.
   * @param workspaceRoot - the policy workspace root, both fence anchor and fallback.
   * @returns a directory guaranteed to be inside the fence.
   */
  async function resolveSpawnCwd(requested: string | undefined, workspaceRoot: string): Promise<string> {
    if (requested === undefined || requested === '') return workspaceRoot
    const roots = composeRoots(workspaceRoot, options.readRoots)
    const inside = await resolveCwdWithinRoots(roots, requested)
    return inside ?? workspaceRoot
  }

  async function spawnSession(requestedCwd?: string): Promise<PtySession> {
    const shell = detectShell(options.shell)
    const { argv, workspaceRoot } = confinedArgv(ctx, shell)
    const [file, ...args] = argv
    if (file === undefined) throw new Error('workbench: empty shell argv')
    const cwd = await resolveSpawnCwd(requestedCwd, workspaceRoot)
    const child = pty.spawn(file, args, {
      // node-pty's `name` is what lands in TERM, overriding any env entry. It
      // has to match what xterm.js actually implements: with the older
      // `xterm-color` terminfo, apps fall back to 8 colors and the legacy
      // `?47h` alternate screen.
      name: TERM_NAME,
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env as Record<string, string>, TERM: TERM_NAME, DSH_WORKBENCH: '1' },
    })
    return { id: newId(), pty: child, shell: shellName(shell), createdAt: Date.now() }
  }

  function attach(conn: Connection, session: PtySession, socket: WebSocket): void {
    session.pty.onData((data) => {
      if (socket.readyState !== socket.OPEN) return
      if (conn.activeSessionId === session.id) {
        socket.send(data)
        return
      }
      const buffered = conn.buffers.get(session.id) ?? []
      buffered.push(data)
      if (buffered.length > MAX_BUFFERED_CHUNKS) buffered.splice(0, buffered.length - MAX_BUFFERED_CHUNKS)
      conn.buffers.set(session.id, buffered)
    })
    session.pty.onExit(({ exitCode }) => {
      conn.sessions.delete(session.id)
      conn.buffers.delete(session.id)
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'exited', id: session.id, exitCode }))
      }
    })
  }

  /**
   * Kill a connection's shells and forget it.
   * @param conn - the connection being torn down.
   * @param hangUp - also close the browser socket. `ws.close()` on the server
   * does NOT close established connections, so on plugin teardown the browser
   * would otherwise keep a socket to a gateway that no longer exists — no close
   * event, so no reconnect, and a terminal frozen for good.
   */
  function killAll(conn: Connection, hangUp = false): void {
    for (const session of conn.sessions.values()) {
      try { session.pty.kill() } catch { /* already gone */ }
    }
    conn.sessions.clear()
    conn.buffers.clear()
    connections.delete(conn)
    if (hangUp && conn.socket.readyState === conn.socket.OPEN) {
      try { conn.socket.close(1001, 'workbench gateway unloaded') } catch { /* already closing */ }
    }
  }

  server.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const conn: Connection = { sessions: new Map(), activeSessionId: null, buffers: new Map(), socket }
    connections.add(conn)

    // The desired cwd rides in on the handshake URL, so the first shell (and the
    // one a reconnect brings up) already opens in the session's directory without
    // a round trip. It is still fenced at spawn time like any other request.
    let connectionCwd: string | undefined
    try {
      connectionCwd = new URL(req.url ?? '/', 'http://workbench.local').searchParams.get('cwd') ?? undefined
    } catch {
      connectionCwd = undefined
    }

    async function create(requestedCwd?: string): Promise<void> {
      let session: PtySession
      try {
        session = await spawnSession(requestedCwd ?? connectionCwd)
      } catch (error) {
        socket.send(JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) }))
        return
      }
      conn.sessions.set(session.id, session)
      conn.activeSessionId = session.id
      attach(conn, session, socket)
      socket.send(JSON.stringify({ type: 'created', id: session.id, pid: session.pty.pid, shell: session.shell }))
    }

    function control(message: { type?: string; sessionId?: string; cols?: number; rows?: number; cwd?: string }): void {
      switch (message.type) {
        case 'create':
          // A tab opened later carries the currently-viewed session's cwd; with
          // none it reuses the connection's, so + still lands where the first did.
          void create(typeof message.cwd === 'string' ? message.cwd : undefined)
          return
        case 'switch': {
          const session = message.sessionId === undefined ? undefined : conn.sessions.get(message.sessionId)
          if (session === undefined) {
            socket.send(JSON.stringify({ type: 'error', message: 'No such terminal session' }))
            return
          }
          conn.activeSessionId = session.id
          socket.send(JSON.stringify({ type: 'switched', id: session.id }))
          const buffered = conn.buffers.get(session.id)
          if (buffered !== undefined) {
            for (const chunk of buffered) socket.send(chunk)
            conn.buffers.delete(session.id)
          }
          return
        }
        case 'close': {
          const session = message.sessionId === undefined ? undefined : conn.sessions.get(message.sessionId)
          if (session === undefined) return
          try { session.pty.kill() } catch { /* already gone */ }
          conn.sessions.delete(session.id)
          conn.buffers.delete(session.id)
          if (conn.activeSessionId === session.id) {
            conn.activeSessionId = conn.sessions.keys().next().value ?? null
          }
          return
        }
        case 'resize': {
          const session = conn.activeSessionId === null ? undefined : conn.sessions.get(conn.activeSessionId)
          if (session === undefined) return
          try { session.pty.resize(Math.max(1, message.cols ?? 80), Math.max(1, message.rows ?? 24)) } catch { /* raced with exit */ }
          return
        }
        default:
          socket.send(JSON.stringify({ type: 'error', message: `Unknown control message: ${String(message.type)}` }))
      }
    }

    socket.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      if (text.charCodeAt(0) === 0x7b) {
        try {
          control(JSON.parse(text) as Record<string, never>)
          return
        } catch {
          // Not JSON after all: fall through and treat it as keystrokes.
        }
      }
      const session = conn.activeSessionId === null ? undefined : conn.sessions.get(conn.activeSessionId)
      session?.pty.write(text)
    })

    socket.on('close', () => { killAll(conn) })
    socket.on('error', () => { killAll(conn) })

    void create()
  })

  return {
    handler: (req, socket, head) => {
      if (options.loopbackOnly && !LOOPBACK.has(req.socket.remoteAddress ?? '')) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      // A loopback address is not proof of a trusted caller: a WebSocket
      // handshake dodges the same-origin policy, so a page the user is merely
      // visiting can open this socket — which is a shell — from their browser.
      // The connection would be loopback all the same. Refuse a cross-origin
      // handshake before it becomes a session.
      if (!isSameOrigin(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      server.handleUpgrade(req, socket, head, (client) => { server.emit('connection', client, req) })
    },
    dispose: () => {
      for (const conn of [...connections]) killAll(conn, true)
      server.close()
    },
  }
}
