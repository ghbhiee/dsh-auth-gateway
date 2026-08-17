/** Recognizing file-link buttons, and the link preview's open/close rules. */

import { describe, expect, it } from 'vitest'
import { candidatePath, isPathLike, linkClick, type LinkPreviewSlice } from '../src/client/link-preview.ts'

describe('isPathLike', () => {
  it('accepts filenames and paths with an extension', () => {
    expect(isPathLike('report.html')).toBe(true)
    expect(isPathLike('sub/dir/report.html')).toBe(true)
    expect(isPathLike('/Users/me/dsh/详解.md')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isPathLike('')).toBe(false)
    expect(isPathLike('two words')).toBe(false)
    expect(isPathLike('README')).toBe(false)          // no extension
    expect(isPathLike('dir/')).toBe(false)            // no filename
    expect(isPathLike('https://x.dev/y.html')).toBe(false) // a URL, not a file
    expect(isPathLike('x'.repeat(600))).toBe(false)
  })
})

describe('candidatePath', () => {
  it('takes a full-path text (inline mention shape)', () => {
    expect(candidatePath('', '/ws/report.html')).toBe('/ws/report.html')
  })

  it('takes the title when the text is its basename (chip shape)', () => {
    expect(candidatePath('/ws/sub/report.html', 'report.html')).toBe('/ws/sub/report.html')
  })

  it('rejects a path-shaped title on an unrelated label', () => {
    // The title is then a tooltip on some other control, not a file link.
    expect(candidatePath('/ws/report.html', 'Delete')).toBeNull()
  })

  it('rejects ordinary buttons', () => {
    expect(candidatePath('', 'Copy')).toBeNull()
    expect(candidatePath('Copy code', 'Copy')).toBeNull()
  })
})

describe('linkClick', () => {
  const closed: LinkPreviewSlice = { open: false, linkPreviewPath: null, openBeforeLink: false }

  it('opens the preview from a closed panel', () => {
    const next = linkClick(closed, '/ws/a.html')
    expect(next).toMatchObject({ open: true, linkPreviewPath: '/ws/a.html', openBeforeLink: false, opens: true })
  })

  it('clicking the same link again closes back to the closed panel', () => {
    const opened = linkClick(closed, '/ws/a.html')
    const next = linkClick(opened, '/ws/a.html')
    expect(next).toMatchObject({ open: false, linkPreviewPath: null, opens: false })
  })

  it('restores an already-open panel instead of closing it', () => {
    const wasOpen: LinkPreviewSlice = { open: true, linkPreviewPath: null, openBeforeLink: false }
    const opened = linkClick(wasOpen, '/ws/a.html')
    const next = linkClick(opened, '/ws/a.html')
    expect(next.open).toBe(true) // the panel was open before the link took it over
    expect(next.linkPreviewPath).toBeNull()
  })

  it('a different link switches the preview and keeps the restore point', () => {
    const opened = linkClick(closed, '/ws/a.html')
    const switched = linkClick(opened, '/ws/b.html')
    expect(switched).toMatchObject({ open: true, linkPreviewPath: '/ws/b.html', openBeforeLink: false, opens: true })
    // Closing from the second file still lands where the user actually was.
    const closedAgain = linkClick(switched, '/ws/b.html')
    expect(closedAgain.open).toBe(false)
  })
})
