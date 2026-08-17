// @vitest-environment jsdom
/**
 * The surface itself: its dialog semantics, where focus lands, and the one
 * key that has to behave differently over the terminal.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay } from '../src/client/WorkbenchOverlay.tsx'
import { requestOpenFile, requestToggle } from '../src/client/workbench-events.ts'
import { resetArtifactCaches } from '../src/client/artifact-resolve.ts'

/** The overlay reads several framework props. */
type SessionsState = { current: string | undefined; byId: Record<string, { cwd?: string }> }
type StoreState = { open: boolean; docked: boolean; dockWidth: number; pendingTarget: unknown; linkPreviewPath: string | null; openBeforeLink: boolean }
const Overlay = WorkbenchOverlay as unknown as (props: {
  useStore: <S>(selector: (state: StoreState) => S) => S
  useSessions: <S>(selector: (state: SessionsState) => S) => S
  actions: {
    close: () => void; toggle: () => void; toggleDock: () => void; setDockWidth: (w: number) => void
    openFile: (t: unknown) => void; consumeTarget: () => void
    openLinkPreview: (t: unknown) => void; exitLinkPreview: () => void
  }
  t: (key: string) => string
}) => React.ReactElement | null

function show(open: boolean, docked = false, sessions: SessionsState = { current: undefined, byId: {} }) {
  const actions = {
    close: vi.fn(), toggle: vi.fn(), toggleDock: vi.fn(), setDockWidth: vi.fn(),
    openFile: vi.fn(), consumeTarget: vi.fn(), openLinkPreview: vi.fn(), exitLinkPreview: vi.fn(),
  }
  const result = render(
    <Overlay
      useStore={selector => selector({ open, docked, dockWidth: 460, pendingTarget: null, linkPreviewPath: null, openBeforeLink: false })}
      useSessions={selector => selector(sessions)}
      actions={actions}
      t={key => key}
    />,
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

describe('docked versus full-frame', () => {
  it('is a complementary region beside the conversation, not a dialog', () => {
    // Docked, the panel sits next to a still-usable conversation, so a dialog
    // role (which implies the rest is inert) would misdescribe it.
    show(true, true)
    expect(screen.queryByRole('dialog')).toBeNull()
    // The file list is itself an <aside>, so name the panel to single it out.
    expect(screen.getByRole('complementary', { name: 'title' })).toBeDefined()
  })

  it('is a dialog when full-frame', () => {
    show(true, false)
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('marks the panel so the dock stylesheet can position it', () => {
    const { container } = show(true, true)
    expect(container.querySelector('[data-workbench-panel]')).not.toBeNull()
  })

  it('offers a resize separator only while docked', () => {
    const { container } = show(true, true)
    expect(container.querySelector('[role="separator"]')).not.toBeNull()
    cleanup()
    const { container: full } = show(true, false)
    expect(full.querySelector('[role="separator"]')).toBeNull()
  })

  it('labels the toggle by the mode it switches to, and toggles on click', () => {
    const { actions } = show(true, true)
    fireEvent.click(screen.getByText('fullFrame')) // docked now, so offers full frame
    expect(actions.toggleDock).toHaveBeenCalledTimes(1)
  })

  it('offers to dock when full-frame', () => {
    show(true, false)
    expect(screen.getByText('dockRight')).toBeDefined()
  })

  it('resizes with the arrow keys on the separator', () => {
    const { actions } = show(true, true)
    const handle = screen.getByRole('separator')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(actions.setDockWidth).toHaveBeenLastCalledWith(460 + 16) // left widens
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(actions.setDockWidth).toHaveBeenLastCalledWith(460 - 16) // right narrows
  })
})

describe('intercepting conversation file links', () => {
  // The links being intercepted open through the HOST opener — the file opens
  // on the machine dsh runs on, useless from a remote browser. These tests pin
  // the interception: a path-shaped button in the conversation column opens the
  // panel preview instead, and everything else is left alone.
  let frame: HTMLDivElement
  let center: HTMLDivElement

  /** Files the fake host says exist. */
  let existing: Set<string>

  beforeEach(() => {
    resetArtifactCaches()
    existing = new Set(['report.html'])
    // The overlay finds the frame as the parent of [data-shell-overlay]; build
    // that scaffolding: [sidebar, conversation, details, overlay-layer].
    frame = document.createElement('div')
    frame.append(document.createElement('div'))
    center = document.createElement('div')
    frame.append(center)
    frame.append(document.createElement('div'))
    const layer = document.createElement('div')
    layer.setAttribute('data-shell-overlay', 'true')
    frame.append(layer)
    document.body.append(frame)

    vi.stubGlobal('fetch', vi.fn((input: string) => {
      const url = new URL(input, 'http://host')
      const json = (body: unknown, ok = true, status = 200): Response =>
        ({ ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }) as Response
      if (url.pathname.endsWith('/roots')) return Promise.resolve(json({ roots: [{ id: 'workspace', path: '/ws', label: 'ws' }] }))
      if (url.pathname.endsWith('/stat')) {
        const path = url.searchParams.get('path') ?? ''
        return existing.has(path)
          ? Promise.resolve(json({ type: 'file', size: 9, version: 'v1' }))
          : Promise.resolve(json({ code: 'not_found', error: 'no' }, false, 404))
      }
      return Promise.resolve(json({ ok: true, roots: [], entries: [], writeEnabled: false, ptyEnabled: true }))
    }))
  })

  afterEach(() => { frame.remove() })

  function chatButton(text: string, title?: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.textContent = text
    if (title !== undefined) button.title = title
    center.append(button)
    return button
  }

  it('opens the panel preview for a full-path mention', async () => {
    const { actions } = show(false)
    fireEvent.click(chatButton('/ws/report.html'))
    await waitFor(() => {
      expect(actions.openLinkPreview).toHaveBeenCalledWith(
        { root: 'workspace', path: 'report.html', name: 'report.html', absolute: '/ws/report.html' },
      )
    })
  })

  it('resolves a basename chip through its full-path title', async () => {
    const { actions } = show(false)
    fireEvent.click(chatButton('report.html', '/ws/report.html'))
    await waitFor(() => { expect(actions.openLinkPreview).toHaveBeenCalled() })
  })

  it('swallows the click so the host opener never fires', () => {
    show(false)
    const button = chatButton('/ws/report.html')
    const reactHandler = vi.fn()
    // Stands in for React's delegated handler: a bubble listener on the frame.
    frame.addEventListener('click', reactHandler)
    fireEvent.click(button)
    expect(reactHandler).not.toHaveBeenCalled()
    frame.removeEventListener('click', reactHandler)
  })

  it('leaves ordinary buttons alone', async () => {
    const { actions } = show(false)
    const button = chatButton('Copy')
    const reactHandler = vi.fn()
    frame.addEventListener('click', reactHandler)
    fireEvent.click(button)
    expect(reactHandler).toHaveBeenCalled() // not swallowed
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(actions.openLinkPreview).not.toHaveBeenCalled()
    frame.removeEventListener('click', reactHandler)
  })

  it('does not open anything for a path that is not a real file', async () => {
    const { actions } = show(false)
    fireEvent.click(chatButton('/ws/deleted.html'))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(actions.openLinkPreview).not.toHaveBeenCalled()
  })

  it('ignores clicks inside the workbench panel itself', async () => {
    const { actions } = show(false)
    const holder = document.createElement('div')
    holder.setAttribute('data-workbench-panel', '')
    const button = document.createElement('button')
    button.textContent = '/ws/report.html'
    holder.append(button)
    center.append(holder)
    fireEvent.click(button)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(actions.openLinkPreview).not.toHaveBeenCalled()
  })
})

describe('the event bridge from session-scoped seats', () => {
  it('toggles when a header launcher fires the toggle event', () => {
    // Even while closed, the overlay is mounted and listening.
    const { actions } = show(false)
    requestToggle()
    expect(actions.toggle).toHaveBeenCalledTimes(1)
  })

  it('opens a file when an artifact link fires the open-file event', () => {
    const { actions } = show(true)
    requestOpenFile({ root: 'workspace', path: 'report.html', name: 'report.html' })
    expect(actions.openFile).toHaveBeenCalledWith({ root: 'workspace', path: 'report.html', name: 'report.html' })
  })
})
