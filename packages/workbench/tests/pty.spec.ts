/**
 * The terminal gateway, driven over a real WebSocket against real shells.
 *
 * Everything here is the wire protocol as a browser sees it: the control
 * messages, what raw bytes mean in each direction, and the invariant that a
 * closed socket takes its shells with it.
 */

import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import { createPtyGateway, detectShell } from '../src/pty.ts'

let server: Server
let url: string
let dispose: () => void

/** Full access keeps `ctx.sandbox` out of the picture; the fence has its own tests. */
function fakeCtx(): Context {
  return {
    baseUrl: import.meta.url,
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
    get: () => undefined,
  } as unknown as Context
}

interface Client {
  socket: WebSocket
  /** Everything received so far, raw output and control frames alike. */
  log: string[]
  /** Control frames, parsed. */
  control: Record<string, unknown>[]
  /** Wait until the accumulated raw output matches, or fail. */
  waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<string>
  /** Wait for a control frame of this type. */
  waitForControl: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>
  close: () => Promise<void>
}

async function connect(target: string = url): Promise<Client> {
  const socket = new WebSocket(target)
  const log: string[] = []
  const control: Record<string, unknown>[] = []
  socket.on('message', (raw: Buffer) => {
    const text = raw.toString('utf8')
    if (text.startsWith('{')) {
      try {
        control.push(JSON.parse(text) as Record<string, unknown>)
        return
      } catch { /* not control after all */ }
    }
    log.push(text)
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  const until = async <T>(probe: () => T | undefined, what: string, timeoutMs: number): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = probe()
      if (hit !== undefined) return hit
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(log.join('').slice(-200))}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  return {
    socket,
    log,
    control,
    waitForOutput: (pattern, timeoutMs = 5000) =>
      until(() => (pattern.test(log.join('')) ? log.join('') : undefined), pattern.source, timeoutMs),
    waitForControl: (type, timeoutMs = 5000) =>
      until(() => control.find(frame => frame.type === type), `control ${type}`, timeoutMs),
    close: () => new Promise<void>((resolve) => { socket.once('close', () => { resolve() }); socket.close() }),
  }
}

beforeAll(async () => {
  const gateway = createPtyGateway(fakeCtx(), { loopbackOnly: true, shell: '/bin/bash', readRoots: [] })
  dispose = gateway.dispose
  server = createServer()
  server.on('upgrade', (req, socket, head) => { gateway.handler(req, socket, head) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  url = `ws://127.0.0.1:${String(address.port)}/plugins/workbench/pty`
})

afterAll(async () => {
  dispose()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

describe('detectShell', () => {
  it('honours an explicit shell', () => {
    expect(detectShell('/bin/dash')).toBe('/bin/dash')
  })

  it('falls back to something that exists', () => {
    expect(detectShell('')).toMatch(/\/(zsh|bash|sh)$|powershell\.exe/)
  })
})

describe('gateway protocol', () => {
  it('opens a shell as soon as the socket connects', async () => {
    const client = await connect()
    const created = await client.waitForControl('created')
    expect(created).toMatchObject({ type: 'created', shell: 'bash' })
    expect(typeof created.pid).toBe('number')
    await client.close()
  })

  it('treats a bare string as keystrokes and streams the output back', async () => {
    const client = await connect()
    await client.waitForControl('created')
    client.socket.send('echo __PTY_OK__\r')
    await expect(client.waitForOutput(/__PTY_OK__/)).resolves.toContain('__PTY_OK__')
    await client.close()
  })

  it('applies a resize to the pty, not just to the client', async () => {
    const client = await connect()
    await client.waitForControl('created')
    client.socket.send(JSON.stringify({ type: 'resize', cols: 99, rows: 33 }))
    client.socket.send('stty size\r')
    await expect(client.waitForOutput(/33 99/)).resolves.toMatch(/33 99/)
    await client.close()
  })

  it('keeps a second shell separate and buffers the inactive one', async () => {
    const client = await connect()
    const first = await client.waitForControl('created')
    client.socket.send(JSON.stringify({ type: 'create' }))
    await client.waitForOutput(/\$|#|%/, 5000).catch(() => undefined)
    const second = client.control.filter(frame => frame.type === 'created')[1]
    expect(second?.id).not.toBe(first.id)

    // The first session is now inactive: its output must not interleave.
    client.socket.send('echo __SECOND__\r')
    await client.waitForOutput(/__SECOND__/)

    client.socket.send(JSON.stringify({ type: 'switch', sessionId: String(first.id) }))
    await expect(client.waitForControl('switched')).resolves.toMatchObject({ id: first.id })
    await client.close()
  })

  it('reports an unknown control message instead of ignoring it', async () => {
    const client = await connect()
    await client.waitForControl('created')
    client.socket.send(JSON.stringify({ type: 'nonsense' }))
    await expect(client.waitForControl('error')).resolves.toMatchObject({ type: 'error' })
    await client.close()
  })

  it('reports a switch to a session that does not exist', async () => {
    const client = await connect()
    await client.waitForControl('created')
    client.socket.send(JSON.stringify({ type: 'switch', sessionId: 'nope' }))
    await expect(client.waitForControl('error')).resolves.toMatchObject({ type: 'error' })
    await client.close()
  })

  it('kills the shell when the socket goes away', async () => {
    const client = await connect()
    const created = await client.waitForControl('created')
    const pid = created.pid as number
    expect(() => { process.kill(pid, 0) }).not.toThrow()

    await client.close()
    // Reaping is asynchronous; give the kill a moment to land.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`pty ${String(pid)} survived its socket`)
  })
})

describe('opening in a directory', () => {
  // The browser hands the terminal the session's cwd. It arrives untrusted —
  // over the handshake URL for the first shell, in the create message for a new
  // tab — so it is fenced exactly like a file path: canonical, inside a root, or
  // rejected in favour of the workspace root. Never opened blindly.
  let fenceRoot: string
  let cwdServer: Server
  let cwdUrl: string
  let cwdDispose: () => void
  const rx = (literal: string): RegExp => new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  beforeAll(async () => {
    fenceRoot = await realpath(await mkdtemp(join(tmpdir(), 'wb-pty-cwd-')))
    await mkdir(join(fenceRoot, 'project'), { recursive: true })
    const gateway = createPtyGateway(fakeCtx(), { loopbackOnly: true, shell: '/bin/bash', readRoots: [fenceRoot] })
    cwdDispose = gateway.dispose
    cwdServer = createServer()
    cwdServer.on('upgrade', (req, socket, head) => { gateway.handler(req, socket, head) })
    await new Promise<void>(resolve => cwdServer.listen(0, '127.0.0.1', resolve))
    const address = cwdServer.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    cwdUrl = `ws://127.0.0.1:${String(address.port)}/plugins/workbench/pty`
  })

  afterAll(async () => {
    cwdDispose()
    await new Promise<void>(resolve => cwdServer.close(() => { resolve() }))
    await rm(fenceRoot, { recursive: true, force: true })
  })

  it('opens the first shell in the cwd from the handshake url', async () => {
    const target = join(fenceRoot, 'project')
    const client = await connect(`${cwdUrl}?cwd=${encodeURIComponent(target)}`)
    await client.waitForControl('created')
    client.socket.send('pwd -P\r')
    await expect(client.waitForOutput(rx(target))).resolves.toContain(target)
    await client.close()
  })

  it('opens a + tab in the cwd from the create message', async () => {
    const target = join(fenceRoot, 'project')
    const client = await connect(cwdUrl)
    await client.waitForControl('created')
    client.socket.send(JSON.stringify({ type: 'create', cwd: target }))
    // The new tab becomes active; its pwd is the requested directory.
    await client.waitForOutput(/\$|#|%/, 5000).catch(() => undefined)
    client.socket.send('pwd -P\r')
    await expect(client.waitForOutput(rx(target))).resolves.toContain(target)
    await client.close()
  })

  it('refuses a cwd outside the fence and falls back to the workspace root', async () => {
    // /usr exists but is outside the fence (workspace root plus the tmp root), so
    // the shell must land in the workspace root, not there.
    const workspace = await realpath(process.cwd())
    const client = await connect(`${cwdUrl}?cwd=${encodeURIComponent('/usr')}`)
    await client.waitForControl('created')
    client.socket.send('pwd -P\r')
    await expect(client.waitForOutput(rx(workspace))).resolves.toContain(workspace)
    await client.close()
  })
})

describe('origin gate', () => {
  // This socket is a shell. A WebSocket handshake is not stopped by the
  // same-origin policy, so without this gate a page the user is merely visiting
  // could open it from their browser — the connection would be loopback all the
  // same — and run commands. Verified end to end in a browser before the fix:
  // a cross-origin page reached `created` and executed `id`.
  const wsHost = (): string => new URL(url.replace(/^ws/, 'http')).host

  it('refuses a handshake from another origin', async () => {
    const socket = new WebSocket(url, { headers: { origin: 'http://evil.example.com' } })
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => { socket.close(); resolve('OPENED') })
      socket.once('error', () => { resolve('REFUSED') })
    })
    expect(outcome).toBe('REFUSED')
  })

  it('accepts a handshake whose origin is this same server', async () => {
    const socket = new WebSocket(url, { headers: { origin: `http://${wsHost()}` } })
    const opened = await new Promise<boolean>((resolve) => {
      socket.once('open', () => resolve(true))
      socket.once('error', () => resolve(false))
    })
    expect(opened).toBe(true)
    socket.close()
  })

  it('accepts a handshake with no origin (not a browser)', async () => {
    // curl, a native client, the harness's own tooling: no Origin header, and
    // not subject to the confused-deputy problem this gate exists for.
    const socket = new WebSocket(url)
    const opened = await new Promise<boolean>((resolve) => {
      socket.once('open', () => resolve(true))
      socket.once('error', () => resolve(false))
    })
    expect(opened).toBe(true)
    socket.close()
  })
})

describe('teardown', () => {
  /** A gateway of its own, so disposing it cannot disturb the shared suite. */
  async function ownGateway() {
    const gateway = createPtyGateway(fakeCtx(), { loopbackOnly: true, shell: '/bin/bash', readRoots: [] })
    const httpServer = createServer()
    httpServer.on('upgrade', (req, socket, head) => { gateway.handler(req, socket, head) })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return { gateway, httpServer, url: `ws://127.0.0.1:${String(address.port)}/plugins/workbench/pty` }
  }

  it('hangs up on the browser when the plugin unloads', async () => {
    const { gateway, httpServer, url } = await ownGateway()
    const socket = new WebSocket(url)
    const created = new Promise<void>((resolve) => {
      socket.on('message', (raw: Buffer) => { if (raw.toString('utf8').includes('"created"')) resolve() })
    })
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    await created

    const closed = new Promise<number>(resolve => socket.once('close', code => { resolve(code) }))
    gateway.dispose()
    // Without the explicit hang-up this waits forever: ws.close() on the server
    // leaves established sockets open, so the browser never learns.
    await expect(closed).resolves.toBe(1001)
    await new Promise<void>(resolve => httpServer.close(() => { resolve() }))
  })

  it('kills the shells it was hosting', async () => {
    const { gateway, httpServer, url } = await ownGateway()
    const socket = new WebSocket(url)
    const pid = await new Promise<number>((resolve) => {
      socket.on('message', (raw: Buffer) => {
        const text = raw.toString('utf8')
        if (text.startsWith('{') && text.includes('"created"')) resolve((JSON.parse(text) as { pid: number }).pid)
      })
    })
    gateway.dispose()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(pid, 0)
      } catch {
        await new Promise<void>(resolve => httpServer.close(() => { resolve() }))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`pty ${String(pid)} survived the gateway`)
  })
})
