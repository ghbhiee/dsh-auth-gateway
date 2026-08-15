/**
 * Narrow-viewport affordances: a hamburger, a scrim, swipe-to-open/close, and
 * "tapping a group keeps the drawer open".
 *
 * All of it lives in the shell overlay layer and drives the sidebar through
 * `ctx.layout.toggleSidebar()`. Nothing here patches the layout package; the
 * drawer geometry is a stylesheet keyed on the shell's own data attributes.
 */

import { useCallback, useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './NarrowShell.module.css'

/** Fallback width, used until the host answers and if it never does. */
export const NARROW_MAX_WIDTH = 1023

/** Minimum horizontal travel, and how much it must beat vertical travel by. */
const SWIPE_MIN_PX = 50
const SWIPE_AXIS_RATIO = 1.5

/** What the registration injects into the component. */
export interface NarrowShellInjected {
  /** Toggle the sidebar panel. */
  toggleSidebar: () => void
  /** Settings source; the component asks once on mount. */
  loadSettings: () => Promise<ShellSettings>
}

/** Settings the host publishes for this plugin. */
export interface ShellSettings {
  /** Frame width at or below which the drawer takes over. */
  narrowMaxWidth: number
  /** Tab title template; `{host}` expands, empty leaves the shell's own title. */
  documentTitle: string
}

/** Props the framework composes for this registration. */
export type NarrowShellProps =
  PropsRuntime<'shell.overlay'>
  & NarrowShellInjected
  & PropsLocale<'mobileShell'>

/** Find the AppFrame element: the parent of the overlay layer. */
function frameElement(): HTMLElement | null {
  const layer = document.querySelector('[data-shell-overlay]')
  return layer?.parentElement ?? null
}

/**
 * Whether the sidebar is showing.
 *
 * The shell writes `data-sidebar-collapsed` from a boolean prop, and React
 * omits the attribute entirely when it is false — so "open" is the absence of
 * the attribute, never the string "false".
 * @returns true when the drawer is open.
 */
function isDrawerOpen(): boolean {
  const frame = frameElement()
  return frame !== null && frame.dataset.sidebarCollapsed !== 'true'
}

/** Render the narrow-viewport controls; nothing at all on a wide viewport. */
export function NarrowShell({ toggleSidebar, loadSettings, t }: NarrowShellProps) {
  const [narrowMaxWidth, setNarrowMaxWidth] = useState(NARROW_MAX_WIDTH)
  const [titleTemplate, setTitleTemplate] = useState('')
  const [narrow, setNarrow] = useState(() => window.innerWidth <= NARROW_MAX_WIDTH)
  const [open, setOpen] = useState(false)

  // Settings live on the host because a client entry never sees its row's
  // config. State, not a closure variable: the value arrives after the first
  // render and React has to hear about it.
  useEffect(() => {
    let cancelled = false
    loadSettings().then((settings) => {
      if (cancelled) return
      setNarrowMaxWidth(settings.narrowMaxWidth)
      setTitleTemplate(settings.documentTitle)
    }).catch(() => { /* the fallbacks already work */ })
    return () => { cancelled = true }
  }, [loadSettings])

  // Mark the frame so the stylesheet can dress it as a drawer. The mark is the
  // measurement's only consumer, which keeps the threshold in one place.
  useEffect(() => {
    const frame = frameElement()
    if (frame === null) return
    if (narrow) frame.setAttribute('data-mobile-shell-narrow', '')
    else frame.removeAttribute('data-mobile-shell-narrow')
    return () => { frame.removeAttribute('data-mobile-shell-narrow') }
  }, [narrow])

  // Pin the tab title, if this deployment wants one.
  useEffect(() => {
    if (titleTemplate === '') return
    const titleElement = document.querySelector('title')
    if (titleElement === null) return
    const previous = document.title
    const pin = (): void => {
      const wanted = titleTemplate.replaceAll('{host}', window.location.hostname)
      if (document.title !== wanted) document.title = wanted
    }
    pin()
    const observer = new MutationObserver(pin)
    observer.observe(titleElement, { childList: true, characterData: true, subtree: true })
    return () => {
      observer.disconnect()
      document.title = previous
    }
  }, [titleTemplate])

  // Track the shell's own collapsed state rather than mirroring it: the user
  // can also collapse the sidebar from inside it.
  useEffect(() => {
    const frame = frameElement()
    if (frame === null) return
    const sync = (): void => { setOpen(isDrawerOpen()) }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
    return () => { observer.disconnect() }
  }, [narrow])

  // Measure the frame box rather than the window: that is the same input the
  // shell's own narrow decision uses, and a media-query listener can miss a
  // viewport change that never fires `change` (devtools emulation, pane
  // resizes), leaving the hamburger stranded on a wide layout.
  useEffect(() => {
    const frame = frameElement()
    if (frame === null) return
    const update = (): void => {
      const width = frame.clientWidth
      // A zero-width frame means the pane is hidden, not that the viewport is
      // narrow; keep whatever was decided when it last had a size.
      if (width === 0) return
      setNarrow(width <= narrowMaxWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(frame)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [narrowMaxWidth])

  // Direction-aware swipe: right opens, left closes. (The patch this replaces
  // toggled on either direction, so a left swipe on a closed drawer opened it.)
  useEffect(() => {
    if (!narrow) return
    let start: { x: number; y: number } | null = null
    const onStart = (event: TouchEvent): void => {
      const touch = event.touches[0]
      start = touch === undefined ? null : { x: touch.clientX, y: touch.clientY }
    }
    const onEnd = (event: TouchEvent): void => {
      const touch = event.changedTouches[0]
      if (start === null || touch === undefined) return
      const dx = touch.clientX - start.x
      const dy = touch.clientY - start.y
      start = null
      if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return
      const wantOpen = dx > 0
      if (wantOpen !== isDrawerOpen()) toggleSidebar()
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
    }
  }, [narrow, toggleSidebar])

  // Close the drawer when a leaf row is picked, but not when an expandable
  // group is toggled — a group has aria-expanded, a leaf does not.
  useEffect(() => {
    if (!narrow) return
    const onClick = (event: MouseEvent): void => {
      if (!isDrawerOpen()) return
      const target = event.target
      if (!(target instanceof Element)) return
      const row = target.closest('[role="treeitem"], [role="option"]')
      if (row === null || row.hasAttribute('aria-expanded')) return
      toggleSidebar()
    }
    document.addEventListener('click', onClick, true)
    return () => { document.removeEventListener('click', onClick, true) }
  }, [narrow, toggleSidebar])

  if (!narrow) return null

  return (
    <>
      <button
        type="button"
        className={css.hamburger}
        aria-label={open ? t('closeNav') : t('openNav')}
        aria-expanded={open}
        onClick={() => { toggleSidebar() }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open ? <div className={css.scrim} onClick={() => { toggleSidebar() }} /> : null}
    </>
  )
}
