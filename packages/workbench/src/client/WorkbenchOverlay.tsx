/** Full-frame workbench surface, seated in the shell overlay layer. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { workbenchStore } from './store.ts'
import { FileBrowser } from './FileBrowser.tsx'
import { TerminalPane } from './TerminalPane.tsx'
import css from './WorkbenchOverlay.module.css'

/** Props the framework composes for the overlay registration. */
export type WorkbenchOverlayProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<typeof workbenchStore>
  & PropsLocale<'workbench'>

type Tab = 'files' | 'terminal'

/** Render the workbench panel while the shared store says it is open. */
export function WorkbenchOverlay({ useStore, actions, t }: WorkbenchOverlayProps) {
  const open = useStore(state => state.open)
  const [tab, setTab] = useState<Tab>('files')
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Escape closes the surface, except from inside the terminal: there it is a
  // keystroke the shell owns (vim, less, readline all use it).
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    const target = event.target
    if (target instanceof Element && target.closest('[data-workbench-terminal]') !== null) return
    event.stopPropagation()
    actions.close()
  }, [actions])

  // Move focus into the surface when it opens, so keyboard and screen-reader
  // users are not left behind on the page underneath.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

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
      role="dialog"
      aria-label={t('title')}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
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
