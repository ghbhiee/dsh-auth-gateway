/**
 * The command-line contract: what each invocation publishes as `cliStartup`,
 * and which combinations are rejected before anything is published.
 */

import { existsSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type CliStartupRequest } from '../src/startup.ts'

interface Run {
  /** The request published to the tree, when the invocation was accepted. */
  provided: CliStartupRequest | undefined
  /** Exit codes commander asked for; a rejected invocation exits non-zero. */
  exits: number[]
}

/** Drive `apply` with an argv, the way the launcher would. */
function runCli(argv: string[]): Run {
  const run: Run = { provided: undefined, exits: [] }
  const services: Record<string, unknown> = {
    cmdlineArgs: { get: () => argv },
    appExit: (code: number) => { run.exits.push(code) },
  }
  const ctx = {
    get: (key: string) => services[key],
    provide: (key: string, value: unknown) => {
      if (key === 'cliStartup') run.provided = value as CliStartupRequest
    },
  } as unknown as Context
  apply(ctx)
  return run
}

let cwd: string

beforeEach(() => {
  cwd = process.cwd()
  // commander writes usage and errors straight to the process streams.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  process.chdir(cwd)
  vi.restoreAllMocks()
})

describe('accepted invocations', () => {
  it('starts a new session by default', () => {
    const { provided, exits } = runCli(['explain this file'])
    expect(exits).toEqual([])
    expect(provided).toMatchObject({ action: 'new', task: 'explain this file', outputFormat: 'text' })
  })

  it('joins a multi-word task', () => {
    expect(runCli(['explain', 'this', 'file']).provided?.task).toBe('explain this file')
  })

  it('carries the output format', () => {
    expect(runCli(['-o', 'json', 'x']).provided?.outputFormat).toBe('json')
    expect(runCli(['-o', 'stream-json', 'x']).provided?.outputFormat).toBe('stream-json')
  })

  it('carries a json schema', () => {
    expect(runCli(['--json-schema', '{"type":"object"}', 'x']).provided?.jsonSchema).toBe('{"type":"object"}')
  })

  it('resumes the newest session', () => {
    expect(runCli(['-r', 'follow up']).provided).toMatchObject({ action: 'resume-last', sessionId: '' })
  })

  it('resumes a named session', () => {
    expect(runCli(['-s', 'abc', 'follow up']).provided).toMatchObject({ action: 'resume-session', sessionId: 'abc' })
  })

  it('publishes a fully-populated request for --list', () => {
    // The chat variant used to omit sessionId here, leaving the runner's schema
    // to paper over it.
    expect(runCli(['-l']).provided).toEqual({
      action: 'list', task: '', sessionId: '', outputFormat: 'text', jsonSchema: '',
    })
  })

  it('honours --output-format alongside --list', () => {
    expect(runCli(['-l', '-o', 'json']).provided?.outputFormat).toBe('json')
  })
})

describe('rejected invocations', () => {
  const rejects = (argv: string[]): Run => {
    const run = runCli(argv)
    expect(run.provided).toBeUndefined()
    expect(run.exits.some(code => code !== 0)).toBe(true)
    return run
  }

  it('needs a task', () => { rejects([]) })
  it('rejects an unknown output format', () => { rejects(['-o', 'bogus', 'x']) })
  it('rejects --session with --resume', () => { rejects(['-s', 'abc', '-r', 'x']) })
  it('rejects --new with --resume', () => { rejects(['-n', '-r', 'x']) })
  it('rejects --new with --session', () => { rejects(['-n', '-s', 'abc', 'x']) })
  it('rejects --workdir on a resumed session', () => { rejects(['-w', '/tmp', '-r', 'x']) })
  it('rejects --workdir with --session', () => { rejects(['-w', '/tmp', '-s', 'abc', 'x']) })
})

describe('--workdir', () => {
  const target = join(tmpdir(), `wb-cli-${String(process.pid)}`, 'nested')

  afterEach(() => { rmSync(join(target, '..'), { recursive: true, force: true }) })

  it('creates the directory and chdirs before publishing', () => {
    const { provided } = runCli(['-w', target, 'do it'])
    expect(existsSync(target)).toBe(true)
    // The sandbox root is resolved from process.cwd() by a row that waits on
    // this service, so the chdir has to happen before the publish.
    expect(process.cwd()).toBe(realpathSync(target))
    expect(provided).toMatchObject({ action: 'new', task: 'do it' })
  })
})
