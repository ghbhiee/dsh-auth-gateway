// @vitest-environment jsdom
/** The preview pane: how each kind renders, and the edit/save round trip. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePreview, type FilePreviewProps } from '../src/client/FilePreview.tsx'

const labels: FilePreviewProps['labels'] = {
  loading: 'Loading…', binary: 'Binary file', notUtf8: 'Not UTF-8', empty: 'Empty file',
  edit: 'Edit', save: 'Save', cancel: 'Cancel', saved: 'Saved', staleVersion: 'Save refused', changedOnDisk: 'Changed on disk', reload: 'Reload',
  htmlViewSource: 'View source', htmlViewRendered: 'View rendered', htmlEnableScripts: 'Enable scripts', htmlDisableScripts: 'Disable scripts',
}

/** Requests the pane made, so a test can assert the write went out. */
let requests: { url: string; method: string; body: string }[]
let readBody: { status: number; payload: unknown }
/** What /stat reports; a test moves this to simulate an outside edit. */
let statVersion = 'v1'
/** When true, the host refuses writes as stale. */
let writeConflicts = false

function stubFetch(): void {
  requests = []
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://host')
    requests.push({ url: url.pathname + url.search, method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    if (url.pathname.endsWith('/stat')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ type: 'file', size: 5, version: statVersion }),
        text: () => Promise.resolve('{}'),
      } as Response)
    }
    const isWrite = url.pathname.endsWith('/write')
    const ok = url.pathname.endsWith('/read') ? readBody.status === 200 : !(isWrite && writeConflicts)
    const payload = url.pathname.endsWith('/read')
      ? readBody.payload
      : isWrite && writeConflicts
        ? { code: 'stale_version', error: 'changed' }
        : isWrite
          ? { ok: true, version: statVersion }
          : { ok: true }
    return Promise.resolve({
      ok,
      status: ok ? 200 : (isWrite ? 409 : readBody.status),
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    } as Response)
  }))
}

function show(overrides: Partial<FilePreviewProps> = {}) {
  const props: FilePreviewProps = {
    root: 'workspace', path: 'notes.txt', name: 'notes.txt',
    writeEnabled: true, onSaved: vi.fn(), labels,
    ...overrides,
  }
  render(<FilePreview {...props} />)
  return props
}

