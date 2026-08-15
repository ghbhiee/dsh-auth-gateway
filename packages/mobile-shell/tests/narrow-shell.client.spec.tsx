// @vitest-environment jsdom
/**
 * The narrow-viewport controls, against a stand-in for the shell's DOM.
 *
 * Two things here are the shell's actual contract and have already broken
 * once each: `data-sidebar-collapsed` is *absent* when the sidebar is open
 * (React drops a false-valued data prop), and narrow-ness comes from the
 * frame's measured box, not from a media-query event.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarrowShell, type NarrowShellProps } from '../src/client/NarrowShell.tsx'

/** The component only reads two of its framework props. */
const Shell = NarrowShell as unknown as (props: {
  toggleSidebar: () => void
  loadSettings: () => Promise<{ narrowMaxWidth: number; documentTitle: string }>
  t: (key: string) => string
}) => React.ReactElement | null

/** Default props; settings arrive the way the host would deliver them. */
const shellProps = (over: { toggleSidebar?: () => void; narrowMaxWidth?: number; documentTitle?: string } = {}) => ({
  toggleSidebar: over.toggleSidebar ?? vi.fn(),
  loadSettings: () => Promise.resolve({
    narrowMaxWidth: over.narrowMaxWidth ?? 1023,
    documentTitle: over.documentTitle ?? '',
  }),
  t: (key: string) => key,
})

let frame: HTMLDivElement
let width = 375

function buildFrame(): void {
  frame = document.createElement('div')
  frame.setAttribute('data-sidebar-collapsed', 'true')
  const sidebar = document.createElement('div')
  const overlay = document.createElement('div')
  overlay.setAttribute('data-shell-overlay', 'true')
  frame.append(sidebar, overlay)
  document.body.append(frame)
  Object.defineProperty(frame, 'clientWidth', { get: () => width, configurable: true })
}

function openDrawer(): void {
  // What the shell does when the sidebar opens: the attribute disappears.
  frame.removeAttribute('data-sidebar-collapsed')
}

