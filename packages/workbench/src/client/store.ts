/** Shared open/closed state for the workbench surface. */

import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import { clampDockWidth, DEFAULT_DOCK_WIDTH } from './dock-width.ts'
import { linkClick } from './link-preview.ts'

/** A file the browser should navigate to and preview. */
export interface PreviewTarget {
  /** Root id the path belongs to. */
  root: string
  /** Path relative to that root. */
  path: string
  /** Basename, for the preview label and kind routing. */
  name: string
}

/** A preview target plus the absolute identity a repeat click toggles on. */
export interface LinkPreviewTarget extends PreviewTarget {
  /** The file's absolute path. */
  absolute: string
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
   * browser (an intercepted conversation link) asks to preview it, cleared
   * once the browser has navigated there.
   */
  pendingTarget: PreviewTarget | null
  /** Absolute path of the file a conversation link opened, or null. While set, the browser shows only the preview. */
  linkPreviewPath: string | null
  /** Whether the surface was open before a link took it over, for restore on the closing click. */
  openBeforeLink: boolean
}

/**
 * One handle shared by the launcher button, the overlay, and the conversation
 * link interceptor, so every registration binds the same instance.
 */
export const workbenchStore = defineStore({
  init: (): WorkbenchState => ({
    open: false, docked: true, dockWidth: DEFAULT_DOCK_WIDTH,
    pendingTarget: null, linkPreviewPath: null, openBeforeLink: false,
  }),
  actions: {
    toggle: (draft) => { draft.open = !draft.open },
    close: (draft) => { draft.open = false; draft.linkPreviewPath = null },
    toggleDock: (draft) => { draft.docked = !draft.docked },
    setDockWidth: (draft, width: number) => { draft.dockWidth = clampDockWidth(width) },
    /** Open the surface and ask the browser to preview a file. */
    openFile: (draft, target: PreviewTarget) => {
      draft.open = true
      draft.pendingTarget = target
    },
    /** The browser has navigated to the pending target; forget it. */
    consumeTarget: (draft) => { draft.pendingTarget = null },
    /**
     * A conversation file link was clicked: preview it in the docked panel, or
     * — same link while showing — close and restore. The rules live in
     * {@link linkClick}, where they are pure and tested.
     */
    openLinkPreview: (draft, target: LinkPreviewTarget) => {
      const next = linkClick(draft, target.absolute)
      draft.open = next.open
      draft.linkPreviewPath = next.linkPreviewPath
      draft.openBeforeLink = next.openBeforeLink
      draft.pendingTarget = next.opens ? { root: target.root, path: target.path, name: target.name } : null
      // A link preview reads best beside the conversation it came from.
      if (next.opens) draft.docked = true
    },
    /** Leave link-preview mode (Back in the browser) but keep the surface open. */
    exitLinkPreview: (draft) => { draft.linkPreviewPath = null },
  },
})
