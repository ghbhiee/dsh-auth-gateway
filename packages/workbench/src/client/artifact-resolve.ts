/**
 * Turn a raw path token (from an intercepted conversation file link) into a
 * file the workbench can actually preview: resolved to a read root, and
 * confirmed to exist on disk.
 *
 * @module dsh-plugin-workbench/client/artifact-resolve
 */

import { fetchRoots, fetchStat, type Root } from './api.ts'
import { rootForCwd } from './session-root.ts'

/** A path token resolved to a real, previewable file. */
export interface ResolvedArtifact {
  /** Root id the file lives under. */
  root: string
  /** Path relative to that root. */
  path: string
  /** Basename, for the preview label. */
  name: string
  /** The absolute path, the identity a repeat click toggles on. */
  absolute: string
}

let rootsCache: Root[] | null = null
async function loadRoots(): Promise<Root[]> {
  if (rootsCache !== null) return rootsCache
  rootsCache = await fetchRoots()
  return rootsCache
}

/** Existence memo, so repeated clicks on the same link cost one stat. */
const existsCache = new Map<string, boolean>()

/** Clear the module caches — for tests, which stub different roots per case. */
export function resetArtifactCaches(): void {
  rootsCache = null
  existsCache.clear()
}

function toAbsolute(token: string, cwd: string | undefined): string | null {
  if (token.startsWith('/')) return token
  if (cwd === undefined || cwd === '') return null
  return `${cwd.replace(/\/+$/, '')}/${token}`
}

/**
 * Resolve one token against the roots. Pure given the roots.
 * @param roots - the readable roots.
 * @param token - a path token (absolute, or relative to the cwd).
 * @param cwd - the session working directory, for relative tokens.
 * @returns the resolved file, or null when it maps outside every root.
 */
export function resolveOne(roots: readonly Root[], token: string, cwd: string | undefined): ResolvedArtifact | null {
  const absolute = toAbsolute(token, cwd)
  if (absolute === null) return null
  const target = rootForCwd(roots, absolute)
  if (target === null) return null
  const name = target.path.slice(target.path.lastIndexOf('/') + 1) || target.path
  return { root: target.rootId, path: target.path, name, absolute }
}

async function isFile(artifact: ResolvedArtifact): Promise<boolean> {
  const key = `${artifact.root}:${artifact.path}`
  const cached = existsCache.get(key)
  if (cached !== undefined) return cached
  let ok = false
  try {
    ok = (await fetchStat(artifact.root, artifact.path)).type === 'file'
  } catch {
    ok = false
  }
  existsCache.set(key, ok)
  return ok
}

/**
 * Resolve a clicked path token to a previewable file.
 *
 * The token opens only if it lands inside a read root and names a real file —
 * a link to something deleted, a directory, or a path outside the fence
 * resolves to null and the click does nothing, rather than opening a dead
 * preview (or, worse, falling back to the host opener).
 * @param token - the path from the clicked link.
 * @param cwd - the session working directory.
 * @returns the file, or null when it cannot be previewed.
 */
export async function resolvePreviewable(token: string, cwd: string | undefined): Promise<ResolvedArtifact | null> {
  const roots = await loadRoots().catch(() => [] as Root[])
  if (roots.length === 0) return null
  const resolved = resolveOne(roots, token, cwd)
  if (resolved === null) return null
  return (await isFile(resolved)) ? resolved : null
}
