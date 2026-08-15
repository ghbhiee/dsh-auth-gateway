/** Filename search: what it finds, what it skips, and where it stops. */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { searchNames } from '../src/search.ts'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-search-'))
  await mkdir(join(root, 'src', 'client'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'junk'), { recursive: true })
  await mkdir(join(root, '.git', 'objects'), { recursive: true })
  await mkdir(join(root, 'deep', 'a', 'b', 'c'), { recursive: true })
  await writeFile(join(root, 'README.md'), '')
  await writeFile(join(root, 'src', 'index.ts'), '')
  await writeFile(join(root, 'src', 'client', 'Widget.tsx'), '')
  await writeFile(join(root, 'node_modules', 'junk', 'index.ts'), '')
  await writeFile(join(root, '.git', 'objects', 'index.ts'), '')
  await writeFile(join(root, 'deep', 'a', 'b', 'c', 'buried-index.ts'), '')
  await symlink(join(root, 'src'), join(root, 'loop'))
  // Stored decomposed, the way macOS writes it.
  await writeFile(join(root, 'cafe\u0301-notes.md'), '')
})

afterAll(async () => { await rm(root, { recursive: true, force: true }) })

const paths = async (query: string, limits?: Parameters<typeof searchNames>[2]): Promise<string[]> =>
  (await searchNames(root, query, limits)).hits.map(hit => hit.path).sort()

describe('matching', () => {
  it('finds files by substring, case-insensitively', async () => {
    expect(await paths('widget')).toEqual(['src/client/Widget.tsx'])
  })

  it('finds directories too, flagged as such', async () => {
    const { hits } = await searchNames(root, 'client')
    expect(hits).toEqual([{ path: 'src/client', name: 'client', isDirectory: true }])
  })

  it('returns paths relative to the root, with forward slashes', async () => {
    expect(await paths('README')).toEqual(['README.md'])
  })

  it('reaches nested files', async () => {
    expect(await paths('buried')).toEqual(['deep/a/b/c/buried-index.ts'])
  })
})

describe('what it refuses to walk', () => {
  it('skips node_modules and .git', async () => {
    const found = await paths('index.ts')
    expect(found).toContain('src/index.ts')
    expect(found).toContain('deep/a/b/c/buried-index.ts')
    expect(found.some(path => path.startsWith('node_modules/'))).toBe(false)
    expect(found.some(path => path.startsWith('.git/'))).toBe(false)
  })

  it('lists a symlinked directory but does not descend it, so a cycle cannot hang the walk', async () => {
    const { hits } = await searchNames(root, 'loop')
    expect(hits.map(hit => hit.path)).toEqual(['loop'])
    // Nothing underneath the link is reported through it.
    const all = await paths('index.ts')
    expect(all.some(path => path.startsWith('loop/'))).toBe(false)
  })
})

describe('unicode', () => {
  const COMPOSED = 'caf\u00e9'        // café, one code point for é
  const DECOMPOSED = 'cafe\u0301'     // café, "e" plus a combining acute — how macOS stores it

  it('matches a composed query against a decomposed filename', async () => {
    const hits = await paths(COMPOSED)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.normalize('NFC')).toBe(`${COMPOSED}-notes.md`)
  })

  it('matches the decomposed spelling too', async () => {
    expect(await paths(DECOMPOSED)).toHaveLength(1)
  })

  it('still does not match a different word', async () => {
    expect(await paths('caff\u00e8')).toEqual([])
  })
})

describe('limits', () => {
  it('stops at maxResults and says it truncated', async () => {
    const result = await searchNames(root, '.ts', { maxResults: 1, maxScanned: 10000, budgetMs: 2000 })
    expect(result.hits).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('stops at maxScanned', async () => {
    const result = await searchNames(root, 'nothing-matches-this', { maxResults: 200, maxScanned: 2, budgetMs: 2000 })
    expect(result.truncated).toBe(true)
    expect(result.scanned).toBeLessThanOrEqual(3)
  })

  it('stops when the time budget is gone', async () => {
    // A clock that jumps past the deadline on its second read.
    let reads = 0
    const now = (): number => (reads++ === 0 ? 0 : 10_000)
    const result = await searchNames(root, 'index', { maxResults: 200, maxScanned: 10000, budgetMs: 100 }, now)
    expect(result.truncated).toBe(true)
  })

  it('reports untruncated when everything fits', async () => {
    const result = await searchNames(root, 'README')
    expect(result.truncated).toBe(false)
  })
})

describe('robustness', () => {
  it('returns nothing rather than throwing for a missing root', async () => {
    const result = await searchNames(join(root, 'absent'), 'x')
    expect(result).toMatchObject({ hits: [], truncated: false })
  })
})
