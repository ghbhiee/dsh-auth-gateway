/**
 * CLI runner: one resume-capable agent turn, printed either as conversational
 * text or as a machine-readable envelope.
 *
 * This is the merge of two hand-copied profile runners that had drifted into
 * near-duplicates — `summarize`, session resolution, exit handling and the
 * whole drive loop were identical. What actually differed is now configuration:
 * the session tag, whether the session id is announced, and the output shape.
 *
 * @module dsh-plugin-cli-session
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type { CliStartupRequest } from './startup.ts'
import { loadHostModules } from './host-modules.ts'

/** Cordis plugin name. */
export const name = 'cli-runner'

/** Core services required before the turn can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'sessionPersistence']

/** Deployment-varying knobs. */
export interface Config {
  /** The parsed invocation, wired from `ctx.cliStartup`. */
  request: CliStartupRequest
  /** Value written to a session's `agentPreset`, which also scopes `--list`/`--resume`. */
  sessionTag: string
  /** Write `session: <id>` to stderr, so a conversational caller can resume it. */
  announceSessionId: boolean
  /** How long to wait for a graceful exit before forcing one. */
  exitGraceMs: number
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  request: z.object({
    action: z.string().default('new'),
    task: z.string().default(''),
    sessionId: z.string().default(''),
    outputFormat: z.string().default('text'),
    jsonSchema: z.string().default(''),
  }) as unknown as z<CliStartupRequest>,
  sessionTag: z.string().default('cli'),
  announceSessionId: z.boolean().default(false),
  exitGraceMs: z.number().default(1500),
})

interface Io {
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  exit: (code: number) => void
  graceMs: number
}

interface SessionHeaderLike {
  id: string
  cwd?: string
  createdAt: number
  agentPreset?: string
}

interface TurnReason {
  kind?: string
  error?: { code?: string; message?: string }
}

/** Last assistant text plus the turn outcome, over one owned interval. */
export function summarize(events: readonly { seq: number; type: string; data?: unknown }[], firstSeq: number): { text: string; reason: TurnReason | undefined } {
  let started = false
  let text = ''
  let reason: TurnReason | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') { started = true; continue }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const data = event.data as { message?: { content?: { type: string; text?: string }[] } }
      const joined = (data.message?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = (event.data as { reason?: TurnReason }).reason
  }
  return { text, reason }
}

/** The latest provider-reported usage in this run, when present. */
export function collectUsage(events: readonly { seq: number; type: string; data?: unknown }[], firstSeq: number): unknown {
  let usage: unknown
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'assistant/message') continue
    const candidate = (event.data as { usage?: unknown }).usage
    if (candidate !== undefined) usage = candidate
  }
  return usage
}

/** Turns started in this run. */
export function countTurns(events: readonly { seq: number; type: string }[], firstSeq: number): number {
  let count = 0
  for (const event of events) {
    if (event.seq >= firstSeq && event.type === 'turn/start') count += 1
  }
  return count
}

