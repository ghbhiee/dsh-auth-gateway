/** Mapping a session cwd onto a host root + subpath. */

import { describe, expect, it } from 'vitest'
import { rootForCwd } from '../src/client/session-root.ts'
import type { Root } from '../src/client/api.ts'

const roots: Root[] = [
  { id: 'workspace', path: '/Users/hongbo', label: 'hongbo' },
  { id: 'extra-0', path: '/data/notes', label: 'notes' },
]

describe('rootForCwd', () => {
  it('maps a cwd under a root to that root and the relative path', () => {
    expect(rootForCwd(roots, '/Users/hongbo/dsh/plugins')).toEqual({ rootId: 'workspace', path: 'dsh/plugins' })
  })

  it('maps the root directory itself to an empty path', () => {
    expect(rootForCwd(roots, '/Users/hongbo')).toEqual({ rootId: 'workspace', path: '' })
  })

  it('chooses the correct root among several', () => {
    expect(rootForCwd(roots, '/data/notes/today.md')).toEqual({ rootId: 'extra-0', path: 'today.md' })
  })

  it('prefers the deepest root when one nests inside another', () => {
    const nested: Root[] = [
      { id: 'workspace', path: '/ws', label: 'ws' },
      { id: 'extra-0', path: '/ws/project', label: 'project' },
    ]
    expect(rootForCwd(nested, '/ws/project/src')).toEqual({ rootId: 'extra-0', path: 'src' })
  })

  it('returns null for a cwd outside every root', () => {
    expect(rootForCwd(roots, '/tmp/elsewhere')).toBeNull()
  })

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    // "/Users/hongbolong" starts with "/Users/hongbo" as a string but is not
    // under it — the trailing-slash check is what stops the false match.
    expect(rootForCwd(roots, '/Users/hongbolong/x')).toBeNull()
  })

  it('returns null when the cwd is unknown', () => {
    expect(rootForCwd(roots, undefined)).toBeNull()
    expect(rootForCwd(roots, '')).toBeNull()
  })
})
