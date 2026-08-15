/** The terminal pane's rules, without a browser in the way. */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_STATE, parseFrame, retryDelay, RETRY_DELAYS, sessionClosed, sessionCreated,
  sessionExited, sessionSwitched, type TerminalState,
} from '../src/client/terminal-model.ts'

const withTabs = (...ids: string[]): TerminalState => ({
  tabs: ids.map(id => ({ id, shell: 'zsh', pid: 1, exited: false })),
  activeId: ids[0] ?? null,
})

describe('parseFrame', () => {
  it('treats anything not starting with { as output', () => {
    expect(parseFrame('hongbo@host % ')).toEqual({ kind: 'output', data: 'hongbo@host % ' })
  })

  it('parses a control frame', () => {
    expect(parseFrame('{"type":"created","id":"a"}')).toEqual({
      kind: 'control', message: { type: 'created', id: 'a' },
    })
  })

  it('treats a shell printing broken JSON as output, not as an error', () => {
    // A terminal is allowed to print anything; only well-formed control
    // objects are control.
    expect(parseFrame('{not json')).toEqual({ kind: 'output', data: '{not json' })
  })

  it('treats a JSON value without a type as output', () => {
    expect(parseFrame('{"a":1}')).toEqual({ kind: 'output', data: '{"a":1}' })
  })

  it('passes ANSI escapes through untouched', () => {
    const ansi = '[31mRED[0m'
    expect(parseFrame(ansi)).toEqual({ kind: 'output', data: ansi })
  })

  it('handles an empty frame', () => {
    expect(parseFrame('')).toEqual({ kind: 'output', data: '' })
  })
})

describe('retryDelay', () => {
  it('walks the backoff', () => {
    expect([0, 1, 2, 3, 4].map(retryDelay)).toEqual([...RETRY_DELAYS])
  })

  it('repeats the last step instead of growing forever', () => {
    expect(retryDelay(50)).toBe(RETRY_DELAYS[RETRY_DELAYS.length - 1])
  })

  it('is defensive about a negative attempt', () => {
    expect(retryDelay(-3)).toBe(RETRY_DELAYS[0])
  })
})

describe('sessionCreated', () => {
  it('appends and focuses', () => {
    const state = sessionCreated(EMPTY_STATE, { id: 'a', shell: 'bash', pid: 42 })
    expect(state).toEqual({ tabs: [{ id: 'a', shell: 'bash', pid: 42, exited: false }], activeId: 'a' })
  })

  it('focuses the newest of several', () => {
    const state = sessionCreated(sessionCreated(EMPTY_STATE, { id: 'a' }), { id: 'b' })
    expect(state.tabs.map(tab => tab.id)).toEqual(['a', 'b'])
    expect(state.activeId).toBe('b')
  })

  it('ignores a duplicate id, so a re-sent frame cannot double the tab', () => {
    const once = sessionCreated(EMPTY_STATE, { id: 'a' })
    expect(sessionCreated(once, { id: 'a' })).toBe(once)
  })

  it('defaults a missing shell and pid', () => {
    expect(sessionCreated(EMPTY_STATE, { id: 'a' }).tabs[0]).toMatchObject({ shell: 'shell', pid: 0 })
  })
})

describe('sessionExited', () => {
  it('marks the tab without removing it', () => {
    const state = sessionExited(withTabs('a', 'b'), 'a')
    expect(state.tabs[0]?.exited).toBe(true)
    expect(state.tabs).toHaveLength(2)
    expect(state.activeId).toBe('a')
  })

  it('ignores an unknown id', () => {
    const before = withTabs('a')
    expect(sessionExited(before, 'zzz')).toBe(before)
  })
})

describe('sessionClosed', () => {
  it('removes the tab', () => {
    expect(sessionClosed(withTabs('a', 'b'), 'b').tabs.map(tab => tab.id)).toEqual(['a'])
  })

  it('moves focus to the first survivor when the active tab goes', () => {
    const state = sessionClosed(withTabs('a', 'b'), 'a')
    expect(state.activeId).toBe('b')
  })

  it('leaves focus alone when another tab goes', () => {
    const state = sessionClosed({ ...withTabs('a', 'b'), activeId: 'b' }, 'a')
    expect(state.activeId).toBe('b')
  })

  it('ends at no active session when the last tab goes', () => {
    expect(sessionClosed(withTabs('a'), 'a')).toEqual({ tabs: [], activeId: null })
  })

  it('ignores an unknown id', () => {
    const before = withTabs('a')
    expect(sessionClosed(before, 'zzz')).toBe(before)
  })
})

describe('sessionSwitched', () => {
  it('focuses an existing tab', () => {
    expect(sessionSwitched(withTabs('a', 'b'), 'b').activeId).toBe('b')
  })

  it('refuses to focus a session that is not there', () => {
    const before = withTabs('a')
    expect(sessionSwitched(before, 'ghost')).toBe(before)
  })
})

describe('a dropped socket', () => {
  it('resets to nothing, because the server-side shells died with it', () => {
    expect(EMPTY_STATE).toEqual({ tabs: [], activeId: null })
  })
})
