/** Pulling file-path candidates out of assistant prose. */

import { describe, expect, it } from 'vitest'
import { extractPathTokens, isPathToken } from '../src/client/artifact-paths.ts'

describe('isPathToken', () => {
  it('accepts filenames and paths with an extension', () => {
    expect(isPathToken('report.html')).toBe(true)
    expect(isPathToken('sub/dir/report.html')).toBe(true)
    expect(isPathToken('/Users/me/dsh/x.md')).toBe(true)
  })

  it('rejects things that are not a single filename', () => {
    expect(isPathToken('')).toBe(false)
    expect(isPathToken('a directory name')).toBe(false) // whitespace
    expect(isPathToken('README')).toBe(false)           // no extension
    expect(isPathToken('dir/')).toBe(false)             // no filename
    expect(isPathToken('x'.repeat(600))).toBe(false)    // absurdly long
    expect(isPathToken('http://x/y.html')).toBe(true)   // last segment ok — existence check drops it
  })
})

describe('extractPathTokens', () => {
  it('pulls inline-code paths out of prose', () => {
    const text = 'I created `dsh-web-profile.html` and updated `src/index.ts`.'
    expect(extractPathTokens(text)).toEqual(['dsh-web-profile.html', 'src/index.ts'])
  })

  it('strips surrounding punctuation from bare tokens', () => {
    const text = 'See report.html, and (data.json).'
    expect(extractPathTokens(text)).toEqual(['report.html', 'data.json'])
  })

  it('dedupes and keeps first-seen order', () => {
    const text = 'a.md then b.md then a.md again'
    expect(extractPathTokens(text)).toEqual(['a.md', 'b.md'])
  })

  it('ignores prose with no paths', () => {
    expect(extractPathTokens('Just some words, nothing to open here.')).toEqual([])
  })
})
