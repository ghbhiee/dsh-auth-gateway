/** What the runner refuses to start with. */

import { describe, expect, it } from 'vitest'
import { assertRunnable, type Config } from '../src/index.ts'
import type { CliStartupRequest } from '../src/startup.ts'

const request = (over: Partial<CliStartupRequest> = {}): CliStartupRequest => ({
  action: 'new', task: 'do the thing', sessionId: '', outputFormat: 'text', jsonSchema: '', ...over,
})

const config = (over: Partial<Config> = {}): Config => ({
  request: request(), sessionTag: 'chat-cli', announceSessionId: false, exitGraceMs: 1500, ...over,
})

describe('assertRunnable', () => {
  it('accepts a wired-up row', () => {
    expect(() => { assertRunnable(config()) }).not.toThrow()
  })

  it('refuses an empty task, which is what an unwired request looks like', () => {
    // Schemastery defaults fill request with action:'new', task:'' — running
    // that would open a session and spend a model call on nothing.
    expect(() => { assertRunnable(config({ request: request({ task: '' }) })) })
      .toThrowError(/ctx\.cliStartup/)
  })

  it('refuses a whitespace-only task for the same reason', () => {
    expect(() => { assertRunnable(config({ request: request({ task: '   ' }) })) }).toThrow()
  })

  it('allows --list without a task', () => {
    expect(() => { assertRunnable(config({ request: request({ action: 'list', task: '' }) })) }).not.toThrow()
  })

  it('refuses a blank session tag, since scoping depends on it', () => {
    expect(() => { assertRunnable(config({ sessionTag: '  ' })) }).toThrowError(/sessionTag/)
  })

  it('refuses a negative exit grace', () => {
    expect(() => { assertRunnable(config({ exitGraceMs: -1 })) }).toThrowError(/non-negative/)
  })

  it('allows an immediate exit grace', () => {
    expect(() => { assertRunnable(config({ exitGraceMs: 0 })) }).not.toThrow()
  })

  it('refuses a nonsense exit grace', () => {
    expect(() => { assertRunnable(config({ exitGraceMs: Number.NaN })) }).toThrow()
  })
})
