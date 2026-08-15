/**
 * The HTTP surface, driven end to end over a real socket against a real
 * temp directory. The fs seam is stubbed with a local implementation — the
 * point here is the plugin's own routing, guards, and status codes.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, lstat, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createApiHandler } from '../src/api.ts'
import { MAX_WRITE_BYTES } from '../src/write-guard.ts'

let workspace: string
let server: Server
let base: string

/** Minimal ctx: a local fs seam plus a workspace-write sandbox policy. */
function fakeCtx(): Context {
  return {
    fs: {
      resolve: (path: string) => Promise.resolve({ path } as never),
      readBytes: async (target: { path: string }) => new Uint8Array(await readFile(target.path)),
      // Version = mtime + size, which is what a real backend's token stands in for.
      stat: async (target: { path: string }) => {
        const info = await stat(target.path)
        return { version: `${String(info.mtimeMs)}:${String(info.size)}`, type: 'file', size: info.size }
      },
      writeText: async (target: { path: string }, content: string, expected?: { kind: string; version: string }) => {
        if (expected?.kind === 'replaceIfVersion') {
          const info = await stat(target.path).catch(() => null)
          const current = info === null ? null : `${String(info.mtimeMs)}:${String(info.size)}`
          if (current !== expected.version) {
            throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' })
          }
        }
        await writeFile(target.path, content)
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
  } as unknown as Context
}

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${base}/plugins/workbench/api/${path}`, init)
  const text = await response.text()
  let body: unknown = null
  try { body = JSON.parse(text) } catch { /* binary or empty */ }
  return { status: response.status, body, text }
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'wb-api-'))
  await mkdir(join(workspace, 'sub'), { recursive: true })
  await writeFile(join(workspace, 'sub', 'note.txt'), 'hello')
  await writeFile(join(workspace, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(workspace, 'binary.dat'), Buffer.from([1, 0, 2]))
  // Chinese text in GBK: valid text, wrong encoding, and no NUL bytes to give it away.
  await writeFile(join(workspace, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))
  await writeFile(join(workspace, 'utf8.txt'), Buffer.from('中文\n', 'utf-8'))
  await mkdir(join(workspace, 'links'), { recursive: true })
  await symlink(join(workspace, 'sub'), join(workspace, 'links', 'to-dir'))
  await symlink(join(workspace, 'sub', 'note.txt'), join(workspace, 'links', 'to-file'))
  await symlink(join(workspace, 'absent'), join(workspace, 'links', 'broken'))
  // Added last: the listing cap truncates in directory order, so fixtures
  // inserted earlier would displace the entries the listing test looks at.
  await writeFile(join(workspace, 'danger.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.x=1</script></svg>')
  await writeFile(join(workspace, 'page.html'), '<h1>hi</h1>')

  const handler = createApiHandler(fakeCtx(), {
    readRoots: [],
    loopbackOnly: true,
    maxListEntries: 2,
    writeEnabled: true,
    ptyEnabled: false,
  })
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  await rm(workspace, { recursive: true, force: true })
})

describe('read routes', () => {
  it('reports capabilities', async () => {
    const { status, body } = await call('health')
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, writeEnabled: true, ptyEnabled: false })
  })

  it('lists the workspace root', async () => {
    const { status, body } = await call('list?root=workspace')
    expect(status).toBe(200)
    const listing = body as { entries: { name: string; type: string }[]; truncated: boolean }
    expect(listing.entries[0]?.type).toBe('directory')
    expect(listing.truncated).toBe(true) // maxListEntries is 2 and the dir has more
  })

  it('keeps directories visible when a listing is truncated', async () => {
    // The cap used to apply to the raw dirent stream, so a big directory
    // returned whichever names the filesystem yielded first — subdirectories
    // could vanish entirely, and a folder you cannot see is one you cannot open.
    const big = join(workspace, 'big')
    await mkdir(join(big, 'zzz-subdir'), { recursive: true })
    for (let i = 0; i < 20; i += 1) await writeFile(join(big, `file-${String(i).padStart(2, '0')}.txt`), 'x')

    const { body } = await call('list?root=workspace&path=big')
    const listing = body as { entries: { name: string; type: string }[]; truncated: boolean }
    expect(listing.truncated).toBe(true)          // 21 entries, cap of 2
    expect(listing.entries).toHaveLength(2)
    // Directory first, and the cut is by sort order rather than by luck.
    expect(listing.entries[0]).toMatchObject({ name: 'zzz-subdir', type: 'directory' })
    expect(listing.entries[1]).toMatchObject({ name: 'file-00.txt' })

    // Same request twice gives the same answer.
    const again = (await call('list?root=workspace&path=big')).body as typeof listing
    expect(again.entries.map(entry => entry.name)).toEqual(listing.entries.map(entry => entry.name))
  })

  it('reads text', async () => {
    const { body } = await call('read?root=workspace&path=sub/note.txt')
    expect(body).toMatchObject({ content: 'hello', size: 5 })
  })

  it('reads UTF-8 text unharmed', async () => {
    const { body } = await call('read?root=workspace&path=utf8.txt')
    expect(body).toMatchObject({ content: '中文\n' })
  })

  it('refuses a text file in another encoding instead of serving mojibake', async () => {
    const { status, body } = await call('read?root=workspace&path=gbk.txt')
    expect(status).toBe(415)
    expect(body).toMatchObject({ code: 'not_utf8' })
  })

  it('refuses to read a file with NUL bytes as text', async () => {
    const { status, body } = await call('read?root=workspace&path=binary.dat')
    expect(status).toBe(415)
    expect(body).toMatchObject({ code: 'binary_file' })
  })

  it('serves bytes with a content type', async () => {
    const response = await fetch(`${base}/plugins/workbench/api/bytes?root=workspace&path=pic.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  })

  it('refuses to let workspace bytes script the app origin', async () => {
    // An SVG is a document. Without these headers, navigating to a workspace
    // .svg containing <script> ran it on the app's own origin — verified in a
    // real browser: it wrote to the app's localStorage, and from there it could
    // reach this API, PTY route included. Both headers matter: `sandbox` gives
    // the document an opaque origin, `nosniff` stops a mislabelled file from
    // being upgraded into one.
    const response = await fetch(`${base}/plugins/workbench/api/bytes?root=workspace&path=danger.svg`)
    expect(response.status).toBe(200)
    const policy = response.headers.get('content-security-policy') ?? ''
    expect(policy).toContain('sandbox')
    expect(policy).toContain("default-src 'none'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('does not serve HTML as a renderable document', async () => {
    // No text/html in the MIME allowlist, so a workspace .html downloads
    // instead of rendering — the same origin concern by another route.
    const response = await fetch(`${base}/plugins/workbench/api/bytes?root=workspace&path=page.html`)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
  })

  it('404s an unknown route', async () => {
    const { status, body } = await call('nope')
    expect(status).toBe(404)
    expect(body).toMatchObject({ code: 'unknown_route' })
  })

  it('400s a missing parameter', async () => {
    const { status, body } = await call('read?root=workspace')
    expect(status).toBe(400)
    expect(body).toMatchObject({ code: 'missing_param' })
  })
})

