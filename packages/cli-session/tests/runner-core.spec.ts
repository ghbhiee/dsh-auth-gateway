/** The runner's pure core: what it reports, and which sessions it can see. */

import { describe, expect, it } from 'vitest'
import { buildTask, collectUsage, countTurns, normalizeSessionId, sessionsInCwd, summarize } from '../src/index.ts'
import type { CliStartupRequest } from '../src/startup.ts'

const assistant = (seq: number, text: string, usage?: unknown) => ({
  seq,
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] }, ...(usage === undefined ? {} : { usage }) },
})

describe('summarize', () => {
  const events = [
    assistant(1, 'from a previous run'),
    { seq: 2, type: 'turn/start' },
    assistant(3, 'first'),
    assistant(4, 'final answer'),
    { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]

  it('returns the last assistant text of this run only', () => {
    expect(summarize(events, 2)).toEqual({ text: 'final answer', reason: { kind: 'completed' } })
  })

  it('ignores events before the run started', () => {
    expect(summarize([assistant(1, 'old')], 2).text).toBe('')
  })

  it('ignores assistant messages that arrive before turn/start', () => {
    expect(summarize([assistant(3, 'stray'), { seq: 4, type: 'turn/start' }], 1).text).toBe('')
  })

  it('keeps the previous text when a later message is empty', () => {
    const withEmpty = [{ seq: 1, type: 'turn/start' }, assistant(2, 'kept'), assistant(3, '')]
    expect(summarize(withEmpty, 1).text).toBe('kept')
  })

  it('reports a failure reason', () => {
    const failed = [
      { seq: 1, type: 'turn/start' },
      { seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'nope' } } } },
    ]
    expect(summarize(failed, 1).reason).toMatchObject({ kind: 'error', error: { code: 'AUTH' } })
  })
})

describe('collectUsage', () => {
  it('takes the newest usage in the interval', () => {
    const events = [assistant(1, 'a', { inputTokens: 1 }), assistant(2, 'b', { inputTokens: 9 })]
    expect(collectUsage(events, 1)).toEqual({ inputTokens: 9 })
  })

  it('is undefined when no message carried usage', () => {
    expect(collectUsage([assistant(1, 'a')], 1)).toBeUndefined()
  })
})

describe('countTurns', () => {
  it('counts only turns inside the interval', () => {
    const events = [{ seq: 1, type: 'turn/start' }, { seq: 5, type: 'turn/start' }, { seq: 6, type: 'turn/start' }]
    expect(countTurns(events, 5)).toBe(2)
  })
})

describe('sessionsInCwd', () => {
  const headers = [
    { id: 'a', cwd: '/work', createdAt: 100, agentPreset: 'chat-cli' },
    { id: 'b', cwd: '/work', createdAt: 300, agentPreset: 'chat-cli' },
    { id: 'c', cwd: '/work', createdAt: 200, agentPreset: 'api' },
    { id: 'd', cwd: '/other', createdAt: 400, agentPreset: 'chat-cli' },
    { id: 'e', cwd: '/work', createdAt: 500 },
  ]

  it('keeps only this tag in this directory, newest first', () => {
    expect(sessionsInCwd(headers, '/work', 'chat-cli').map(h => h.id)).toEqual(['b', 'a'])
  })

  it('isolates the two flavours from each other', () => {
    expect(sessionsInCwd(headers, '/work', 'api').map(h => h.id)).toEqual(['c'])
  })

  it('ignores untagged sessions, so GUI sessions never leak in', () => {
    expect(sessionsInCwd(headers, '/work', 'chat-cli').some(h => h.id === 'e')).toBe(false)
  })
})

describe('normalizeSessionId', () => {
  it('adds the prefix when the user omits it', () => {
    expect(normalizeSessionId('abc')).toBe('session-abc')
  })

  it('leaves a prefixed id alone', () => {
    expect(normalizeSessionId('session-abc')).toBe('session-abc')
  })
})

describe('buildTask', () => {
  const request = (jsonSchema: string): CliStartupRequest => ({
    action: 'new', task: 'do it', sessionId: '', outputFormat: 'json', jsonSchema,
  })

  it('passes the task through when no schema is asked for', () => {
    expect(buildTask(request(''))).toBe('do it')
  })

  it('appends the schema as an instruction — it is a prompt, not a constraint', () => {
    const composed = buildTask(request('{"type":"object"}'))
    expect(composed.startsWith('do it')).toBe(true)
    expect(composed).toContain('{"type":"object"}')
    expect(composed).toContain('no markdown code fences')
  })
})
