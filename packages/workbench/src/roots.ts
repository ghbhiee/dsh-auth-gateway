/**
 * Read roots and the containment fence that keeps the browser inside them.
 *
 * The harness's own `fs-sandbox` fences writes only — reads pass straight
 * through to the local filesystem — so a browser-facing file API has to bring
 * its own read fence or it publishes the whole disk over HTTP.
 *
 * @module dsh-plugin-workbench/roots
 */

import { basename, dirname, isAbsolute, normalize, relative, resolve as resolvePath, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { statSync } from 'node:fs'

/** One directory the browser is allowed to read. */
export interface ReadRoot {
  /** Stable id used in request query strings. */
  id: string
  /** Absolute directory path. */
  path: string
  /** Human label for the root picker. */
  label: string
}

/** Failure with an HTTP status attached, thrown by the fence and the handlers. */
export class ApiError extends Error {
  /** HTTP status to answer with. */
  readonly status: number
  /** Stable machine-readable code. */
  readonly code: string

  /**
   * @param status - HTTP status.
   * @param code - stable error code.
   * @param message - human-readable detail.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Whether `child` is `parent` itself or lives underneath it.
 * @param parent - canonical parent path.
 * @param child - canonical child path.
 * @returns true when child does not escape parent.
 */
export function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Check configured extra roots at load time.
 *
 * The harness's rule is that misconfiguration fails loud at load and that a
 * missing referent is never silently skipped. A root that does not exist, or a
 * relative path that cannot be resolved against anything meaningful, would
 * otherwise sit in the picker and answer every request with a puzzling 404.
 * @param extraRoots - the `readRoots` config value.
 * @throws when any entry is relative, missing, or not a directory.
 */
export function validateReadRoots(extraRoots: readonly string[]): void {
  const problems: string[] = []
  for (const path of extraRoots) {
    if (!isAbsolute(path)) {
      problems.push(`${path} — must be an absolute path`)
      continue
    }
    try {
      if (!statSync(path).isDirectory()) problems.push(`${path} — not a directory`)
    } catch {
      problems.push(`${path} — does not exist`)
    }
  }
  if (problems.length > 0) {
    throw new Error(`workbench: readRoots is misconfigured:\n${problems.map(line => `  - ${line}`).join('\n')}`)
  }
}

/**
 * Compose the read roots for a request: the session workspace root first, then
 * the configured extras.
 * @param workspaceRoot - workspace root resolved from the sandbox policy.
 * @param extraRoots - absolute directories from plugin config.
 * @returns the roots, in display order.
 */
export function composeRoots(workspaceRoot: string, extraRoots: readonly string[]): ReadRoot[] {
  const roots: ReadRoot[] = [{
    id: 'workspace',
    path: workspaceRoot,
    label: workspaceRoot.split(sep).pop() ?? workspaceRoot,
  }]
  extraRoots.forEach((path, index) => {
    if (!isAbsolute(path)) return
    roots.push({ id: `extra-${index}`, path, label: path.split(sep).pop() ?? path })
  })
  return roots
}

/**
 * Resolve a request's `root` + `path` pair to an absolute path inside that root.
 *
 * Two layers on purpose: a lexical reject of traversal input, then a
 * `realpath` comparison so a symlink inside the root cannot point out of it.
 * @param roots - the allowed roots.
 * @param rootId - requested root id.
 * @param relPath - requested path, relative to the root.
 * @returns the absolute path, guaranteed to be inside the root.
 * @throws ApiError when the root is unknown, the path is malformed, missing, or escapes.
 */
export async function resolveInRoot(
  roots: readonly ReadRoot[],
  rootId: string,
  relPath: string,
  options: { mustExist?: boolean } = {},
): Promise<{ root: ReadRoot; absolutePath: string }> {
  const root = roots.find(candidate => candidate.id === rootId)
  if (root === undefined) throw new ApiError(404, 'unknown_root', `No such root: ${rootId}`)

  const cleaned = normalize(relPath.replaceAll('\\', '/')).replaceAll('\\', '/')
  if (isAbsolute(cleaned) || cleaned === '..' || cleaned.startsWith('../')) {
    throw new ApiError(400, 'invalid_path', 'Path escapes its root')
  }

  const absolutePath = cleaned === '.' || cleaned === '' ? root.path : resolvePath(root.path, cleaned)
  let canonicalRoot: string
  let canonicalTarget: string
  try {
    canonicalRoot = await realpath(root.path)
  } catch {
    throw new ApiError(404, 'not_found', 'The root no longer exists')
  }
  try {
    canonicalTarget = await realpath(absolutePath)
  } catch {
    if (options.mustExist !== false) throw new ApiError(404, 'not_found', 'No such file or directory')
    // A create target has no canonical form yet: anchor on its parent, so a
    // symlinked parent still cannot place the new entry outside the root.
    try {
      canonicalTarget = `${await realpath(dirname(absolutePath))}/${basename(absolutePath)}`
    } catch {
      throw new ApiError(404, 'not_found', 'Parent directory does not exist')
    }
  }
  if (!isWithin(canonicalRoot, canonicalTarget)) {
    throw new ApiError(403, 'outside_root', 'Path resolves outside its root')
  }
  return { root, absolutePath }
}
