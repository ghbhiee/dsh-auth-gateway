/**
 * Map the active session's working directory onto a readable root + subpath.
 *
 * The file browser wants to open where the session lives. The host fence still
 * only exposes the roots it composed (the workspace root plus configured
 * extras), so this does not widen anything — it picks which of those roots
 * contains the session's cwd and the path within it. A cwd under no root (a
 * session started somewhere the fence does not reach) resolves to null, and the
 * caller keeps its current view rather than pointing at a directory the host
 * would refuse to list.
 *
 * @module dsh-plugin-workbench/client/session-root
 */

import type { Root } from './api.ts'

/** A root id and the path within it that a cwd maps to. */
export interface RootTarget {
  rootId: string
  path: string
}

/**
 * Find the most specific root that contains `cwd`.
 * @param roots - the roots the host offered.
 * @param cwd - the active session's absolute working directory, if known.
 * @returns the root + relative path to open, or null when no root contains it.
 */
export function rootForCwd(roots: readonly Root[], cwd: string | undefined): RootTarget | null {
  if (cwd === undefined || cwd === '') return null
  let best: { rootId: string; path: string; length: number } | null = null
  for (const root of roots) {
    let rel: string | null = null
    if (cwd === root.path) {
      rel = ''
    } else if (cwd.startsWith(`${root.path}/`)) {
      // The trailing slash matters: without it "/ws-other" would count as being
      // under "/ws", the same sibling-prefix trap the read fence guards against.
      rel = cwd.slice(root.path.length + 1)
    }
    if (rel === null) continue
    // Prefer the deepest matching root, so an extra root nested in the workspace
    // wins over the workspace itself.
    if (best === null || root.path.length > best.length) {
      best = { rootId: root.id, path: rel, length: root.path.length }
    }
  }
  return best === null ? null : { rootId: best.rootId, path: best.path }
}
