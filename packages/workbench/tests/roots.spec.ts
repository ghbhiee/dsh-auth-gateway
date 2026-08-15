/** The read fence: containment, traversal, and symlink escapes. */

import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError, composeRoots, isWithin, resolveInRoot, validateReadRoots } from '../src/roots.ts'

let root: string
let outside: string
let roots: ReturnType<typeof composeRoots>

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'wb-roots-'))
  root = join(base, 'root')
  outside = join(base, 'outside')
  await mkdir(join(root, 'sub'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'sub', 'file.txt'), 'hi')
  await writeFile(join(outside, 'secret.txt'), 'nope')
  await symlink(outside, join(root, 'escape-dir'))
  await symlink(join(outside, 'secret.txt'), join(root, 'escape-file.txt'))
  roots = composeRoots(root, [])
})

afterAll(async () => {
  await rm(join(root, '..'), { recursive: true, force: true })
})

describe('isWithin', () => {
  it('accepts the parent itself and its descendants', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c')).toBe(true)
  })

  it('rejects siblings and ancestors', () => {
    expect(isWithin('/a/b', '/a/bc')).toBe(false)
    expect(isWithin('/a/b', '/a')).toBe(false)
    expect(isWithin('/a/b', '/other')).toBe(false)
  })
})

describe('composeRoots', () => {
  it('puts the workspace first and skips relative extras', () => {
    const composed = composeRoots('/ws/project', ['/data/notes', 'relative/ignored'])
    expect(composed.map(entry => entry.id)).toEqual(['workspace', 'extra-0'])
    expect(composed[0]?.label).toBe('project')
  })
})

describe('resolveInRoot', () => {
  it('resolves a path inside the root', async () => {
    const { absolutePath } = await resolveInRoot(roots, 'workspace', 'sub/file.txt')
    expect(absolutePath).toBe(join(root, 'sub', 'file.txt'))
  })

  it('treats an empty path as the root itself', async () => {
    const { absolutePath } = await resolveInRoot(roots, 'workspace', '')
    expect(absolutePath).toBe(root)
  })

  it.each(['../outside', '../../etc', '/etc/passwd', 'sub/../../outside'])('rejects traversal: %s', async (path) => {
    await expect(resolveInRoot(roots, 'workspace', path)).rejects.toMatchObject({ code: 'invalid_path', status: 400 })
  })

  it('rejects a symlinked file pointing out of the root', async () => {
    await expect(resolveInRoot(roots, 'workspace', 'escape-file.txt'))
      .rejects.toMatchObject({ code: 'outside_root', status: 403 })
  })

  it('rejects a path reached through a symlinked directory', async () => {
    await expect(resolveInRoot(roots, 'workspace', 'escape-dir/secret.txt'))
      .rejects.toMatchObject({ code: 'outside_root', status: 403 })
  })

  it('rejects an unknown root', async () => {
    await expect(resolveInRoot(roots, 'nope', '')).rejects.toBeInstanceOf(ApiError)
  })

  it('404s a missing path by default', async () => {
    await expect(resolveInRoot(roots, 'workspace', 'sub/absent.txt'))
      .rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('allows a missing path when the caller is creating it', async () => {
    const { absolutePath } = await resolveInRoot(roots, 'workspace', 'sub/new.txt', { mustExist: false })
    expect(absolutePath).toBe(join(root, 'sub', 'new.txt'))
  })

  it('still fences a create target behind a symlinked parent', async () => {
    await expect(resolveInRoot(roots, 'workspace', 'escape-dir/new.txt', { mustExist: false }))
      .rejects.toMatchObject({ code: 'outside_root', status: 403 })
  })

  it('404s a create target whose parent does not exist', async () => {
    await expect(resolveInRoot(roots, 'workspace', 'absent-dir/new.txt', { mustExist: false }))
      .rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('validateReadRoots', () => {
  it('accepts an empty list and real directories', () => {
    expect(() => { validateReadRoots([]) }).not.toThrow()
    expect(() => { validateReadRoots([root]) }).not.toThrow()
  })

  it('rejects a relative path instead of dropping it quietly', () => {
    // composeRoots used to skip these, so a typo became an invisible no-op.
    expect(() => { validateReadRoots(['notes']) }).toThrowError(/absolute/)
  })

  it('rejects a directory that is not there', () => {
    expect(() => { validateReadRoots([join(root, 'absent')]) }).toThrowError(/does not exist/)
  })

  it('rejects a file used as a root', () => {
    expect(() => { validateReadRoots([join(root, 'sub', 'file.txt')]) }).toThrowError(/not a directory/)
  })

  it('names every bad entry at once, not just the first', () => {
    try {
      validateReadRoots(['relative', join(root, 'absent')])
      throw new Error('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('relative')
      expect(message).toContain('absent')
    }
  })
})
