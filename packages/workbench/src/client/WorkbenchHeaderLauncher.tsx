/**
 * A second workbench launcher, in the conversation header's top-right utilities
 * row — so the panel is reachable from the session itself, not only the sidebar
 * footer.
 *
 * This seat is session-scoped, so it cannot bind the root-scoped `workbenchStore`
 * ("one handle, one scope"); it asks the surface to toggle through the window-
 * event bridge instead, which the always-mounted overlay is listening on.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: brings the conversation slot names into SlotMap so the seat below
// is a known slot. Erased at build, so it adds nothing to the bundle.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { requestToggle } from './workbench-events.ts'
import css from './WorkbenchHeaderLauncher.module.css'

/** Props the framework composes for the header-utilities registration. */
export type WorkbenchHeaderLauncherProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<'workbench'>

/** Render the header launcher: an icon button that toggles the surface. */
export function WorkbenchHeaderLauncher({ t }: WorkbenchHeaderLauncherProps) {
  return (
    <button
      type="button"
      className={css.button}
      aria-label={t('open')}
      title={t('open')}
      onClick={() => { requestToggle() }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3" />
        <path d="M13 15h4" />
      </svg>
    </button>
  )
}