beforeEach(() => {
  writeConflicts = false
  statVersion = 'v1'
  readBody = { status: 200, payload: { path: 'notes.txt', size: 5, content: 'hello', version: 'v1' } }
  stubFetch()
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('rendering by kind', () => {
  it('shows text through the read block', async () => {
    show()
    await waitFor(() => { expect(screen.getByText('hello')).toBeDefined() })
  })

  it('renders markdown rather than source', async () => {
    readBody = { status: 200, payload: { path: 'a.md', size: 9, content: '# Title' } }
    show({ path: 'a.md', name: 'a.md' })
    await waitFor(() => { expect(screen.getByText('Title').tagName).toBe('H1') })
  })

  it('shows an image straight from the bytes route, with no read call', async () => {
    show({ path: 'pic.png', name: 'pic.png' })
    const img = await screen.findByAltText('pic.png')
    expect(img.getAttribute('src')).toContain('/bytes?root=workspace&path=pic.png')
    expect(requests.some(request => request.url.includes('/read'))).toBe(false)
  })

  it('explains a binary file instead of showing bytes', async () => {
    readBody = { status: 415, payload: { code: 'binary_file', error: 'not text' } }
    show({ path: 'x.dat', name: 'x.dat' })
    await waitFor(() => { expect(screen.getByText('Binary file')).toBeDefined() })
  })

  it('says so when the file is empty', async () => {
    readBody = { status: 200, payload: { path: 'e.txt', size: 0, content: '' } }
    show({ path: 'e.txt', name: 'e.txt' })
    await waitFor(() => { expect(screen.getByText('Empty file')).toBeDefined() })
  })
})

describe('html preview', () => {
  // A workspace .html is a file nobody here wrote (a cloned repo, an agent's
  // output). This mirrors the bytes-route "script the app origin" test on the
  // client side: the frame is the trust boundary, so its sandbox is asserted.
  const hostile = '<h1>hi</h1><script>parent.postMessage(document.cookie,"*")</script>'

  async function showHtml() {
    readBody = { status: 200, payload: { path: 'page.html', size: hostile.length, content: hostile, version: 'v1' } }
    show({ path: 'page.html', name: 'page.html' })
    return await screen.findByTitle('page.html') as HTMLIFrameElement
  }

  it('renders HTML in a sandboxed iframe, not as executable source', async () => {
    const frame = await showHtml()
    // The document rides in srcdoc, and the frame is present as a real iframe.
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('srcdoc')).toBe(hostile)
  })

  it('defaults to inert: sandboxed with no script permission', async () => {
    const frame = await showHtml()
    expect(frame.hasAttribute('sandbox')).toBe(true)
    expect(frame.getAttribute('sandbox')).toBe('')
  })

  it('never combines allow-scripts with allow-same-origin, in either mode', async () => {
    const frame = await showHtml()
    // Inert.
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
    // Opt into scripts, then re-read the attribute.
    fireEvent.click(screen.getByText('Enable scripts'))
    await waitFor(() => { expect(screen.getByTitle('page.html').getAttribute('sandbox')).toBe('allow-scripts') })
    expect(screen.getByTitle('page.html').getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('remounts the frame when scripts are toggled, so the new sandbox loads', async () => {
    // Mutating `sandbox` on a live srcdoc frame does not re-load it, so the
    // opt-in would be a no-op without a remount. A fresh element proves it.
    const before = await showHtml()
    fireEvent.click(screen.getByText('Enable scripts'))
    await waitFor(() => { expect(screen.getByTitle('page.html').getAttribute('sandbox')).toBe('allow-scripts') })
    expect(screen.getByTitle('page.html')).not.toBe(before)
  })

  it('can show the source, and back to the rendered frame', async () => {
    await showHtml()
    fireEvent.click(screen.getByText('View source'))
    // The read block shows the markup as text now, no iframe.
    await waitFor(() => { expect(screen.queryByTitle('page.html')).toBeNull() })
    fireEvent.click(screen.getByText('View rendered'))
    await waitFor(() => { expect(screen.getByTitle('page.html')).toBeDefined() })
  })

  it('resets scripts back off when the file changes', async () => {
    // Re-render the SAME instance with a new path, so the reset effect (keyed on
    // root/path) actually runs — a fresh mount would start off regardless.
    readBody = { status: 200, payload: { path: 'page.html', size: hostile.length, content: hostile, version: 'v1' } }
    const base: FilePreviewProps = {
      root: 'workspace', path: 'page.html', name: 'page.html',
      writeEnabled: true, onSaved: vi.fn(), labels,
    }
    const { rerender } = render(<FilePreview {...base} />)
    await screen.findByTitle('page.html')
    fireEvent.click(screen.getByText('Enable scripts'))
    await waitFor(() => { expect(screen.getByTitle('page.html').getAttribute('sandbox')).toBe('allow-scripts') })

    // Switch to a different HTML file: the opt-in must not carry over.
    const other = '<p>other</p>'
    readBody = { status: 200, payload: { path: 'other.html', size: other.length, content: other, version: 'v1' } }
    rerender(<FilePreview {...base} path="other.html" name="other.html" />)
    const frame = await screen.findByTitle('other.html')
    expect(frame.getAttribute('sandbox')).toBe('')
  })
})

describe('editing', () => {
  it('offers no Edit button when the host refuses writes', async () => {
    show({ writeEnabled: false })
    await waitFor(() => { expect(screen.getByText('hello')).toBeDefined() })
    expect(screen.queryByText('Edit')).toBeNull()
  })

  it('opens a textarea seeded with the file', async () => {
    show()
    fireEvent.click(await screen.findByText('Edit'))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('hello')
  })

  it('writes the draft and tells the browser to refresh', async () => {
    const props = show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello again' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => {
      const write = requests.find(request => request.url.includes('/write'))
      expect(write).toMatchObject({ method: 'PUT', body: 'hello again' })
    })
    await waitFor(() => { expect(props.onSaved).toHaveBeenCalled() })
  })

  it('saves on Cmd/Ctrl+S', async () => {
    show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'via shortcut' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 's', metaKey: true })
    await waitFor(() => {
      expect(requests.some(request => request.url.includes('/write') && request.body === 'via shortcut')).toBe(true)
    })
  })

  it('discards the draft on cancel without writing', async () => {
    show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discarded' } })
    fireEvent.click(screen.getByText('Cancel'))
    await waitFor(() => { expect(screen.queryByRole('textbox')).toBeNull() })
    expect(requests.some(request => request.url.includes('/write'))).toBe(false)
  })

  it('shows the saved marker after a write', async () => {
    show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => { expect(screen.getByText('Saved')).toBeDefined() })
  })
})

describe('encoding', () => {
  it('explains a non-UTF-8 file instead of leaking the raw error', async () => {
    readBody = { status: 415, payload: { code: 'not_utf8', error: 'File is text but not UTF-8' } }
    show({ path: 'gbk.txt', name: 'gbk.txt' })
    await waitFor(() => { expect(screen.getByText('Not UTF-8')).toBeDefined() })
  })
})

