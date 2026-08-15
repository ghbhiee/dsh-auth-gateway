// @vitest-environment jsdom
/**
 * The surface itself: its dialog semantics, where focus lands, and the one
 * key that has to behave differently over the terminal.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay } from '../src/client/WorkbenchOverlay.tsx'

/** The overlay reads three of its framework props. */
const Overlay = WorkbenchOverlay as unknown as (props: {
  useStore: (selector: (state: { open: boolean }) => boolean) => boolean
  actions: { close: () => void; toggle: () => void }
  t: (key: string) => string
}) => React.ReactElement | null

function show(open: boolean) {
  const actions = { close: vi.fn(), toggle: vi.fn() }
  const result = render(
    <Overlay useStore={selector => selector({ open })} actions={actions} t={key => key} />,
  )
  return { actions, ...result }
}

beforeEach(() => {
  // xterm probes a canvas for colour metrics on construction; jsdom has none,
  // and the pane does not need one to answer the questions asked here.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* measured once at mount */ }
    disconnect(): void { /* nothing to release */ }
  })
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true, json: () => Promise.resolve({ roots: [], entries: [], writeEnabled: false, ptyEnabled: true }),
    text: () => Promise.resolve('{}'),
  } as Response)))
})

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('when closed', () => {
  it('renders nothing at all', () => {
    const { container } = show(false)
    expect(container.innerHTML).toBe('')
  })
})

describe('dialog semantics', () => {
  it('is a labelled dialog', () => {
    show(true)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-label')).toBe('title')
  })

  it('takes focus when it opens, so the keyboard follows the surface', async () => {
    show(true)
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('dialog')) })
  })
})

describe('escape', () => {
  it('closes the surface', () => {
    const { actions } = show(true)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(actions.close).toHaveBeenCalledTimes(1)
  })

  it('is left to the shell when it comes from the terminal', () => {
    const { actions, container } = show(true)
    const terminalPane = container.querySelector('[data-workbench-terminal]')
    expect(terminalPane).not.toBeNull()
    fireEvent.keyDown(terminalPane as Element, { key: 'Escape' })
    expect(actions.close).not.toHaveBeenCalled()
  })

  it('ignores other keys', () => {
    const { actions } = show(true)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'q' })
    expect(actions.close).not.toHaveBeenCalled()
  })
})

describe('tabs', () => {
  it('starts on files and keeps the terminal mounted but hidden', () => {
    const { container } = show(true)
    const panes = container.querySelectorAll('[class*="pane"]')
    // Both panes exist; only one is visible, so the terminal survives a
    // detour through the files tab.
    expect(panes.length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('[data-workbench-terminal]')?.className).toContain('Hidden')
  })

  it('switches to the terminal', () => {
    const { container } = show(true)
    fireEvent.click(screen.getByText('tabTerminal'))
    expect(container.querySelector('[data-workbench-terminal]')?.className).not.toContain('Hidden')
  })

  it('closes from the close button', () => {
    const { actions } = show(true)
    fireEvent.click(screen.getByText('close'))
    expect(actions.close).toHaveBeenCalledTimes(1)
  })

  it('exposes the tabs as a WAI-ARIA tablist, not just styled buttons', () => {
    const { container } = show(true)
    const tablist = container.querySelector('[role="tablist"]')
    expect(tablist).not.toBeNull()
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect(tabs).toHaveLength(2)
    // The selected tab is the only one in the tab order (roving tabindex) and
    // announces its state; each points at the panel it controls.
    const files = tabs.find(t => t.getAttribute('aria-controls') === 'wb-panel-files')
    const term = tabs.find(t => t.getAttribute('aria-controls') === 'wb-panel-terminal')
    expect(files?.getAttribute('aria-selected')).toBe('true')
    expect(files?.getAttribute('tabindex')).toBe('0')
    expect(term?.getAttribute('aria-selected')).toBe('false')
    expect(term?.getAttribute('tabindex')).toBe('-1')
    // Each panel is labelled by its tab.
    expect(container.querySelector('#wb-panel-files')?.getAttribute('role')).toBe('tabpanel')
    expect(container.querySelector('#wb-panel-terminal')?.getAttribute('aria-labelledby')).toBe('wb-tab-terminal')
  })

  it('moves between tabs with the arrow keys', () => {
    const { container } = show(true)
    const tablist = container.querySelector('[role="tablist"]') as Element
    fireEvent.keyDown(tablist, { key: 'ArrowRight' })
    expect(container.querySelector('[data-workbench-terminal]')?.className).not.toContain('Hidden')
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' })
    expect(container.querySelector('[data-workbench-terminal]')?.className).toContain('Hidden')
  })
})