describe('write routes', () => {
  it('creates a directory, writes, renames, and deletes', async () => {
    expect((await call('mkdir?root=workspace&path=made', { method: 'POST' })).status).toBe(200)
    expect((await call('write?root=workspace&path=made/a.txt', { method: 'PUT', body: 'first' })).status).toBe(200)
    expect(await readFile(join(workspace, 'made', 'a.txt'), 'utf8')).toBe('first')

    expect((await call('rename?root=workspace&path=made/a.txt&to=made/b.txt', { method: 'POST' })).status).toBe(200)
    expect(await readFile(join(workspace, 'made', 'b.txt'), 'utf8')).toBe('first')

    expect((await call('delete?root=workspace&path=made/b.txt', { method: 'DELETE' })).status).toBe(200)
    await expect(stat(join(workspace, 'made', 'b.txt'))).rejects.toThrow()

    expect((await call('delete?root=workspace&path=made&recursive=1', { method: 'DELETE' })).status).toBe(200)
  })

  it('a recursive delete does not follow a nested symlink out of the root', async () => {
    // The dangerous version of the write escape: `rm -r` on an in-root directory
    // that contains a symlink to an outside directory. rm must unlink the link,
    // not recurse through it and delete the outside data. Verified end to end.
    const outside = await mkdtemp(join(tmpdir(), 'wb-del-outside-'))
    await writeFile(join(outside, 'precious.txt'), 'keep me')
    await mkdir(join(workspace, 'victim'), { recursive: true })
    await writeFile(join(workspace, 'victim', 'inner.txt'), 'x')
    await symlink(outside, join(workspace, 'victim', 'nested-link'))

    const { status } = await call('delete?root=workspace&path=victim&recursive=1', { method: 'DELETE' })
    expect(status).toBe(200)
    await expect(stat(join(workspace, 'victim'))).rejects.toThrow()   // the dir is gone
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('keep me')  // the target survived
    await rm(outside, { recursive: true, force: true })
  })

  it('refuses to delete through a symlink that points outside the root', async () => {
    // A symlink whose (existing) target is outside resolves outside and is
    // refused — fail-closed. Deleting it would only unlink the link, but the
    // fence cannot tell that apart from a traversal, so it says no.
    const outside = await mkdtemp(join(tmpdir(), 'wb-del-esc-'))
    await writeFile(join(outside, 'file.txt'), 'data')
    await symlink(outside, join(workspace, 'out-link'))

    const { status, body } = await call('delete?root=workspace&path=out-link&recursive=1', { method: 'DELETE' })
    expect(status).toBe(403)
    expect(body).toMatchObject({ code: 'outside_root' })
    expect(await readFile(join(outside, 'file.txt'), 'utf8')).toBe('data')
    await rm(outside, { recursive: true, force: true })
  })

  it('refuses to write through a symlink that escapes the root', async () => {
    // A dangling symlink whose final component points outside every writable
    // root used to slip the fence: the target has no realpath, so resolution
    // anchored on the (in-root) parent and passed, then raw writeFile followed
    // the link. Confirmed in a browser — an upload planted a file in $HOME.
    const outside = await mkdtemp(join(tmpdir(), 'wb-outside-'))
    const escapeTarget = join(outside, 'planted.txt')
    await symlink(escapeTarget, join(workspace, 'escape.txt'))

    for (const route of ['upload', 'write'] as const) {
      const method = route === 'write' ? 'PUT' : 'POST'
      const { status, body } = await call(`${route}?root=workspace&path=escape.txt`, { method, body: 'pwned' })
      expect(status).toBe(403)
      expect(body).toMatchObject({ code: 'symlink_target' })
    }
    // Nothing was written where the link pointed, and the link is intact.
    await expect(stat(escapeTarget)).rejects.toThrow()
    expect((await lstat(join(workspace, 'escape.txt'))).isSymbolicLink()).toBe(true)
    await rm(outside, { recursive: true, force: true })
  })

  it('refuses mkdir at a path that is a symlink', async () => {
    await symlink(join(workspace, 'sub'), join(workspace, 'dirlink'))
    const { status, body } = await call('mkdir?root=workspace&path=dirlink', { method: 'POST' })
    expect(status).toBe(403)
    expect(body).toMatchObject({ code: 'symlink_target' })
  })

  it('still overwrites a regular file (the symlink guard is not overzealous)', async () => {
    await writeFile(join(workspace, 'plain.txt'), 'before')
    const { status } = await call('upload?root=workspace&path=plain.txt', { method: 'POST', body: 'after' })
    expect(status).toBe(200)
    expect(await readFile(join(workspace, 'plain.txt'), 'utf8')).toBe('after')
  })

  it('answers an over-cap upload with 413 rather than dropping the connection', async () => {
    // The body cap is enforced mid-stream, which aborts the request iterator —
    // the worry was that tearing down the request also tears down the socket,
    // turning "file too large" into an unexplained network error in the browser.
    // It does not: the response still lands, so the pane can word the failure.
    const oversize = new Uint8Array(MAX_WRITE_BYTES + 1024)
    const { status, body } = await call('upload?root=workspace&path=huge.bin', { method: 'POST', body: oversize })
    expect(status).toBe(413)
    expect(body).toMatchObject({ code: 'body_too_large' })
    // And nothing partial is left behind.
    await expect(stat(join(workspace, 'huge.bin'))).rejects.toThrow()
  })

  it('refuses a cross-origin mutating request', async () => {
    // A cross-site POST is sent even though its response cannot be read, so a
    // visited page could `upload` a file into the workspace. A forged Origin
    // that does not match the Host is the browser telling on itself.
    const response = await fetch(`${base}/plugins/workbench/api/upload?root=workspace&path=csrf.bin`, {
      method: 'POST',
      headers: { origin: 'http://evil.example.com' },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'cross_origin' })
    await expect(stat(join(workspace, 'csrf.bin'))).rejects.toThrow()
  })

  it('allows a mutating request whose origin matches the host', async () => {
    const origin = new URL(base).origin
    const response = await fetch(`${base}/plugins/workbench/api/upload?root=workspace&path=same-origin.bin`, {
      method: 'POST',
      headers: { origin },
      body: new Uint8Array([4, 5, 6]),
    })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await readFile(join(workspace, 'same-origin.bin')))).toEqual(new Uint8Array([4, 5, 6]))
  })

  it('uploads raw bytes verbatim', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])
    const { status } = await call('upload?root=workspace&path=up.bin', { method: 'POST', body: bytes })
    expect(status).toBe(200)
    expect(new Uint8Array(await readFile(join(workspace, 'up.bin')))).toEqual(bytes)
  })

  it('needs recursive=1 to remove a directory', async () => {
    await mkdir(join(workspace, 'keep'), { recursive: true })
    const { status, body } = await call('delete?root=workspace&path=keep', { method: 'DELETE' })
    expect(status).toBe(400)
    expect(body).toMatchObject({ code: 'is_directory' })
  })

  it('refuses a protected name', async () => {
    const { status, body } = await call('write?root=workspace&path=.env', { method: 'PUT', body: 'x' })
    expect(status).toBe(403)
    expect(body).toMatchObject({ code: 'protected_file' })
  })

  it('refuses a rename whose destination is protected', async () => {
    await writeFile(join(workspace, 'ok.txt'), 'x')
    const { status, body } = await call('rename?root=workspace&path=ok.txt&to=.env', { method: 'POST' })
    expect(status).toBe(403)
    expect(body).toMatchObject({ code: 'protected_file' })
  })

  it('refuses traversal on write', async () => {
    const { status, body } = await call('write?root=workspace&path=../escape.txt', { method: 'PUT', body: 'x' })
    expect(status).toBe(400)
    expect(body).toMatchObject({ code: 'invalid_path' })
  })
})

