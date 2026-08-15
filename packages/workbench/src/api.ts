/**
 * HTTP surface for the workbench file browser.
 *
 * Directory listings go through `node:fs` rather than `ctx.fs.listDir`: the
 * seam's `FsDirEntry` carries no modification time, and a browser file list
 * needs one. File contents still go through `ctx.fs`, so reads stay on the
 * seam and keep emitting its policy events.
 *
 * @module dsh-plugin-workbench/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, join } from 'node:path'
import { lstat, mkdir, opendir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { ApiError, composeRoots, resolveInRoot, type ReadRoot } from './roots.ts'
import { assertWritable, assertWritableRequest, MAX_WRITE_BYTES } from './write-guard.ts'
import { DEFAULT_LIMITS, searchNames } from './search.ts'
import { isSameOrigin } from './origin.ts'

/** Largest text file the editor/preview will fetch. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** Largest binary payload the preview will stream (images, mostly). */
const MAX_BYTES = 32 * 1024 * 1024
/** Loopback addresses accepted when `loopbackOnly` is on. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
}

/** One row in a directory listing. */
export interface ListEntry {
  /** Basename inside the listed directory. */
  name: string
  /** Entry kind; a symlink reports as such rather than as its target. */
  type: 'file' | 'directory' | 'symlink' | 'other'
  /**
   * For a symlink, what it resolves to — the browser needs this to know
   * whether clicking it should navigate or preview. `broken` means the target
   * is missing or unreadable.
   */
  linkTarget?: 'file' | 'directory' | 'other' | 'broken'
  /** Byte size for regular files. */
  size: number
  /** Modification time, ISO 8601. */
  mtime: string
}

/** Settings the handler reads per request. */
export interface ApiOptions {
  /** Extra absolute directories exposed beyond the workspace root. */
  readRoots: string[]
  /** Refuse non-loopback callers. */
  loopbackOnly: boolean
  /** Cap on entries returned by one listing. */
  maxListEntries: number
  /** Allow the mutating routes at all. */
  writeEnabled: boolean
  /** Whether the terminal gateway is mounted; the browser should not dial it otherwise. */
  ptyEnabled: boolean
}

/** Read the request body, refusing anything over the write cap. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    if (total > MAX_WRITE_BYTES) throw new ApiError(413, 'body_too_large', 'Request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, { error: error.message, code: error.code })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 500, { error: message, code: 'internal' })
}

/** Whether something is already at this path (a broken symlink counts). */
async function exists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath)
    return true
  } catch {
    return false
  }
}

function requireQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key)
  if (value === null) throw new ApiError(400, 'missing_param', `Missing query parameter: ${key}`)
  return value
}


/**
 * Resolve a mutating request's target, which may not exist yet.
 *
 * A root itself is never a target. An empty `path` resolves to the root, so
 * without this guard `DELETE ?path=&recursive=1` answers `{ok:true}` after
 * deleting the entire workspace — the worst possible reading of a request the
 * UI would never send but the API must still refuse.
 *
 * `refuseSymlink` closes a subtler hole. The root fence realpaths the target,
 * but a target that does not exist yet has no realpath, so it anchors on the
 * parent instead — and a *dangling* symlink as the final component has an
 * existing parent, so it slips through, after which a following write (raw
 * `writeFile` in `upload`) lands wherever the link points: outside the root,
 * outside every writable sandbox root (confirmed — an upload planted a file in
 * `$HOME`). A middle-of-path symlink is already caught, because realpath of the
 * parent follows it; only the last component is appended literally. Writing
 * *through* a symlink is never what the file browser means, so write/upload/
 * mkdir refuse one outright; rename and delete operate on the link itself and
 * leave it off.
 * @param roots - the allowed roots.
 * @param url - the request URL carrying `root` and `path`.
 * @param pathKey - which query parameter holds the path.
 * @param opts - `refuseSymlink` rejects a final component that is a symlink.
 * @returns the resolved target.
 * @throws ApiError when the target is a root or a refused symlink.
 */
async function resolveInRootForWrite(
  roots: readonly ReadRoot[],
  url: URL,
  pathKey = 'path',
  opts: { refuseSymlink?: boolean } = {},
): Promise<{ root: ReadRoot; absolutePath: string }> {
  const resolved = await resolveInRoot(roots, requireQuery(url, 'root'), requireQuery(url, pathKey), { mustExist: false })
  if (resolved.absolutePath === resolved.root.path) {
    throw new ApiError(400, 'root_is_not_a_target', 'A root itself cannot be created, renamed, or deleted')
  }
  if (opts.refuseSymlink === true) {
    // lstat does not follow, so it sees the link rather than its target — the
    // one probe that catches a dangling link the realpath fence could not.
    let link = false
    try {
      link = (await lstat(resolved.absolutePath)).isSymbolicLink()
    } catch { /* nothing there yet: a plain create, which is fine */ }
    if (link) {
      throw new ApiError(403, 'symlink_target', 'Refusing to write through a symlink')
    }
  }
  return resolved
}

