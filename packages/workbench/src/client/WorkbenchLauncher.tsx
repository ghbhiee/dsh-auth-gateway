/** Sidebar footer entry point that reveals the workbench overlay. */

import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { workbenchStore } from './store.ts'
import css from './WorkbenchLauncher.module.css'

/** Props the framework composes for the launcher registration. */
export type WorkbenchLauncherProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<typeof workbenchStore>
  & PropsLocale<'workbench'>

/** Render the launcher: a labelled row when the column is wide, an icon on the rail. */
export function WorkbenchLauncher({ wide, actions, t }: WorkbenchLauncherProps) {
  return (
    <button
      type="button"
      className={css.launcher}
      aria-label={t('open')}
      title={t('open')}
      onClick={() => { actions.toggle() }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3" />
        <path d="M13 15h4" />
      </svg>
      {wide ? <span className={css.label}>{t('title')}</span> : null}
    </button>
  )
}
