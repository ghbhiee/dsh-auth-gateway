/**
 * The write side of the fence.
 *
 * Reading is confined to the plugin's configured roots. Writing has to clear a
 * second bar, because those roots are chosen for browsing convenience while the
 * harness has its own opinion about what may be modified:
 *
 *   - the sandbox mode must not be `read-only`;
 *   - the target must sit under one of the sandbox policy's writable roots
 *     (workspace root, `/tmp`, the OS temp dir) — the same set
 *     `@deepseek-ai/dsh-sandbox`'s `writableRoots()` hands to the kernel-level
 *     sandbox, restated here because that helper is not exported to plugins;
 *   - a few names are never writable regardless of location.
 *
 * `ctx.fs.writeText` runs the harness's own per-call policy check on top of
 * this for file contents; mkdir/rename/delete have no seam equivalent, so for
 * those this module is the only gate.
 *
 * @module dsh-plugin-workbench/write-guard
 */

import { basename } from 'node:path'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { ApiError, isWithin } from './roots.ts'

/** Names that stay read-only wherever they appear. */
const PROTECTED_NAMES = new Set(['.env', '.env.local', 'auth.json', 'id_rsa', 'id_ed25519', '.npmrc'])

/** Path segments that are never writable through this API. */
const PROTECTED_SEGMENTS = new Set(['.git', '.ssh', 'node_modules'])

/** Largest body accepted by write and upload. */
export const MAX_WRITE_BYTES = 32 * 1024 * 1024

async function canonicalOrParent(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath)
  } catch {
    // The target may not exist yet (create/upload); anchor on its parent so a
    // symlinked parent still cannot smuggle the write out of a writable root.
    const parent = absolutePath.slice(0, Math.max(absolutePath.lastIndexOf('/'), 1))
    try {
      return `${await realpath(parent)}/${basename(absolutePath)}`
    } catch {
      throw new ApiError(404, 'not_found', 'Parent directory does not exist')
    }
  }
}

/**
 * Policy checks that need no filesystem access.
 *
 * Deliberately runs before the path is resolved: resolution touches disk and
 * reports "no such parent" for a path this rule would refuse anyway, which
 * turns a 403 into a misleading 404.
 * @param ctx - plugin context (reads `ctx.sandboxPolicy`).
 * @param relativePath - the request's path, relative to its root.
 * @throws ApiError when the request must not proceed.
 */
export function assertWritableRequest(ctx: Context, relativePath: string): void {
  if (ctx.sandboxPolicy.resolve().mode === 'read-only') {
    throw new ApiError(403, 'sandbox_read_only', 'The sandbox is in read-only mode')
  }
  const segments = relativePath.split('/')
  const name = segments[segments.length - 1] ?? ''
  if (PROTECTED_NAMES.has(name)) {
    throw new ApiError(403, 'protected_file', `${name} cannot be modified through the workbench`)
  }
  for (const segment of segments) {
    if (PROTECTED_SEGMENTS.has(segment)) {
      throw new ApiError(403, 'protected_path', `${segment}/ cannot be modified through the workbench`)
    }
  }
}

/**
 * Confirm the resolved target sits in a directory the sandbox policy allows
 * writing to.
 * @param ctx - plugin context (reads `ctx.sandboxPolicy`).
 * @param absolutePath - the already root-confined absolute target.
 * @throws ApiError when the target is outside every writable root.
 */
export async function assertWritable(ctx: Context, absolutePath: string): Promise<void> {
  const policy = ctx.sandboxPolicy.resolve()
  const name = basename(absolutePath)
  if (PROTECTED_NAMES.has(name)) {
    throw new ApiError(403, 'protected_file', `${name} cannot be modified through the workbench`)
  }
  if (policy.mode === 'danger-full-access') return

  const target = await canonicalOrParent(absolutePath)
  const roots = await Promise.all([policy.workspaceRoot, '/tmp', tmpdir()].map(async (root) => {
    try { return await realpath(root) } catch { return root }
  }))
  if (!roots.some(root => isWithin(root, target))) {
    throw new ApiError(403, 'outside_writable_root', 'Path is outside every writable root of the current sandbox policy')
  }
}
