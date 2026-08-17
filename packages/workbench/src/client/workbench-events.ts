/**
 * A tiny window-event bridge between the workbench surface and the seats that
 * drive it from inside the conversation.
 *
 * The surface (and its launcher) live in root-scoped seats, so they share one
 * `workbenchStore`. The conversation header launcher and the artifact links live
 * in *session*-scoped seats, and a store handle may mount at only one scope
 * ("one handle, one scope") — so a session seat cannot bind the root store. It
 * dispatches a window event instead; the always-mounted overlay listens and
 * calls the store action. Decoupled, and no cross-scope store binding.
 *
 * @module dsh-plugin-workbench/client/workbench-events
 */

/** Toggle the surface open/closed. */
export const WORKBENCH_TOGGLE = 'dsh-workbench:toggle'
/** Open the surface and preview a specific file. */
export const WORKBENCH_OPEN_FILE = 'dsh-workbench:open-file'

/** Which file to open, carried on a {@link WORKBENCH_OPEN_FILE} event. */
export interface OpenFileDetail {
  /** Root id the path belongs to. */
  root: string
  /** Path relative to that root. */
  path: string
  /** Basename, for the preview label. */
  name: string
}

/** Ask the surface to toggle. */
export function requestToggle(): void {
  window.dispatchEvent(new CustomEvent(WORKBENCH_TOGGLE))
}

/** Ask the surface to open and preview a file. */
export function requestOpenFile(detail: OpenFileDetail): void {
  window.dispatchEvent(new CustomEvent<OpenFileDetail>(WORKBENCH_OPEN_FILE, { detail }))
}

/**
 * Subscribe the surface to the bridge.
 * @param handlers - what to do on each request.
 * @returns an unsubscribe function.
 */
export function onWorkbenchRequests(handlers: {
  toggle: () => void
  openFile: (detail: OpenFileDetail) => void
}): () => void {
  const onToggle = (): void => { handlers.toggle() }
  const onOpen = (event: Event): void => {
    const detail = (event as CustomEvent<OpenFileDetail>).detail
    if (detail !== undefined && detail !== null) handlers.openFile(detail)
  }
  window.addEventListener(WORKBENCH_TOGGLE, onToggle)
  window.addEventListener(WORKBENCH_OPEN_FILE, onOpen)
  return () => {
    window.removeEventListener(WORKBENCH_TOGGLE, onToggle)
    window.removeEventListener(WORKBENCH_OPEN_FILE, onOpen)
  }
}