describe('when writes are disabled', () => {
  let readOnlyServer: Server
  let readOnlyBase: string

  beforeAll(async () => {
    const handler = createApiHandler(fakeCtx(), {
      readRoots: [], loopbackOnly: true, maxListEntries: 100, writeEnabled: false, ptyEnabled: false,
    })
    readOnlyServer = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(resolve => readOnlyServer.listen(0, '127.0.0.1', resolve))
    const address = readOnlyServer.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    readOnlyBase = `http://127.0.0.1:${String(address.port)}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => readOnlyServer.close(() => { resolve() }))
  })

  it('refuses every mutating method and advertises the flag', async () => {
    const health = await (await fetch(`${readOnlyBase}/plugins/workbench/api/health`)).json() as { writeEnabled: boolean }
    expect(health.writeEnabled).toBe(false)

    for (const [route, method] of [['write?root=workspace&path=x.txt', 'PUT'], ['mkdir?root=workspace&path=x', 'POST'], ['delete?root=workspace&path=x', 'DELETE']] as const) {
      const response = await fetch(`${readOnlyBase}/plugins/workbench/api/${route}`, { method })
      expect(response.status).toBe(403)
      expect((await response.json() as { code: string }).code).toBe('write_disabled')
    }
  })

  it('still allows reads', async () => {
    const response = await fetch(`${readOnlyBase}/plugins/workbench/api/list?root=workspace`)
    expect(response.status).toBe(200)
  })
})

describe('symlinks in a listing', () => {
  // The shared server caps listings at 2 entries; this block needs the whole
  // directory, so it runs its own.
  let linkServer: Server
  let linkBase: string

  beforeAll(async () => {
    const handler = createApiHandler(fakeCtx(), {
      readRoots: [], loopbackOnly: true, maxListEntries: 100, writeEnabled: false, ptyEnabled: false,
    })
    linkServer = createServer((req, res) => { void handler(req, res) })
    await new Promise<void>(resolve => linkServer.listen(0, '127.0.0.1', resolve))
    const address = linkServer.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    linkBase = `http://127.0.0.1:${String(address.port)}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => linkServer.close(() => { resolve() }))
  })

  const linkCall = async (path: string): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${linkBase}/plugins/workbench/api/${path}`)
    return { status: response.status, body: await response.json().catch(() => null) as unknown }
  }

  it('says what each link resolves to', async () => {
    const { body } = await linkCall('list?root=workspace&path=links')
    const byName = Object.fromEntries(
      (body as { entries: { name: string; type: string; linkTarget?: string }[] }).entries
        .map(entry => [entry.name, entry]),
    )
    expect(byName['to-dir']).toMatchObject({ type: 'symlink', linkTarget: 'directory' })
    expect(byName['to-file']).toMatchObject({ type: 'symlink', linkTarget: 'file' })
    expect(byName['broken']).toMatchObject({ type: 'symlink', linkTarget: 'broken' })
  })

  it('refuses to read a symlinked directory as a file, with a 4xx not a 500', async () => {
    // Reported `internal` before: lstat sees a symlink, not a directory, so
    // the check passed and the fs seam threw.
    const { status, body } = await linkCall('read?root=workspace&path=links/to-dir')
    expect(status).toBe(400)
    expect(body).toMatchObject({ code: 'not_a_file' })
  })

  it('reads through a symlink to a file', async () => {
    const { status, body } = await linkCall('read?root=workspace&path=links/to-file')
    expect(status).toBe(200)
    expect(body).toMatchObject({ content: 'hello' })
  })

  it('404s a broken link rather than failing oddly', async () => {
    const { status } = await linkCall('read?root=workspace&path=links/broken')
    expect(status).toBe(404)
  })
})

describe('the root is not a target', () => {
  // The whole workspace was deletable through an empty path: it resolves to the
  // root, every guard passed, and the answer was {ok:true}.
  it('refuses to delete a root', async () => {
    const { status, body } = await call('delete?root=workspace&path=&recursive=1', { method: 'DELETE' })
    expect(status).toBe(400)
    expect(body).toMatchObject({ code: 'root_is_not_a_target' })
    await expect(stat(workspace)).resolves.toBeDefined()
  })

  it('refuses to write over a root', async () => {
    const { status, body } = await call('write?root=workspace&path=', { method: 'PUT', body: 'x' })
    expect(status).toBe(400)
    expect(body).toMatchObject({ code: 'root_is_not_a_target' })
  })

  it('refuses to mkdir a root', async () => {
    const { status } = await call('mkdir?root=workspace&path=', { method: 'POST' })
    expect(status).toBe(400)
  })

  it('refuses to rename a root, or onto one', async () => {
    expect((await call('rename?root=workspace&path=&to=elsewhere', { method: 'POST' })).status).toBe(400)
    await writeFile(join(workspace, 'movable.txt'), 'x')
    const onto = await call('rename?root=workspace&path=movable.txt&to=', { method: 'POST' })
    expect(onto.status).toBe(400)
    expect(onto.body).toMatchObject({ code: 'root_is_not_a_target' })
  })

  it('still lets a listing show the root', async () => {
    expect((await call('list?root=workspace&path=')).status).toBe(200)
  })

  it('still deletes something inside the root', async () => {
    await mkdir(join(workspace, 'disposable'), { recursive: true })
    expect((await call('delete?root=workspace&path=disposable&recursive=1', { method: 'DELETE' })).status).toBe(200)
  })
})

describe('overwriting', () => {
  // POSIX rename() replaces silently; that lost "months of work" in a probe.
  it('refuses a rename onto an existing name', async () => {
    await writeFile(join(workspace, 'draft.txt'), 'the new thing')
    await writeFile(join(workspace, 'important.txt'), 'MONTHS OF WORK')
    const { status, body } = await call('rename?root=workspace&path=draft.txt&to=important.txt', { method: 'POST' })
    expect(status).toBe(409)
    expect(body).toMatchObject({ code: 'destination_exists' })
    expect(await readFile(join(workspace, 'important.txt'), 'utf8')).toBe('MONTHS OF WORK')
    expect(await readFile(join(workspace, 'draft.txt'), 'utf8')).toBe('the new thing')
  })

  it('replaces when the caller asks for it', async () => {
    const { status } = await call('rename?root=workspace&path=draft.txt&to=important.txt&overwrite=1', { method: 'POST' })
    expect(status).toBe(200)
    expect(await readFile(join(workspace, 'important.txt'), 'utf8')).toBe('the new thing')
  })

  it('reports whether an upload replaced something', async () => {
    const fresh = await call('upload?root=workspace&path=new-upload.bin', { method: 'POST', body: 'a' })
    expect(fresh.body).toMatchObject({ ok: true, overwrote: false })
    const again = await call('upload?root=workspace&path=new-upload.bin', { method: 'POST', body: 'b' })
    expect(again.body).toMatchObject({ ok: true, overwrote: true })
  })

  it('reports the same for a write', async () => {
    const fresh = await call('write?root=workspace&path=new-write.txt', { method: 'PUT', body: 'a' })
    expect(fresh.body).toMatchObject({ overwrote: false })
    const again = await call('write?root=workspace&path=new-write.txt', { method: 'PUT', body: 'b' })
    expect(again.body).toMatchObject({ overwrote: true })
  })
})

describe('destructive edges that must stay safe', () => {
  it('recursive delete unlinks a symlink instead of walking into it', async () => {
    // If rm ever followed links, deleting a folder containing a shortcut to
    // your documents would take the documents with it.
    const outside = await mkdtemp(join(tmpdir(), 'wb-outside-'))
    await writeFile(join(outside, 'precious.txt'), 'DO NOT DELETE')
    await mkdir(join(workspace, 'doomed'), { recursive: true })
    await symlink(outside, join(workspace, 'doomed', 'link-outside'))

    const { status } = await call('delete?root=workspace&path=doomed&recursive=1', { method: 'DELETE' })
    expect(status).toBe(200)
    expect(await readdir(outside)).toEqual(['precious.txt'])
    expect(await readFile(join(outside, 'precious.txt'), 'utf8')).toBe('DO NOT DELETE')
    await rm(outside, { recursive: true, force: true })
  })

  it('an interrupted upload leaves the existing file alone', async () => {
    // The body is buffered before anything is written, so a dropped request
    // cannot truncate what was already there. Streaming straight to disk would
    // break this, which is what the test is here to notice.
    await writeFile(join(workspace, 'existing.bin'), 'ORIGINAL CONTENT THAT MUST SURVIVE')
    const controller = new AbortController()
    const body = new ReadableStream({
      start(chunk) {
        chunk.enqueue(new TextEncoder().encode('PARTIAL'))
        setTimeout(() => { controller.abort() }, 30)
      },
    })
    await expect(fetch(`${base}/plugins/workbench/api/upload?root=workspace&path=existing.bin`, {
      method: 'POST', body, signal: controller.signal, duplex: 'half',
    } as RequestInit)).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(await readFile(join(workspace, 'existing.bin'), 'utf8')).toBe('ORIGINAL CONTENT THAT MUST SURVIVE')
  })

  it('a filename with CRLF cannot inject a response header', async () => {
    const nasty = 'evil\r\nX-Injected: yes.txt'
    await writeFile(join(workspace, nasty), 'x')
    const response = await fetch(`${base}/plugins/workbench/api/bytes?root=workspace&path=${encodeURIComponent(nasty)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-injected')).toBeNull()
    expect(response.headers.get('content-disposition')).not.toContain('\n')
    await rm(join(workspace, nasty), { force: true })
  })

  it('answers HEAD on the bytes route without a body', async () => {
    const response = await fetch(`${base}/plugins/workbench/api/bytes?root=workspace&path=pic.png`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('4')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })
})

