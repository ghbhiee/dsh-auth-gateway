/** Shared open/closed state for the workbench surface. */

import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import { clampDockWidth, DEFAULT_DOCK_WIDTH } from './dock-width.ts'

/** A file the browser should navigate to and preview. */
export interface PreviewTarget {
  /** Root id the path belongs to. */
  root: string
  /** Path relative to that root. */
  path: string
  /** Basename, for the preview label and kind routing. */
  name: string
}

/** Workbench panel state. */
export interface WorkbenchState {
  /** Whether the workbench surface is visible. */
  open: boolean
  /** Docked to the right of the session (true) vs. covering the whole frame. */
  docked: boolean
  /** Width of the docked panel, in px. */
  dockWidth: number
  /**
   * A one-shot request to open a specific file — set when something outside the
   * browser (an artifact link in the conversation) asks to preview it, cleared
   * once the browser has navigated there.
   */
  pendingTarget: PreviewTarget | null
}

/**
 * One handle shared by the launcher button, the overlay, and the conversation
 * artifact links, so every registration binds the same instance.
 */
export const workbenchStore = defineStore({
  init: (): WorkbenchState => ({ open: false, docked: true, dockWidth: DEFAULT_DOCK_WIDTH, pendingTarget: null }),
  actions: {
    toggle: (draft) => { draft.open = !draft.open },
    close: (draft) => { draft.open = false },
    toggleDock: (draft) => { draft.docked = !draft.docked },
    setDockWidth: (draft, width: number) => { draft.dockWidth = clampDockWidth(width) },
    /** Open the surface and ask the browser to preview a file. */
    openFile: (draft, target: PreviewTarget) => {
      draft.open = true
      draft.pendingTarget = target
    },
    /** The browser has navigated to the pending target; forget it. */
    consumeTarget: (draft) => { draft.pendingTarget = null },
  },
})
