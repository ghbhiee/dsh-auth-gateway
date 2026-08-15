/** Shared open/closed state for the workbench surface. */

import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Workbench panel state. */
export interface WorkbenchState {
  /** Whether the full-frame workbench overlay is visible. */
  open: boolean
}

/**
 * One handle shared by the launcher button and the overlay, so both
 * registrations bind the same instance.
 */
export const workbenchStore = defineStore({
  init: (): WorkbenchState => ({ open: false }),
  actions: {
    toggle: (draft) => { draft.open = !draft.open },
    close: (draft) => { draft.open = false },
  },
})