beforeEach(() => {
  width = 375
  document.body.innerHTML = ''
  // A real page always has one; the title pin needs an element to observe.
  document.head.innerHTML = '<title>Session title</title>'
  // jsdom has no ResizeObserver; the component only needs it to fire once.
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* the initial measurement happens synchronously */ }
    disconnect(): void { /* nothing to release */ }
  })
  buildFrame()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('narrow detection', () => {
  it('shows the hamburger on a narrow frame', () => {
    render(<Shell {...shellProps()} />)
    expect(screen.getByRole('button')).toBeDefined()
  })

  it('renders nothing on a wide frame', () => {
    width = 1280
    const { container } = render(<Shell {...shellProps()} />)
    expect(container.innerHTML).toBe('')
  })

  it('treats a zero-width frame as "unknown", not as narrow', () => {
    // A hidden pane measures 0; flipping to narrow there stranded the
    // hamburger on desktop once already.
    width = 0
    const { container } = render(<Shell {...shellProps()} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('drawer state', () => {
  it('reports collapsed while the attribute says "true"', () => {
    render(<Shell {...shellProps()} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('reports open when the attribute is absent, not "false"', () => {
    openDrawer()
    render(<Shell {...shellProps()} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })

  it('shows a scrim once the shell opens the drawer', async () => {
    // Also covers the live path: the sidebar can be opened from inside itself,
    // so the component watches the attribute rather than owning the state.
    const { container } = render(<Shell {...shellProps()} />)
    expect(container.querySelectorAll('div').length).toBe(0)
    openDrawer()
    await waitFor(() => { expect(container.querySelectorAll('div').length).toBe(1) })
  })
})

describe('controls', () => {
  it('toggles from the hamburger', () => {
    const toggle = vi.fn()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    fireEvent.click(screen.getByRole('button'))
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('toggles from the scrim', () => {
    const toggle = vi.fn()
    openDrawer()
    const { container } = render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    const scrim = container.querySelector('div')
    expect(scrim).not.toBeNull()
    fireEvent.click(scrim as Element)
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})

describe('closing on navigation', () => {
  function addRow(expandable: boolean): HTMLElement {
    const row = document.createElement('div')
    row.setAttribute('role', 'treeitem')
    if (expandable) row.setAttribute('aria-expanded', 'false')
    frame.firstElementChild?.append(row)
    return row
  }

  it('closes after picking a leaf', () => {
    const toggle = vi.fn()
    openDrawer()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    fireEvent.click(addRow(false))
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('stays open when a group is expanded', () => {
    const toggle = vi.fn()
    openDrawer()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    fireEvent.click(addRow(true))
    expect(toggle).not.toHaveBeenCalled()
  })

  it('ignores row clicks while the drawer is closed', () => {
    const toggle = vi.fn()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    fireEvent.click(addRow(false))
    expect(toggle).not.toHaveBeenCalled()
  })
})

describe('swipe', () => {
  const swipe = (from: number, to: number, dy = 0): void => {
    fireEvent.touchStart(document, { touches: [{ clientX: from, clientY: 100 }] })
    fireEvent.touchEnd(document, { changedTouches: [{ clientX: to, clientY: 100 + dy }] })
  }

  it('opens on a swipe right while closed', () => {
    const toggle = vi.fn()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    swipe(20, 200)
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('does not re-open on a swipe right that is already open', () => {
    const toggle = vi.fn()
    openDrawer()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    swipe(20, 200)
    expect(toggle).not.toHaveBeenCalled()
  })

  it('closes on a swipe left while open', () => {
    const toggle = vi.fn()
    openDrawer()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    swipe(200, 20)
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('ignores a short drag', () => {
    const toggle = vi.fn()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    swipe(100, 130)
    expect(toggle).not.toHaveBeenCalled()
  })

  it('ignores a mostly-vertical drag, so scrolling does not move the drawer', () => {
    const toggle = vi.fn()
    render(<Shell {...shellProps({ toggleSidebar: toggle })} />)
    swipe(100, 180, 300)
    expect(toggle).not.toHaveBeenCalled()
  })
})

describe('props contract', () => {
  it('accepts the framework-composed prop shape', () => {
    const props: Pick<NarrowShellProps, 'toggleSidebar'> = { toggleSidebar: () => undefined }
    expect(typeof props.toggleSidebar).toBe('function')
  })
})

describe('settings from the host', () => {
  it('adopts a wider threshold once it arrives', async () => {
    // 1280 is wide under the built-in default; a deployment that wants the
    // drawer up to 1440 gets it without rebuilding the plugin. The value
    // arrives after the first render, which a closure variable would miss.
    width = 1280
    render(<Shell {...shellProps({ narrowMaxWidth: 1440 })} />)
    await waitFor(() => { expect(screen.getByRole('button')).toBeDefined() })
  })

  it('treats a frame above the configured threshold as wide', async () => {
    width = 900
    const { container } = render(<Shell {...shellProps({ narrowMaxWidth: 800 })} />)
    await waitFor(() => { expect(container.innerHTML).toBe('') })
  })

  it('pins the tab title from the template, expanding {host}', async () => {
    render(<Shell {...shellProps({ documentTitle: 'WB · {host}' })} />)
    await waitFor(() => { expect(document.title).toBe(`WB · ${window.location.hostname}`) })
  })

  it('leaves the title alone when the template is empty', async () => {
    document.title = 'Session title'
    render(<Shell {...shellProps({ documentTitle: '' })} />)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(document.title).toBe('Session title')
  })

  it('keeps working when the host cannot answer', async () => {
    width = 375
    const failing = { ...shellProps(), loadSettings: () => Promise.reject(new Error('offline')) }
    render(<Shell {...failing} />)
    await waitFor(() => { expect(screen.getByRole('button')).toBeDefined() })
  })
})
