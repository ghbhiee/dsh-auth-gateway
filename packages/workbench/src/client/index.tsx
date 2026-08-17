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
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { WorkbenchLauncher } from './WorkbenchLauncher.tsx'
import { WorkbenchHeaderLauncher } from './WorkbenchHeaderLauncher.tsx'
import { WorkbenchOverlay } from './WorkbenchOverlay.tsx'
import { TurnArtifacts } from './TurnArtifacts.tsx'
import { workbenchStore } from './store.ts'
import { en, zh, type WorkbenchLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workbench surface copy. */
    workbench: WorkbenchLocaleKey
  }
}

// The deliverables turn data is published by a package not in this plugin's
// dependency set, so its map entry is re-declared here to read it type-safely.
declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    /** Files a turn produced through the file-edit tools, in write order. */
    deliverables: { readonly produced: readonly { readonly seq: number; readonly path: string }[] }
  }
}

/** Produced paths at or before the closing seq, deduped in first-seen order. */
function producedForClosing(
  data: { readonly produced: readonly { readonly seq: number; readonly path: string }[] } | undefined,
  seq: number,
): string[] {
  if (data === undefined) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const entry of data.produced) {
    if (entry.seq > seq || seen.has(entry.path)) continue
    seen.add(entry.path)
    paths.push(entry.path)
  }
  return paths
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

  // A second entry point in the conversation header's top-right, so the panel is
  // reachable from the session itself, not only the sidebar footer. This seat is
  // session-scoped, so it drives the root surface through the event bridge rather
  // than binding the store (a handle mounts at one scope only).
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'workbench',
    order: 10,
    locale: NS,
  }, WorkbenchHeaderLauncher))

  // Take over the turn footer's single-winner chain (dsh's ProducedFiles seat):
  // `select` always elects — a lower priority than the built-in — and hands the
  // produced paths as `matched`; the component adds prose-named files and shows
  // each as an inline preview rather than opening it through the host.
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    priority: -1,
    select: (owner): readonly string[] | null => producedForClosing(owner.turn.data.get('deliverables'), owner.seq),
    locale: NS,
  }, TurnArtifacts))
}