describe('concurrent edits', () => {
  it('sends the version it read, so the host can detect a lost update', async () => {
    show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => {
      expect(requests.some(request => request.url.includes('/write') && request.url.includes('version=v1'))).toBe(true)
    })
  })

  it('explains a refused save instead of pretending it worked', async () => {
    show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } })
    writeConflicts = true
    fireEvent.click(screen.getByText('Save'))
    // Two different situations, two different sentences: this one is "your
    // save was refused", not "the file changed while you type".
    await waitFor(() => { expect(screen.getByText('Save refused')).toBeDefined() })
    // the draft is still there, so the work is not lost
    expect(screen.getByRole('textbox')).toBeDefined()
  })

  it('offers a Reload after a refused save, since re-clicking the file would not re-read it', async () => {
    show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine' } })
    writeConflicts = true
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => { expect(screen.getByText('Save refused')).toBeDefined() })

    // The file on disk is now something else; Reload puts the editor on it.
    readBody = { status: 200, payload: { path: 'notes.txt', size: 9, content: 'theirs now', version: 'v2' } }
    statVersion = 'v2'
    writeConflicts = false
    fireEvent.click(screen.getByText('Reload'))

    // Editing continues, but seeded from the current file, not the stale draft.
    await waitFor(() => { expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('theirs now') })

    // And a save now carries the fresh version, so it is no longer refused.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'mine on top' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => {
      expect(requests.some(r => r.url.includes('/write') && r.url.includes('version=v2'))).toBe(true)
    })
    expect(screen.queryByText('Save refused')).toBeNull()
  })
})

describe('keeping the preview current', () => {
  it('reloads the file when it changes on disk', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    show()
    await waitFor(() => { expect(screen.getByText('hello')).toBeDefined() })

    // somebody else rewrites it
    statVersion = 'v2'
    readBody = { status: 200, payload: { path: 'notes.txt', size: 7, content: 'rewritten', version: 'v2' } }
    await vi.advanceTimersByTimeAsync(5200)
    await waitFor(() => { expect(screen.getByText('rewritten')).toBeDefined() })
    vi.useRealTimers()
  })

  it('never touches a draft: it says the file changed instead', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my unsaved work' } })

    statVersion = 'v2'
    readBody = { status: 200, payload: { path: 'notes.txt', size: 7, content: 'rewritten', version: 'v2' } }
    await vi.advanceTimersByTimeAsync(5200)

    await waitFor(() => { expect(screen.getByText('Changed on disk')).toBeDefined() })
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('my unsaved work')
    vi.useRealTimers()
  })

  it('leaves an unchanged file alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    show()
    await waitFor(() => { expect(screen.getByText('hello')).toBeDefined() })
    const readsBefore = requests.filter(request => request.url.includes('/read')).length
    await vi.advanceTimersByTimeAsync(11000)
    expect(requests.filter(request => request.url.includes('/read')).length).toBe(readsBefore)
    vi.useRealTimers()
  })
})

describe('a very long file', () => {
  const manyLines = Array.from({ length: 30000 }, (_, index) => `line ${String(index)}`).join('\n')

  it('lays out a window and says how much of the file it is showing', async () => {
    // Rendering all 30 000 lines costs 90 000 DOM nodes and ~10x the reflow
    // time of the windowed view, on every later re-render.
    readBody = { status: 200, payload: { path: 'big.txt', size: manyLines.length, content: manyLines, version: 'v1' } }
    show({ path: 'big.txt', name: 'big.txt' })
    await waitFor(() => { expect(screen.getByText('line 0')).toBeDefined() })
    expect(screen.queryByText('line 29999')).toBeNull()
    expect(screen.getByText(/30000/)).toBeDefined()
  })

  it('falls back from markdown rendering for an enormous document', async () => {
    // MarkdownText has no windowing, so a huge document would parse megabytes
    // on the main thread; the capped source view is the lesser evil.
    readBody = { status: 200, payload: { path: 'big.md', size: manyLines.length, content: manyLines, version: 'v1' } }
    show({ path: 'big.md', name: 'big.md' })
    await waitFor(() => { expect(screen.getByText('line 0')).toBeDefined() })
    expect(screen.getByText(/30000/)).toBeDefined()
  })

  it('still renders a normal markdown file as markdown', async () => {
    readBody = { status: 200, payload: { path: 'small.md', size: 9, content: '# Title', version: 'v1' } }
    show({ path: 'small.md', name: 'small.md' })
    await waitFor(() => { expect(screen.getByText('Title').tagName).toBe('H1') })
  })
})

describe('after saving', () => {
  it('keeps the version the host returned, so the next poll re-reads nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    show()
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'saved text' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => { expect(screen.getByText('Saved')).toBeDefined() })

    const readsAfterSave = requests.filter(request => request.url.includes('/read')).length
    await vi.advanceTimersByTimeAsync(11000)
    // stat still reports v1, which is what the write returned, so nothing to do
    expect(requests.filter(request => request.url.includes('/read')).length).toBe(readsAfterSave)
    vi.useRealTimers()
  })
})