/** Sort directories first, then by name, so the tree reads like a file manager. */
function compareEntries(a: { name: string; type: ListEntry['type'] }, b: { name: string; type: ListEntry['type'] }): number {
  const aDir = a.type === 'directory'
  const bDir = b.type === 'directory'
  if (aDir !== bDir) return aDir ? -1 : 1
  return a.name.localeCompare(b.name)
}

/**
 * Ceiling on names held while deciding what a listing shows. Well past any
 * directory a person browses; it exists so a pathological one cannot grow the
 * heap without bound.
 */
const MAX_SCAN_ENTRIES = 50_000

/**
 * List a directory, capped at `maxEntries`.
 *
 * Two passes on purpose. Truncating the dirent stream directly would hand back
 * whichever names the filesystem happened to yield first — an arbitrary subset,
 * sorted afterwards so it *looks* ordered. In a directory past the cap that
 * quietly drops subdirectories, and a subdirectory you cannot see is one you
 * cannot open. So: collect names and kinds first (cheap, no syscall per entry),
 * sort, cut, and only then stat the survivors — the expensive pass stays capped
 * at `maxEntries` either way.
 */
async function listDirectory(absolutePath: string, maxEntries: number): Promise<{ entries: ListEntry[]; truncated: boolean }> {
  let dir
  try {
    dir = await opendir(absolutePath)
  } catch {
    throw new ApiError(404, 'not_a_directory', 'Not a directory')
  }

  const names: { name: string; type: ListEntry['type'] }[] = []
  let truncated = false
  for await (const child of dir) {
    if (names.length >= MAX_SCAN_ENTRIES) {
      truncated = true
      // `break` alone is the correct exit: the async iterator's return() closes
      // the handle. Closing it here too makes that cleanup throw
      // "Directory handle was closed", turning truncation into a 500.
      break
    }
    names.push({
      name: child.name,
      type: child.isDirectory()
        ? 'directory'
        : child.isSymbolicLink()
          ? 'symlink'
          : child.isFile() ? 'file' : 'other',
    })
  }

  names.sort(compareEntries)
  if (names.length > maxEntries) {
    names.length = maxEntries
    truncated = true
  }

  const entries: ListEntry[] = []
  for (const child of names) {
    const childPath = join(absolutePath, child.name)
    let size = 0
    let mtime = ''
    try {
      const info = await lstat(childPath)
      size = info.size
      mtime = info.mtime.toISOString()
    } catch {
      // A child that vanished mid-listing still gets a row, minus its metadata.
    }
    let linkTarget: ListEntry['linkTarget']
    if (child.type === 'symlink') {
      try {
        const target = await stat(childPath)
        linkTarget = target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other'
      } catch {
        linkTarget = 'broken'
      }
    }
    entries.push({ name: child.name, type: child.type, size, mtime, ...(linkTarget === undefined ? {} : { linkTarget }) })
  }
  return { entries, truncated }
}

/**
 * Build the request handler for the workbench file API.
 * @param ctx - plugin context (reads `ctx.fs` and `ctx.sandboxPolicy`).
 * @param options - live plugin settings.
 * @returns a handler for the `/plugins/workbench/api/` prefix route.
 */
