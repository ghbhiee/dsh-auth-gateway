/**
 * The docked panel's width bounds, kept apart from the store.
 *
 * `store.ts` imports the client runtime, whose module runs a loader side-effect
 * at import; pulling these constants from there would drag that in wherever they
 * are used (the overlay component, the tests). They are pure numbers, so they
 * live on their own and both the store and the drag handle read them here.
 *
 * @module dsh-plugin-workbench/client/dock-width
 */

/** Smallest the docked panel may be dragged to, in px. */
export const MIN_DOCK_WIDTH = 320
/** Largest the docked panel may be dragged to, in px. */
export const MAX_DOCK_WIDTH = 900
/** Default width of the docked panel, in px. */
export const DEFAULT_DOCK_WIDTH = 460

/**
 * Clamp a requested dock width to the allowed range.
 * @param width - the requested width in px.
 * @returns an integer width within [{@link MIN_DOCK_WIDTH}, {@link MAX_DOCK_WIDTH}].
 */
export function clampDockWidth(width: number): number {
  return Math.max(MIN_DOCK_WIDTH, Math.min(MAX_DOCK_WIDTH, Math.round(width)))
}