export function sessionsInCwd(headers: readonly SessionHeaderLike[], cwd: string, tag: string): SessionHeaderLike[] {
  return headers
    .filter(header => header.cwd === cwd && header.agentPreset === tag)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function normalizeSessionId(id: string): string {
  return id.startsWith('session-') ? id : `session-${id}`
}

/** Ask for a graceful shutdown, with a hard fallback so a one-shot CLI always exits. */
function exitNow(io: Io, code: number): void {
  io.exit(code)
  setTimeout(() => { process.exit(code) }, io.graceMs)
}

function fail(io: Io, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  exitNow(io, 1)
}

/**
 * Reject a configuration that cannot do anything sensible.
 *
 * The row's `request` comes from `!!js ctx.cliStartup`; wire it wrong and the
 * schema's defaults quietly produce `action: 'new'` with an empty task, which
 * would create a session and spend a model call on nothing. A blank session tag
 * is just as bad: it is the label `--list` and `--resume` scope by.
 * @param config - the row's resolved configuration.
 * @throws when the configuration cannot be run.
 */
export function assertRunnable(config: Config): void {
  if (config.sessionTag.trim() === '') {
    throw new Error('cli-runner: sessionTag must not be empty; it is the label --list and --resume scope by')
  }
  if (!Number.isFinite(config.exitGraceMs) || config.exitGraceMs < 0) {
    throw new Error(`cli-runner: exitGraceMs must be a non-negative number, got ${String(config.exitGraceMs)}`)
  }
  if (config.request.action !== 'list' && config.request.task.trim() === '') {
    throw new Error(
      'cli-runner: no task to run. The row\'s config.request should be wired to the startup service, '
      + 'as in `request: !!js ctx.cliStartup`.',
    )
  }
}

/**
 * Compose the task text.
 *
 * `--json-schema` is a prompt-level request, not a provider structured-output
 * constraint: the schema is appended as an instruction, so a model can still
 * answer with fenced or prose-wrapped JSON. Callers must parse defensively.
 * @param request - the parsed invocation.
 * @returns the text to send as the user turn.
 */
export function buildTask(request: CliStartupRequest): string {
  if (request.jsonSchema === '') return request.task
  return `${request.task}\n\nRespond with a single valid JSON object that conforms EXACTLY to this JSON Schema. `
    + `Output ONLY the JSON itself — no markdown code fences, no commentary, no surrounding text:\n${request.jsonSchema}`
}

async function run(ctx: Context, config: Config, io: Io): Promise<void> {
  const request = config.request
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const defaultModel = ctx.get('agentDefaultModel')
  if (agents === undefined || sessions === undefined || persistence === undefined || defaultModel === undefined) return

  const cwd = process.cwd()

  if (request.action === 'list') {
    const mine = sessionsInCwd(await persistence.list() as SessionHeaderLike[], cwd, config.sessionTag)
    if (request.outputFormat === 'text') {
      if (mine.length === 0) io.stdout.write(`(no ${config.sessionTag} sessions for ${cwd})\n`)
      else for (const header of mine) io.stdout.write(`${header.id}\t${new Date(header.createdAt).toISOString()}\t${header.cwd ?? ''}\n`)
    } else {
      io.stdout.write(`${JSON.stringify({
        sessions: mine.map(header => ({ id: header.id, created_at: new Date(header.createdAt).toISOString(), cwd: header.cwd ?? '' })),
      })}\n`)
    }
    exitNow(io, 0)
    return
  }

  const { installModelSelection, createUserMessage, SessionId } = await loadHostModules(ctx.baseUrl)
  const startTime = Date.now()
  const selection = defaultModel.currentSelection()
  const setup = (agentCtx: Context): void => { installModelSelection(agentCtx, { current: selection, assembled: undefined }) }
  const agentOptions = { provider: selection.provider, model: selection.model }

  let handle
  let sessionId: string
  if (request.action === 'new') {
    sessionId = `session-${randomUUID()}`
    handle = await agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd, agentPreset: config.sessionTag },
      agentOptions,
      setup,
    })
  } else {
    const resolved = request.action === 'resume-session'
      ? normalizeSessionId(request.sessionId)
      : sessionsInCwd(await persistence.list() as SessionHeaderLike[], cwd, config.sessionTag)[0]?.id
    if (resolved === undefined) {
      io.stderr.write(`dsh: no ${config.sessionTag} session to resume in ${cwd}\n`)
      exitNow(io, 1)
      return
    }
    sessionId = resolved
    handle = await agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup })
  }

  const { agent } = handle
  if (config.announceSessionId) io.stderr.write(`session: ${sessionId}\n`)
  await agent.whenIdle()
  const firstSeq = agent.session.seq

  if (request.outputFormat === 'stream-json') {
    io.stdout.write(`${JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      cwd,
      provider: selection.provider,
      model: selection.model,
    })}\n`)
  }

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: buildTask(request) }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  await sessions.flush(agent.session)

  const events = agent.session.events as readonly { seq: number; type: string; data?: unknown }[]
  const outcome = summarize(events, firstSeq)
  const usage = collectUsage(events, firstSeq)
  const isError = outcome.reason?.kind !== 'completed'

  if (request.outputFormat === 'text') {
    io.stdout.write(`${outcome.text}\n`)
  } else {
    const result: Record<string, unknown> = {
      type: 'result',
      subtype: isError ? 'error' : 'success',
      is_error: isError,
      duration_ms: Date.now() - startTime,
      num_turns: countTurns(events, firstSeq),
      result: isError ? (outcome.reason?.error?.message ?? '') : outcome.text,
      session_id: sessionId,
    }
    if (usage !== undefined) result.usage = usage
    io.stdout.write(`${JSON.stringify(result)}\n`)
  }

  if (isError) {
    const error = outcome.reason?.error
    io.stderr.write(`dsh: ${error?.code ?? 'error'}: ${error?.message ?? ''}\n`)
  }
  exitNow(io, isError ? 1 : 0)
}

/** Drive one turn and exit. */
export function apply(ctx: Context, config: Config): void {
  assertRunnable(config)
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('cli-runner: the launcher must provide ctx.appExit before the tree mounts')
  const io: Io = { stdout: process.stdout, stderr: process.stderr, exit, graceMs: config.exitGraceMs }
  run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