export function createApiHandler(ctx: Context, options: ApiOptions) {
  const roots = (): ReadRoot[] => composeRoots(ctx.sandboxPolicy.resolve().workspaceRoot, options.readRoots)

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (options.loopbackOnly && !LOOPBACK.has(req.socket.remoteAddress ?? '')) {
        throw new ApiError(403, 'not_loopback', 'The workbench API is restricted to loopback callers')
      }
      const url = new URL(req.url ?? '/', 'http://workbench.local')
      const route = url.pathname.replace(/^\/plugins\/workbench\/api\/?/, '')
      const method = req.method ?? 'GET'
      const mutating = method !== 'GET' && method !== 'HEAD'

      if (mutating && !options.writeEnabled) {
        throw new ApiError(403, 'write_disabled', 'Set workbench config writeEnabled: true to allow changes')
      }

      // A cross-site POST is not blocked by the same-origin policy — only its
      // *response* is — so a page the user visits could `upload` a file into the
      // workspace without ever reading the reply. GET reads are protected by
      // the browser already; the mutating verbs are not, so gate them on origin.
      if (mutating && !isSameOrigin(req)) {
        throw new ApiError(403, 'cross_origin', 'Cross-origin requests may not change files')
      }

      if (route === 'health') {
        // The browser half adapts to these: no write UI when writes are off.
        sendJson(res, 200, { ok: true, writeEnabled: options.writeEnabled, ptyEnabled: options.ptyEnabled })
        return
      }

      if (route === 'roots') {
        sendJson(res, 200, { roots: roots().map(({ id, path, label }) => ({ id, path, label })) })
        return
      }

      if (route === 'list') {
        const { root, absolutePath } = await resolveInRoot(roots(), requireQuery(url, 'root'), url.searchParams.get('path') ?? '')
        const { entries, truncated } = await listDirectory(absolutePath, options.maxListEntries)
        sendJson(res, 200, {
          root: root.id,
          path: url.searchParams.get('path') ?? '',
          absolutePath,
          entries,
          truncated,
        })
        return
      }

      if (route === 'stat') {
        // One lstat and a version token: cheap enough to poll while a preview
        // is open, unlike re-reading the file.
        const { absolutePath } = await resolveInRoot(roots(), requireQuery(url, 'root'), requireQuery(url, 'path'))
        const info = await stat(absolutePath)
        const target = await ctx.fs.resolve(absolutePath)
        const seam = await ctx.fs.stat(target)
        sendJson(res, 200, {
          type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size,
          version: seam?.version ?? null,
        })
        return
      }

      if (route === 'search') {
        const query = requireQuery(url, 'q')
        // One or two characters match nearly everything; the walk is not worth
        // starting, and an accidental keystroke should not scan a workspace.
        if (query.trim().length < 2) throw new ApiError(400, 'query_too_short', 'Search needs at least two characters')
        const { root, absolutePath } = await resolveInRoot(roots(), requireQuery(url, 'root'), url.searchParams.get('path') ?? '')
        const result = await searchNames(absolutePath, query.trim(), DEFAULT_LIMITS)
        sendJson(res, 200, { root: root.id, query: query.trim(), ...result })
        return
      }

      if (route === 'read') {
        const { absolutePath } = await resolveInRoot(roots(), requireQuery(url, 'root'), requireQuery(url, 'path'))
        // stat, not lstat: a symlink to a directory must be refused as a
        // directory, or the read falls through and the fs seam throws a 500.
        const info = await stat(absolutePath)
        if (info.isDirectory()) throw new ApiError(400, 'not_a_file', 'Path is a directory')
        if (!info.isFile()) throw new ApiError(400, 'not_a_file', 'Path is not a regular file')
        if (info.size > MAX_TEXT_BYTES) throw new ApiError(413, 'file_too_large', 'File is too large to display')
        const target = await ctx.fs.resolve(absolutePath)
        const bytes = await ctx.fs.readBytes(target, undefined, MAX_TEXT_BYTES)
        if (bytes.includes(0)) throw new ApiError(415, 'binary_file', 'File is not text')
        const buffer = Buffer.from(bytes)
        const text = buffer.toString('utf-8')
        // Decoding never throws: invalid bytes become U+FFFD, which would ship
        // mojibake to the browser as if it were the file. Round-tripping is the
        // cheap way to tell "text in another encoding" from "text".
        if (!Buffer.from(text, 'utf-8').equals(buffer)) {
          throw new ApiError(415, 'not_utf8', 'File is text but not UTF-8; the workbench cannot display it')
        }
        // The version travels with the content so a later write can say "only
        // if nothing else touched it" — otherwise two editors silently clobber.
        const stat_ = await ctx.fs.stat(target)
        sendJson(res, 200, {
          path: url.searchParams.get('path'),
          size: info.size,
          content: text,
          version: stat_?.version ?? null,
        })
        return
      }

      if (route === 'bytes') {
        const { absolutePath } = await resolveInRoot(roots(), requireQuery(url, 'root'), requireQuery(url, 'path'))
        const info = await stat(absolutePath)
        if (info.isDirectory()) throw new ApiError(400, 'not_a_file', 'Path is a directory')
        if (!info.isFile()) throw new ApiError(400, 'not_a_file', 'Path is not a regular file')
        if (info.size > MAX_BYTES) throw new ApiError(413, 'file_too_large', 'File is too large to stream')
        const target = await ctx.fs.resolve(absolutePath)
        const bytes = await ctx.fs.readBytes(target, undefined, MAX_BYTES)
        const body = Buffer.from(bytes)
        res.writeHead(200, {
          'content-type': MIME[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(body.byteLength),
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(absolutePath))}`,
          'cache-control': 'no-store',
          // This route hands workspace bytes back on the app's own origin, and
          // a workspace is full of files nobody here wrote — a cloned repo, a
          // package's assets, whatever an agent just generated. An SVG is a
          // document, not just a picture: navigate to one containing <script>
          // and it runs as the app, with reach into its storage and into this
          // very API (the PTY route included). `default-src 'none'` refuses the
          // script outright; `sandbox` puts the document in an opaque origin so
          // anything that does run cannot reach back. Neither affects the in-app
          // preview, which embeds these through <img>.
          'content-security-policy': "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; sandbox",
          'x-content-type-options': 'nosniff',
        })
        res.end(req.method === 'HEAD' ? undefined : body)
        return
      }

      // ─── mutating routes ────────────────────────────────────────────

      if (route === 'write' || route === 'upload') {
        if (method !== 'PUT' && method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use PUT or POST')
        assertWritableRequest(ctx, requireQuery(url, 'path'))
        const { absolutePath } = await resolveInRootForWrite(roots(), url, 'path', { refuseSymlink: true })
        await assertWritable(ctx, absolutePath)
        const body = await readBody(req)
        const overwrote = await exists(absolutePath)
        let version: string | null = null
        if (route === 'write') {
          // Text goes through the fs seam so the harness's own write policy and
          // its fs/* events still see it.
          const target = await ctx.fs.resolve(absolutePath)
          const expected = url.searchParams.get('version')
          try {
            await ctx.fs.writeText(
              target,
              body.toString('utf-8'),
              expected === null ? undefined : { kind: 'replaceIfVersion', version: expected as never },
            )
          } catch (error) {
            // The seam refuses a write whose basis moved under it; that is a
            // lost-update caught, not a failure to report as one.
            if ((error as { code?: string }).code === 'FS_STALE_VERSION') {
              throw new ApiError(409, 'stale_version', 'The file changed on disk since it was opened')
            }
            throw error
          }
          // Hand back the new token so an editor can keep editing without a
          // re-read, and so the freshness poll has something to compare with.
          const after = await ctx.fs.stat(await ctx.fs.resolve(absolutePath))
          version = after?.version ?? null
        } else {
          await writeFile(absolutePath, body)
        }
        sendJson(res, 200, { ok: true, bytes: body.byteLength, overwrote, version })
        return
      }

      if (route === 'mkdir') {
        if (method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST')
        assertWritableRequest(ctx, requireQuery(url, 'path'))
        const { absolutePath } = await resolveInRootForWrite(roots(), url, 'path', { refuseSymlink: true })
        await assertWritable(ctx, absolutePath)
        await mkdir(absolutePath, { recursive: true })
        sendJson(res, 200, { ok: true })
        return
      }

      if (route === 'rename') {
        if (method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST')
        assertWritableRequest(ctx, requireQuery(url, 'path'))
        const { absolutePath } = await resolveInRootForWrite(roots(), url)
        await assertWritable(ctx, absolutePath)
        assertWritableRequest(ctx, requireQuery(url, 'to'))
        const destination = await resolveInRootForWrite(roots(), url, 'to')
        await assertWritable(ctx, destination.absolutePath)
        // POSIX rename() replaces the destination without a word, so a rename
        // onto an existing name is silent data loss. Refuse unless the caller
        // says explicitly that replacing is the intent.
        if (url.searchParams.get('overwrite') !== '1' && await exists(destination.absolutePath)) {
          throw new ApiError(409, 'destination_exists', 'Something is already there; pass overwrite=1 to replace it')
        }
        await rename(absolutePath, destination.absolutePath)
        sendJson(res, 200, { ok: true })
        return
      }

      if (route === 'delete') {
        if (method !== 'DELETE' && method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use DELETE')
        assertWritableRequest(ctx, requireQuery(url, 'path'))
        const { absolutePath } = await resolveInRootForWrite(roots(), url)
        await assertWritable(ctx, absolutePath)
        const info = await lstat(absolutePath).catch(() => null)
        if (info === null) throw new ApiError(404, 'not_found', 'No such file or directory')
        if (info.isDirectory() && url.searchParams.get('recursive') !== '1') {
          throw new ApiError(400, 'is_directory', 'Pass recursive=1 to delete a directory')
        }
        await rm(absolutePath, { recursive: info.isDirectory(), force: false })
        sendJson(res, 200, { ok: true })
        return
      }

      throw new ApiError(404, 'unknown_route', `No such workbench route: ${route}`)
    } catch (error) {
      sendError(res, error)
    }
  }
}
