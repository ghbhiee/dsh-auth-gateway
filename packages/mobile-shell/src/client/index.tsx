/**
 * Narrow-viewport shell, browser half.
 *
 * Replaces a set of hand-applied patches to the layout package's compiled
 * bundle with plugin-space equivalents: the drawer geometry is a stylesheet
 * keyed on the shell's data attributes, and the behaviour rides `ctx.layout`.
 *
 * @module dsh-plugin-mobile-shell/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { NARROW_MAX_WIDTH, NarrowShell, type NarrowShellInjected, type ShellSettings } from './NarrowShell.tsx'
import { en, zh, type MobileShellLocaleKey } from './locales.ts'
import './narrow-shell.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Narrow-viewport shell copy. */
    mobileShell: MobileShellLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'mobileShell'

const FALLBACK: ShellSettings = { narrowMaxWidth: NARROW_MAX_WIDTH, documentTitle: 'DSH · {host}' }

/** Ask the host for its settings; its own defaults stand in if it cannot answer. */
async function fetchShellConfig(): Promise<ShellSettings> {
  try {
    const response = await fetch('/plugins/mobile-shell/config')
    if (!response.ok) return FALLBACK
    const body = await response.json() as Partial<ShellSettings>
    return {
      narrowMaxWidth: typeof body.narrowMaxWidth === 'number' ? body.narrowMaxWidth : FALLBACK.narrowMaxWidth,
      documentTitle: typeof body.documentTitle === 'string' ? body.documentTitle : FALLBACK.documentTitle,
    }
  } catch {
    return FALLBACK
  }
}

/** Services required by the registration below. */
export const inject = ['slots', 'locale', 'layout']

/** Seat the narrow-viewport controls; the component fetches its own settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mobile-shell: dictionaries')

  const injected = (): NarrowShellInjected => ({
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    loadSettings: fetchShellConfig,
  })

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-shell',
    order: 10,
    locale: NS,
    inject: injected,
  }, NarrowShell))
}
