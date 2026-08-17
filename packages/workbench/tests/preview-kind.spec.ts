/** How the preview pane routes a filename, and how sizes read. */

import { describe, expect, it } from 'vitest'
import { formatSize, htmlSandbox, languageOf, previewKind } from '../src/client/preview-kind.ts'

describe('previewKind', () => {
  it.each(['photo.png', 'a.JPG', 'icon.svg', 'x.webp'])('renders %s as an image', (name) => {
    expect(previewKind(name)).toBe('image')
  })

  it.each(['README.md', 'notes.markdown'])('renders %s as markdown', (name) => {
    expect(previewKind(name)).toBe('markdown')
  })

  it.each(['page.html', 'index.htm', 'Report.HTML'])('renders %s as html', (name) => {
    expect(previewKind(name)).toBe('html')
  })

  it.each(['main.ts', 'Makefile', 'noext', '.gitignore'])('renders %s as text', (name) => {
    expect(previewKind(name)).toBe('text')
  })

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(previewKind('.env')).toBe('text')
  })
})

describe('htmlSandbox', () => {
  // This string is the entire trust boundary of the HTML preview, so its two
  // states are pinned here. The invariant that actually matters: whatever
  // tokens it grants, it must NEVER combine allow-scripts with allow-same-origin
  // — that pair lets the framed document reach back into the app's origin, which
  // is exactly the stored-XSS hole the bytes route was hardened against.
  it('is fully locked down when inert', () => {
    expect(htmlSandbox(false)).toBe('')
  })

  it('grants only allow-scripts when scripts are opted in', () => {
    expect(htmlSandbox(true)).toBe('allow-scripts')
  })

  it.each([false, true])('never grants allow-same-origin (runScripts=%s)', (runScripts) => {
    expect(htmlSandbox(runScripts)).not.toContain('allow-same-origin')
  })
})

describe('languageOf', () => {
  it('maps extensions to grammar ids', () => {
    expect(languageOf('main.tsx')).toBe('tsx')
    expect(languageOf('run.sh')).toBe('shell')
    expect(languageOf('conf.yml')).toBe('yaml')
  })

  it('recognises extensionless well-known files', () => {
    expect(languageOf('Dockerfile')).toBe('dockerfile')
    expect(languageOf('Makefile')).toBe('makefile')
  })

  it('is undefined for unknown types, which renders as plain monospace', () => {
    expect(languageOf('data.bin')).toBeUndefined()
    expect(languageOf('noext')).toBeUndefined()
  })
})

describe('formatSize', () => {
  it('switches units at the right thresholds', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
  })
})
