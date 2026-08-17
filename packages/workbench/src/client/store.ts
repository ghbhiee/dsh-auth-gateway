/** Shared open/closed state for the workbench surface. */

import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import { clampDockWidth, DEFAULT_DOCK_WIDTH } from './dock-width.ts'

/** Workbench panel state. */
export interface WorkbenchState {
  /** Whether the workbench surface is visible. */
  open: boolean
  /** Docked to the right of the session (true) vs. covering the whole frame. */
  docked: boolean
  /** Width of the docked panel, in px. */
  dockWidth: number
}

/**
 * One handle shared by the launcher button and the overlay, so both
 * registrations bind the same instance.
 */
export const workbenchStore = defineStore({
  init: (): WorkbenchState => ({ open: false, docked: true, dockWidth: DEFAULT_DOCK_WIDTH }),
  actions: {
    toggle: (draft) => { draft.open = !draft.open },
    close: (draft) => { draft.open = false },
    toggleDock: (draft) => { draft.docked = !draft.docked },
    setDockWidth: (draft, width: number) => { draft.dockWidth = clampDockWidth(width) },
  },
})
