/** Full-frame workbench surface, seated in the shell overlay layer. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Brings the runtime's GlobalStandardProps (useSessions) into PropsRuntime for a
// root-scoped slot; type-only, so it adds nothing to the bundle.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { workbenchStore } from './store.ts'
import { clampDockWidth } from './dock-width.ts'
import { onWorkbenchRequests } from './workbench-events.ts'
import { FileBrowser } from './FileBrowser.tsx'
import { TerminalPane } from './TerminalPane.tsx'
import css from './WorkbenchOverlay.module.css'
import './workbench-dock.css'

/** Props the framework composes for the overlay registration. */
export type WorkbenchOverlayProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<typeof workbenchStore>
  & PropsLocale<'workbench'>

type Tab = 'files' | 'terminal'

/**
 * The AppFrame element, i.e. the parent of the overlay layer.
 *
 * The layout package gives it no id or stable class, but the overlay layer it
 * contains carries `data-shell-overlay` — a documented, stable hook — so the
 * frame is reachable as that layer's parent. Same anchor mobile-shell uses.
 * @returns the frame element, or null before the shell has mounted.
 */
function frameElement(): HTMLElement | null {
  const layer = document.querySelector('[data-shell-overlay]')
  return layer?.parentElement ?? null
}

/** How much an arrow-key press resizes the dock, in px. */
const RESIZE_STEP = 16