describe('search edges', () => {
  it('searching a file rather than a directory returns nothing instead of failing', async () => {
    const { status, body } = await call('search?root=workspace&path=utf8.txt&q=any')
    expect(status).toBe(200)
    expect(body).toMatchObject({ hits: [] })
  })

  it('refuses a one-character query', async () => {
    const { status, body } = await call('search?root=workspace&q=a')
    expect(status).toBe(400)
    expect(body).toMatchObject({ code: 'query_too_short' })
  })

  it('trims the query before judging its length', async () => {
    const { status } = await call('search?root=workspace&q=%20%20a%20%20')
    expect(status).toBe(400)
  })

  it('finds a file from the workspace root', async () => {
    const { body } = await call('search?root=workspace&q=note')
    expect((body as { hits: { path: string }[] }).hits.map(hit => hit.path)).toContain('sub/note.txt')
  })
})

describe('lost updates', () => {
  it('hands out a version with the contents', async () => {
    await writeFile(join(workspace, 'shared.txt'), 'first')
    const { body } = await call('read?root=workspace&path=shared.txt')
    expect((body as { version: string | null }).version).toBeTruthy()
  })

  it('hands back the new version so the editor need not re-read', async () => {
    await writeFile(join(workspace, 'echoed.txt'), 'first')
    const read = await call('read?root=workspace&path=echoed.txt')
    const version = (read.body as { version: string }).version
    const write = await call(`write?root=workspace&path=echoed.txt&version=${encodeURIComponent(version)}`, {
      method: 'PUT', body: 'second',
    })
    const returned = (write.body as { version: string | null }).version
    expect(returned).toBeTruthy()
    expect(returned).not.toBe(version)
    // and it matches what a fresh read would report
    const after = await call('read?root=workspace&path=echoed.txt')
    expect((after.body as { version: string }).version).toBe(returned)
  })

  it('accepts a write whose version still matches', async () => {
    const read = await call('read?root=workspace&path=shared.txt')
    const version = (read.body as { version: string }).version
    const { status } = await call(`write?root=workspace&path=shared.txt&version=${encodeURIComponent(version)}`, {
      method: 'PUT', body: 'second',
    })
    expect(status).toBe(200)
    expect(await readFile(join(workspace, 'shared.txt'), 'utf8')).toBe('second')
  })

  it('refuses a write based on a version that moved on', async () => {
    const read = await call('read?root=workspace&path=shared.txt')
    const version = (read.body as { version: string }).version
    // somebody else saves in between
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeFile(join(workspace, 'shared.txt'), 'theirs')

    const { status, body } = await call(`write?root=workspace&path=shared.txt&version=${encodeURIComponent(version)}`, {
      method: 'PUT', body: 'mine',
    })
    expect(status).toBe(409)
    expect(body).toMatchObject({ code: 'stale_version' })
    expect(await readFile(join(workspace, 'shared.txt'), 'utf8')).toBe('theirs')
  })

  it('still allows an unconditional write when no version is given', async () => {
    const { status } = await call('write?root=workspace&path=shared.txt', { method: 'PUT', body: 'forced' })
    expect(status).toBe(200)
    expect(await readFile(join(workspace, 'shared.txt'), 'utf8')).toBe('forced')
  })
})
