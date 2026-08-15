// @vitest-environment jsdom
/**
 * The terminal pane's dialing decision: with terminals switched off there is
 * no upgrade route, and retrying it forever reports a disabled feature as a
 * broken one.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPane, type TerminalPaneLabels } from '../src/client/TerminalPane.tsx'

const labels: TerminalPaneLabels = {
  connecting: 'Connecting…', newTab: 'New', closeTab: 'Close', exited: 'Exited',
  disconnected: 'Disconnected', reconnect: 'Reconnect', disabled: 'Terminals are off here',
}

let opened: string[]

function stub(ptyEnabled: boolean): void {
  opened = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* measured once */ }
    disconnect(): void { /* nothing to release */ }
  })
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true, writeEnabled: false, ptyEnabled }),
    text: () => Promise.resolve('{}'),
  } as Response)))
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1
    readyState = 0
    onopen: (() => void) | null = null
    onclose: (() => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    constructor(url: string) { opened.push(url) }
    send(): void { /* nothing to deliver in this test */ }
    close(): void { /* nothing to tear down */ }
  })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('when terminals are switched off', () => {
  beforeEach(() => { stub(false) })

  it('says so instead of pretending the connection dropped', async () => {
    render(<TerminalPane active labels={labels} />)
    await waitFor(() => { expect(screen.getByText('Terminals are off here')).toBeDefined() })
    expect(screen.queryByText('Disconnected')).toBeNull()
  })

  it('never dials the gateway', async () => {
    render(<TerminalPane active labels={labels} />)
    await waitFor(() => { expect(screen.getByText('Terminals are off here')).toBeDefined() })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(opened).toEqual([])
  })
})

describe('when terminals are available', () => {
  beforeEach(() => { stub(true) })

  it('dials once and waits', async () => {
    render(<TerminalPane active labels={labels} />)
    await waitFor(() => { expect(opened).toHaveLength(1) })
    expect(opened[0]).toContain('/plugins/workbench/pty')
    expect(screen.queryByText('Terminals are off here')).toBeNull()
  })
})