/** Render the workbench panel while the shared store says it is open. */
export function WorkbenchOverlay({ useStore, useSessions, actions, t }: WorkbenchOverlayProps) {
  const open = useStore(state => state.open)
  const docked = useStore(state => state.docked)
  const dockWidth = useStore(state => state.dockWidth)
  // A file an artifact link asked to preview; it lands the surface on the Files
  // tab and hands the request to the browser, which clears it once navigated.
  const pendingTarget = useStore(state => state.pendingTarget)
  // The directory of the session currently in view. It drives both the file
  // tree's root and where new terminals open, and re-renders this surface when
  // the user switches sessions. Transiently undefined before the host fills it.
  const sessionCwd = useSessions(state => (state.current !== undefined ? state.byId[state.current]?.cwd : undefined))
  const [tab, setTab] = useState<Tab>('files')
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Dress the frame as a right-hand dock while open and docked: mark it so the
  // stylesheet reserves the strip and reflows the conversation, and publish the
  // width as a custom property both the reserved strip and the panel read.
  // Everything is torn down on close, on switching to full-frame, and on unmount.
  useEffect(() => {
    const frame = frameElement()
    if (frame === null) return
    if (open && docked) {
      frame.style.setProperty('--wb-dock-width', `${dockWidth}px`)
      frame.setAttribute('data-workbench-docked', '')
    } else {
      frame.removeAttribute('data-workbench-docked')
      frame.style.removeProperty('--wb-dock-width')
    }
    return () => {
      frame.removeAttribute('data-workbench-docked')
      frame.style.removeProperty('--wb-dock-width')
    }
  }, [open, docked, dockWidth])

  // Drag the panel's left edge to resize. The width is written live to the frame
  // property (so both the reserved strip and the panel follow the pointer) and
  // committed to the store on release, where it is clamped and persists.
  const onResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault()
    const frame = frameElement()
    if (frame === null) return
    const frameRight = frame.getBoundingClientRect().right
    const onMove = (move: PointerEvent): void => {
      frame.style.setProperty('--wb-dock-width', `${clampDockWidth(frameRight - move.clientX)}px`)
    }
    const onUp = (up: PointerEvent): void => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      actions.setDockWidth(frameRight - up.clientX)
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }, [actions])

  // Keyboard resize for the same handle: left widens the dock, right narrows it.
  const onResizeKey = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); actions.setDockWidth(dockWidth + RESIZE_STEP) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); actions.setDockWidth(dockWidth - RESIZE_STEP) }
  }, [actions, dockWidth])

  // A preview request arrives on the Files tab; make sure it is the one showing.
  useEffect(() => {
    if (pendingTarget !== null) setTab('files')
  }, [pendingTarget])

  const consumeTarget = useCallback(() => { actions.consumeTarget() }, [actions])

  // Listen for the session-scoped seats (header launcher, artifact links), which
  // cannot bind this root store and so drive it through the window-event bridge.
  // The overlay is always mounted (it renders null while closed), so this is the
  // right place to hold the subscription.
  useEffect(() => onWorkbenchRequests({
    toggle: () => { actions.toggle() },
    openFile: (detail) => { actions.openFile(detail) },
  }), [actions])

  // Escape closes the surface, except from inside the terminal: there it is a
  // keystroke the shell owns (vim, less, readline all use it).
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    const target = event.target
    if (target instanceof Element && target.closest('[data-workbench-terminal]') !== null) return
    event.stopPropagation()
    actions.close()
  }, [actions])

  // Move focus into the surface when it opens full-frame, so keyboard and
  // screen-reader users are not left behind on the page underneath. A docked
  // panel sits beside the conversation rather than over it, so it does not grab
  // focus away from whatever the user was doing there.
  useEffect(() => {
    if (open && !docked) panelRef.current?.focus()
  }, [open, docked])

  // Arrow keys move between tabs, the way a screen-reader user expects of a
  // tablist; the roving tabindex keeps the group a single Tab stop.
  const onTabsKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next: Tab = tab === 'files' ? 'terminal' : 'files'
    setTab(next)
    const id = next === 'files' ? 'wb-tab-files' : 'wb-tab-terminal'
    document.getElementById(id)?.focus()
  }, [tab])

  if (!open) return null

  return (
    <div
      className={css.panel}
      ref={panelRef}
      // A full-frame panel is modal-ish and owns the frame; a docked one sits
      // beside a still-usable conversation, which is a complementary region, not
      // a dialog. The role follows the mode so assistive tech frames it right.
      role={docked ? 'complementary' : 'dialog'}
      aria-label={t('title')}
      data-workbench-panel
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {docked ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('resize')}
          tabIndex={0}
          className={css.resizeHandle}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
        />
      ) : null}
      <div className={css.header}>
        <span className={css.title}>{t('title')}</span>
        <div className={css.tabs} role="tablist" aria-label={t('title')} onKeyDown={onTabsKeyDown}>
          <button
            type="button"
            id="wb-tab-files"
            role="tab"
            aria-selected={tab === 'files'}
            aria-controls="wb-panel-files"
            tabIndex={tab === 'files' ? 0 : -1}
            className={tab === 'files' ? `${css.tab} ${css.tabActive}` : css.tab}
            onClick={() => { setTab('files') }}
          >
            {t('tabFiles')}
          </button>
          <button
            type="button"
            id="wb-tab-terminal"
            role="tab"
            aria-selected={tab === 'terminal'}
            aria-controls="wb-panel-terminal"
            tabIndex={tab === 'terminal' ? 0 : -1}
            className={tab === 'terminal' ? `${css.tab} ${css.tabActive}` : css.tab}
            onClick={() => { setTab('terminal') }}
          >
            {t('tabTerminal')}
          </button>
        </div>
        <button
          type="button"
          className={css.dockToggle}
          aria-pressed={docked}
          onClick={() => { actions.toggleDock() }}
        >
          {docked ? t('fullFrame') : t('dockRight')}
        </button>
        <button type="button" className={css.close} onClick={() => { actions.close() }}>
          {t('close')}
        </button>
      </div>
      <div className={css.body}>
        {/* Hiding stays with the existing `visibility: hidden` class, not the
            `hidden` attribute. The terminal is kept mounted and pre-sized while
            inactive; `visibility: hidden` preserves that laid-out box for its
            FitAddon, whereas `display: none` would collapse it. visibility:hidden
            also drops the inactive panel from the a11y tree, so `hidden` would
            add nothing for screen readers — the tabpanel roles carry that. */}
        <div
          className={tab === 'files' ? css.pane : css.paneHidden}
          id="wb-panel-files"
          role="tabpanel"
          aria-labelledby="wb-tab-files"
        >
          <FileBrowser
            sessionCwd={sessionCwd}
            openTarget={pendingTarget}
            onTargetConsumed={consumeTarget}
            labels={{
              loading: t('loading'),
              empty: t('empty'),
              truncated: t('truncated'),
              binary: t('binary'),
              notUtf8: t('notUtf8'),
              emptyFile: t('emptyFile'),
              selectFile: t('selectFile'),
              parent: t('parent'),
              newFile: t('newFile'),
              newFolder: t('newFolder'),
              upload: t('upload'),
              rename: t('rename'),
              delete: t('delete'),
              confirmDelete: t('confirmDelete'),
              create: t('create'),
              cancel: t('cancel'),
              namePlaceholder: t('namePlaceholder'),
              select: t('select'),
              open: t('openEntry'),
              edit: t('edit'),
              save: t('save'),
              saved: t('saved'),
              dropHint: t('dropHint'),
              searchPlaceholder: t('searchPlaceholder'),
              noMatches: t('noMatches'),
              brokenLink: t('brokenLink'),
              replaced: t('replaced'),
              uploadFailed: t('uploadFailed'),
              staleVersion: t('staleVersion'),
              changedOnDisk: t('changedOnDisk'),
              reload: t('reload'),
              htmlViewSource: t('htmlViewSource'),
              htmlViewRendered: t('htmlViewRendered'),
              htmlEnableScripts: t('htmlEnableScripts'),
              htmlDisableScripts: t('htmlDisableScripts'),
              errors: {
                destination_exists: t('err_destination_exists'),
                protected_file: t('err_protected_file'),
                protected_path: t('err_protected_path'),
                sandbox_read_only: t('err_sandbox_read_only'),
                write_disabled: t('err_write_disabled'),
                outside_writable_root: t('err_outside_writable_root'),
                outside_root: t('err_outside_root'),
                root_is_not_a_target: t('err_root_is_not_a_target'),
                symlink_target: t('err_symlink_target'),
                body_too_large: t('err_body_too_large'),
                file_too_large: t('err_file_too_large'),
                not_found: t('err_not_found'),
                invalid_path: t('err_invalid_path'),
                is_directory: t('err_is_directory'),
                not_a_file: t('err_not_a_file'),
                query_too_short: t('err_query_too_short'),
                stale_version: t('staleVersion'),
              },
              searchTruncated: t('searchTruncated'),
            }}
          />
        </div>
        {/* The terminal stays mounted once opened so its scrollback and shell
            survive a trip through the files tab. It keeps `data-workbench-terminal`
            for the Escape exception; hiding is by class, same as before. */}
        <div
          className={tab === 'terminal' ? css.pane : css.paneHidden}
          id="wb-panel-terminal"
          role="tabpanel"
          aria-labelledby="wb-tab-terminal"
          data-workbench-terminal
        >
          <TerminalPane
            active={tab === 'terminal'}
            cwd={sessionCwd}
            labels={{
              connecting: t('connecting'),
              newTab: t('newTerminal'),
              closeTab: t('closeTerminal'),
              exited: t('exited'),
              disconnected: t('disconnected'),
              reconnect: t('reconnect'),
              disabled: t('terminalDisabled'),
            }}
          />
        </div>
      </div>
    </div>
  )
}
