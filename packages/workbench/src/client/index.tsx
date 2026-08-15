/**
 * Workbench browser half: a full-frame surface plus its sidebar entry point.
 *
 * Both registrations share one store handle, so the launcher toggles the very
 * instance the overlay reads.
 *
 * @module dsh-plugin-workbench/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkbenchLauncher } from './WorkbenchLauncher.tsx'
import { WorkbenchOverlay } from './WorkbenchOverlay.tsx'
import { workbenchStore } from './store.ts'
import { en, zh, type WorkbenchLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workbench surface copy. */
    workbench: WorkbenchLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'workbench'

/** Services required by the registrations below. */
export const inject = ['slots', 'locale']

/** Seat the workbench overlay and its launcher. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'workbench: dictionaries')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'workbench',
    order: 50,
    store: workbenchStore,
    locale: NS,
  }, WorkbenchOverlay))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'workbench',
    order: 10,
    store: workbenchStore,
    locale: NS,
  }, WorkbenchLauncher))
}
