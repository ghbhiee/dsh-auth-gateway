// @vitest-environment jsdom
/**
 * The browser pane against a stubbed host: what it shows, how it navigates,
 * and the split between marking an entry and opening it.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileBrowser, type FileBrowserLabels } from '../src/client/FileBrowser.tsx'

const labels: FileBrowserLabels = {
  loading: 'Loading…', empty: 'Empty', truncated: 'Truncated', binary: 'Binary', notUtf8: 'Not UTF-8',
  emptyFile: 'Empty file', selectFile: 'Pick a file', parent: 'Parent directory', back: 'Back',
  select: 'Select', open: 'Open', save: 'Save', edit: 'Edit', saved: 'Saved',
  newFile: 'New file', newFolder: 'New folder', upload: 'Upload', rename: 'Rename',
  delete: 'Delete', confirmDelete: 'Confirm delete?', create: 'OK', cancel: 'Cancel',
  namePlaceholder: 'Name', dropHint: 'Drop to upload',
  searchPlaceholder: 'Search filenames', noMatches: 'No matching files.',
  searchTruncated: 'Search stopped early', brokenLink: 'broken link', replaced: 'Replaced', uploadFailed: 'Failed', staleVersion: 'Changed on disk', changedOnDisk: 'Changed on disk', reload: 'Reload',
  htmlViewSource: 'View source', htmlViewRendered: 'View rendered', htmlEnableScripts: 'Enable scripts', htmlDisableScripts: 'Disable scripts',
  errors: {
    destination_exists: 'Already there', protected_file: 'Protected file', protected_path: 'Protected directory',
    sandbox_read_only: 'Read-only sandbox', write_disabled: 'Writing is off', outside_writable_root: 'Not writable here',
    outside_root: 'Outside the root', root_is_not_a_target: 'Not the root', symlink_target: 'Symlink target', body_too_large: 'Too large',
    file_too_large: 'File too large', not_found: 'Not found', invalid_path: 'Bad path',
    is_directory: 'That is a directory', not_a_file: 'Not a regular file', query_too_short: 'Query too short',
    stale_version: 'Changed on disk',
  },
}

let tree: Record<string, { name: string; type: 'file' | 'directory'; size: number; mtime: string }[]> = {
  '': [
    { name: 'sub', type: 'directory', size: 0, mtime: '2026-01-01T00:00:00.000Z' },
    { name: 'top.txt', type: 'file', size: 12, mtime: '2026-01-01T00:00:00.000Z' },
  ],
  sub: [
    { name: 'inner.md', type: 'file', size: 34, mtime: '2026-01-01T00:00:00.000Z' },
  ],
}

/** Requests the pane makes, so tests can assert on them. */
let calls: string[]

function stubFetch(writeEnabled: boolean): void {
  calls = []
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const url = new URL(input, 'http://host')
    calls.push(url.pathname + url.search)
    const json = (body: unknown): Response =>
      ({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }) as Response

    if (url.pathname.endsWith('/health')) return Promise.resolve(json({ ok: true, writeEnabled }))
    if (url.pathname.endsWith('/roots')) return Promise.resolve(json({ roots: [{ id: 'workspace', path: '/ws', label: 'ws' }] }))
    if (url.pathname.endsWith('/list')) {
      const path = url.searchParams.get('path') ?? ''
      return Promise.resolve(json({ root: 'workspace', path, absolutePath: `/ws/${path}`, entries: tree[path] ?? [], truncated: false }))
    }
    if (url.pathname.endsWith('/mkdir')) {
      return Promise.resolve({
        ok: false, status: 403,
        json: () => Promise.resolve({ code: 'protected_path', error: '.git/ cannot be modified through the workbench' }),
        text: () => Promise.resolve(''),
      } as Response)
    }
    if (url.pathname.endsWith('/upload')) {
      return Promise.resolve(json({ ok: true, overwrote: url.searchParams.get('path')?.includes('top.txt') === true }))
    }
    if (url.pathname.endsWith('/search')) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const all = [
        { path: 'top.txt', name: 'top.txt', isDirectory: false },
        { path: 'sub/inner.md', name: 'inner.md', isDirectory: false },
        { path: 'sub', name: 'sub', isDirectory: true },
      ]
      const hits = all.filter(hit => hit.path.toLowerCase().includes(q))
      return Promise.resolve(json({ hits, truncated: q === 'wide' }))
    }
    if (url.pathname.endsWith('/read')) return Promise.resolve(json({ path: 'x', size: 3, content: '# hi' }))
    return Promise.resolve(json({}))
  }))
}

const freshTree = () => ({
  '': [
    { name: 'sub', type: 'directory' as const, size: 0, mtime: '2026-01-01T00:00:00.000Z' },
    { name: 'top.txt', type: 'file' as const, size: 12, mtime: '2026-01-01T00:00:00.000Z' },
  ],
  sub: [{ name: 'inner.md', type: 'file' as const, size: 34, mtime: '2026-01-01T00:00:00.000Z' }],
})

beforeEach(() => { tree = freshTree(); stubFetch(false) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('listing', () => {
  it('shows the root listing, directories first', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('sub')).toBeDefined() })
    expect(screen.getByText('top.txt')).toBeDefined()
  })

  it('shows a file size but not a directory size', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('12 B')).toBeDefined() })
  })

  it('navigates into a directory and back out', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('sub')).toBeDefined() })
    fireEvent.click(screen.getByText('sub'))
    await waitFor(() => { expect(screen.getByText('inner.md')).toBeDefined() })
    fireEvent.click(screen.getByText('Parent directory'))
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
  })

  it('asks the host for the nested path when navigating', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('sub')).toBeDefined() })
    fireEvent.click(screen.getByText('sub'))
    await waitFor(() => { expect(calls.some(call => call.includes('list?root=workspace&path=sub'))).toBe(true) })
  })
})

describe('session directory', () => {
  it('roots the browser at the active session cwd on load', async () => {
    // cwd /ws/sub sits under the /ws root, so the browser opens straight into
    // sub rather than at the root.
    render(<FileBrowser labels={labels} sessionCwd="/ws/sub" />)
    await waitFor(() => { expect(screen.getByText('inner.md')).toBeDefined() })
    expect(calls.some(call => call.includes('list?root=workspace&path=sub'))).toBe(true)
  })

  it('re-roots when the user switches sessions', async () => {
    const { rerender } = render(<FileBrowser labels={labels} sessionCwd="/ws/sub" />)
    await waitFor(() => { expect(screen.getByText('inner.md')).toBeDefined() })
    // Switch to a session whose cwd is the root itself.
    rerender(<FileBrowser labels={labels} sessionCwd="/ws" />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
  })

  it('falls back to the first root when the cwd is outside every root', async () => {
    // A session started somewhere the fence does not reach: show the root, not
    // a directory the host would refuse to list.
    render(<FileBrowser labels={labels} sessionCwd="/elsewhere/project" />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    expect(calls.some(call => call.includes('list?root=workspace&path=sub'))).toBe(false)
  })

  it('navigates to an open target and previews it, then reports it consumed', async () => {
    // The plumbing an artifact link would drive: point the browser at a file in
    // a subdirectory; it lists the parent, opens the preview, and clears the request.
    const consumed = vi.fn()
    render(
      <FileBrowser
        labels={labels}
        openTarget={{ root: 'workspace', path: 'sub/inner.md', name: 'inner.md' }}
        onTargetConsumed={consumed}
      />,
    )
    await waitFor(() => { expect(calls.some(call => call.includes('list?root=workspace&path=sub'))).toBe(true) })
    // The read path is URL-encoded (sub/inner.md → sub%2Finner.md), so match loosely.
    await waitFor(() => { expect(calls.some(call => call.includes('/read') && call.includes('inner.md'))).toBe(true) })
    expect(consumed).toHaveBeenCalled()
  })

  it('preview-only mode shows just the file, and Back reports the exit', async () => {
    // A link-opened preview hides the directory list regardless of pane width;
    // Back hands control back so normal browsing resumes.
    const exit = vi.fn()
    render(
      <FileBrowser
        labels={labels}
        openTarget={{ root: 'workspace', path: 'top.txt', name: 'top.txt' }}
        onTargetConsumed={vi.fn()}
        previewOnly
        onExitPreviewOnly={exit}
      />,
    )
    await waitFor(() => { expect(screen.getByText('Back')).toBeDefined() })
    const browser = document.querySelector('[data-narrow="true"]')
    expect(browser?.getAttribute('data-view')).toBe('preview')
    fireEvent.click(screen.getByText('Back'))
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('ignores an open target in a root it does not have, but still reports it', async () => {
    const consumed = vi.fn()
    render(
      <FileBrowser
        labels={labels}
        openTarget={{ root: 'nope', path: 'x.md', name: 'x.md' }}
        onTargetConsumed={consumed}
      />,
    )
    await waitFor(() => { expect(consumed).toHaveBeenCalled() })
    expect(calls.some(call => call.includes('read?root=nope'))).toBe(false)
  })
})

describe('parent directory', () => {
  it('shows an up icon on the parent row', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('sub')).toBeDefined() })
    fireEvent.click(screen.getByText('sub'))
    await waitFor(() => { expect(screen.getByText('Parent directory')).toBeDefined() })
    expect(screen.getByText('↑')).toBeDefined()
  })
})

describe('narrow drill-in layout', () => {
  // jsdom has no layout, so drive the width and the observer by hand.
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 })
    vi.stubGlobal('ResizeObserver', class {
      cb: () => void
      constructor(cb: () => void) { this.cb = cb }
      observe(): void { this.cb() }
      disconnect(): void { /* nothing */ }
    })
  })
  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 0 })
  })

  it('drills into a file with a Back button, and back to the list', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    // Narrow + nothing open: the list shows, no Back button.
    const browser = document.querySelector('[data-narrow="true"]')
    expect(browser?.getAttribute('data-view')).toBe('list')
    expect(screen.queryByText('Back')).toBeNull()

    // Open a file: drills into the preview with a Back affordance.
    fireEvent.click(screen.getByText('top.txt'))
    await waitFor(() => { expect(screen.getByText('Back')).toBeDefined() })
    expect(document.querySelector('[data-narrow="true"]')?.getAttribute('data-view')).toBe('preview')

    // Back returns to the list.
    fireEvent.click(screen.getByText('Back'))
    await waitFor(() => { expect(screen.queryByText('Back')).toBeNull() })
    expect(document.querySelector('[data-narrow="true"]')?.getAttribute('data-view')).toBe('list')
  })
})

describe('marking versus opening', () => {
  it('opens a file into the preview when its name is clicked', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    expect(screen.getByText('Pick a file')).toBeDefined()
    fireEvent.click(screen.getByText('top.txt'))
    await waitFor(() => { expect(calls.some(call => call.includes('read?root=workspace&path=top.txt'))).toBe(true) })
  })

  it('marks a directory from its icon without navigating into it', async () => {
    stubFetch(true)
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('sub')).toBeDefined() })
    const [icon] = screen.getAllByLabelText('Select')
    fireEvent.click(icon as Element)
    // Still in the root listing, and now the entry-scoped actions appear.
    expect(screen.getByText('top.txt')).toBeDefined()
    await waitFor(() => { expect(screen.getByText('Rename')).toBeDefined() })
  })
})

describe('capability gating', () => {
  it('hides the mutating controls when the host says writes are off', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    expect(screen.queryByText('New file')).toBeNull()
    expect(screen.queryByText('Upload')).toBeNull()
  })

  it('shows them when the host says writes are on', async () => {
    stubFetch(true)
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('New file')).toBeDefined() })
    expect(screen.getByText('Upload')).toBeDefined()
  })
})

describe('drag and drop upload', () => {
  const dropEvent = (files: File[]) => ({ dataTransfer: { files, items: files.map(() => ({ kind: 'file' })), types: ['Files'] } })

  it('hints while files are dragged over the list, once writes are on', async () => {
    stubFetch(true)
    const { container } = render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.dragOver(container.querySelector('aside') as Element, dropEvent([]))
    expect(screen.getByText('Drop to upload')).toBeDefined()
    fireEvent.dragLeave(container.querySelector('aside') as Element)
    expect(screen.queryByText('Drop to upload')).toBeNull()
  })

  it('uploads every dropped file into the current directory', async () => {
    stubFetch(true)
    const { container } = render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    const files = [new File(['a'], 'one.txt'), new File(['b'], 'two.txt')]
    fireEvent.drop(container.querySelector('aside') as Element, dropEvent(files))
    await waitFor(() => {
      expect(calls.some(call => call.includes('upload?root=workspace&path=one.txt'))).toBe(true)
      expect(calls.some(call => call.includes('upload?root=workspace&path=two.txt'))).toBe(true)
    })
  })

  it('drops into the directory currently open, not the root', async () => {
    stubFetch(true)
    const { container } = render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('sub')).toBeDefined() })
    fireEvent.click(screen.getByText('sub'))
    await waitFor(() => { expect(screen.getByText('inner.md')).toBeDefined() })
    fireEvent.drop(container.querySelector('aside') as Element, dropEvent([new File(['x'], 'here.txt')]))
    await waitFor(() => { expect(calls.some(call => call.includes('upload?root=workspace&path=sub%2Fhere.txt'))).toBe(true) })
  })

  it('ignores a drop when the host refuses writes', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.drop(document.querySelector('aside') as Element, dropEvent([new File(['a'], 'nope.txt')]))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(calls.some(call => call.includes('/upload'))).toBe(false)
  })
})

describe('filename search', () => {
  it('does not search for a one-character query', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.change(screen.getByLabelText('Search filenames'), { target: { value: 'i' } })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(calls.some(call => call.includes('/search'))).toBe(false)
  })

  it('replaces the listing with matches, shown by path', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.change(screen.getByLabelText('Search filenames'), { target: { value: 'inner' } })
    await waitFor(() => { expect(screen.getByText('sub/inner.md')).toBeDefined() })
  })

  it('debounces: typing three characters issues one search', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    const box = screen.getByLabelText('Search filenames')
    fireEvent.change(box, { target: { value: 'in' } })
    fireEvent.change(box, { target: { value: 'inn' } })
    fireEvent.change(box, { target: { value: 'inne' } })
    await waitFor(() => { expect(calls.filter(call => call.includes('/search'))).toHaveLength(1) })
  })

  it('says so when nothing matches', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.change(screen.getByLabelText('Search filenames'), { target: { value: 'zzzz' } })
    await waitFor(() => { expect(screen.getByText('No matching files.')).toBeDefined() })
  })

  it('opening a hit clears the search and previews the file', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.change(screen.getByLabelText('Search filenames'), { target: { value: 'inner' } })
    fireEvent.click(await screen.findByText('sub/inner.md'))
    await waitFor(() => { expect(calls.some(call => call.includes('read?root=workspace&path=sub%2Finner.md'))).toBe(true) })
    expect((screen.getByLabelText('Search filenames') as HTMLInputElement).value).toBe('')
  })
})

describe('search limits', () => {
  it('uses its own wording when the walk stopped early, not the listing message', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.change(screen.getByLabelText('Search filenames'), { target: { value: 'wide' } })
    await waitFor(() => { expect(screen.getByText('Search stopped early')).toBeDefined() })
    expect(screen.queryByText('Truncated')).toBeNull()
  })

  it('clears the early-stop notice when the query is cleared', async () => {
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    const box = screen.getByLabelText('Search filenames')
    fireEvent.change(box, { target: { value: 'wide' } })
    await waitFor(() => { expect(screen.getByText('Search stopped early')).toBeDefined() })
    fireEvent.change(box, { target: { value: '' } })
    await waitFor(() => { expect(screen.queryByText('Search stopped early')).toBeNull() })
  })
})

describe('upload replacement notice', () => {
  const dropEvent = (files: File[]) => ({ dataTransfer: { files, items: files.map(() => ({ kind: 'file' })), types: ['Files'] } })

  it('says which files an upload replaced', async () => {
    stubFetch(true)
    const { container } = render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.drop(container.querySelector('aside') as Element, dropEvent([new File(['x'], 'top.txt')]))
    await waitFor(() => { expect(screen.getByText(/Replaced: top\.txt/)).toBeDefined() })
  })

  it('stays quiet when nothing was replaced', async () => {
    stubFetch(true)
    const { container } = render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.drop(container.querySelector('aside') as Element, dropEvent([new File(['x'], 'brand-new.txt')]))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(screen.queryByText(/Replaced/)).toBeNull()
  })
})

describe('partial upload failure', () => {
  const dropEvent = (files: File[]) => ({ dataTransfer: { files, items: files.map(() => ({ kind: 'file' })), types: ['Files'] } })

  /** Accept everything except the one file standing in for an over-cap upload. */
  function stubOneBadFile(): void {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x')
      const json = (body: unknown): Response =>
        ({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }) as Response
      if (url.pathname.endsWith('/health')) return Promise.resolve(json({ ok: true, writeEnabled: true, ptyEnabled: false }))
      if (url.pathname.endsWith('/roots')) return Promise.resolve(json({ roots: [{ id: 'workspace', label: 'ws', path: '/ws' }] }))
      if (url.pathname.endsWith('/list')) {
        const path = url.searchParams.get('path') ?? ''
        return Promise.resolve(json({ root: 'workspace', path, absolutePath: `/ws/${path}`, entries: tree[path] ?? [], truncated: false }))
      }
      if (url.pathname.endsWith('/upload')) {
        if (url.searchParams.get('path') === 'huge.bin') {
          return Promise.resolve({
            ok: false, status: 413,
            json: () => Promise.resolve({ code: 'body_too_large', error: 'Request body is too large' }),
            text: () => Promise.resolve(''),
          } as Response)
        }
        return Promise.resolve(json({ ok: true, overwrote: false }))
      }
      return Promise.resolve(json({}))
    }))
  }

  it('uploads the rest of the batch and names the one that failed', async () => {
    // A rejected file used to abort the loop, so the files after it were
    // never sent and the listing never refreshed to show the ones that were.
    stubOneBadFile()
    const { container } = render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    const files = [new File(['a'], 'first.txt'), new File(['b'], 'huge.bin'), new File(['c'], 'last.txt')]
    fireEvent.drop(container.querySelector('aside') as Element, dropEvent(files))

    await waitFor(() => { expect(screen.getByText(/Failed: huge\.bin — Too large/)).toBeDefined() })
    const uploads = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(call => String(call[0])).filter(url => url.includes('/upload'))
    // The file after the failure still went out.
    expect(uploads.some(url => url.includes('path=last.txt'))).toBe(true)
    expect(uploads.some(url => url.includes('path=first.txt'))).toBe(true)
  })
})

describe('error wording', () => {
  it('shows its own sentence rather than the host phrasing', async () => {
    stubFetch(true)
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('New folder')).toBeDefined() })
    fireEvent.click(screen.getByText('New folder'))
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: '.git' } })
    fireEvent.click(screen.getByText('OK'))
    await waitFor(() => { expect(screen.getByText('Protected directory')).toBeDefined() })
    expect(screen.queryByText(/cannot be modified through the workbench/)).toBeNull()
  })
})

describe('keeping the listing current', () => {
  it('picks up a file the agent created, without being asked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubFetch(false)
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    expect(screen.queryByText('written-by-the-agent.md')).toBeNull()

    tree[''] = [...tree[''] as [], { name: 'written-by-the-agent.md', type: 'file', size: 7, mtime: '2026-01-02T00:00:00.000Z' }]
    await vi.advanceTimersByTimeAsync(5200)
    await waitFor(() => { expect(screen.getByText('written-by-the-agent.md')).toBeDefined() })
    vi.useRealTimers()
  })

  it('does not poll while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubFetch(false)
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    const before = calls.filter(call => call.includes('/list')).length

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await vi.advanceTimersByTimeAsync(12000)
    expect(calls.filter(call => call.includes('/list')).length).toBe(before)

    // and catches up the moment it comes back
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => { expect(calls.filter(call => call.includes('/list')).length).toBeGreaterThan(before) })
    visibility.mockRestore()
    vi.useRealTimers()
  })

  it('stops polling while a search is showing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    stubFetch(false)
    render(<FileBrowser labels={labels} />)
    await waitFor(() => { expect(screen.getByText('top.txt')).toBeDefined() })
    fireEvent.change(screen.getByLabelText('Search filenames'), { target: { value: 'inner' } })
    await waitFor(() => { expect(screen.getByText('sub/inner.md')).toBeDefined() })
    const before = calls.filter(call => call.includes('/list')).length
    await vi.advanceTimersByTimeAsync(12000)
    expect(calls.filter(call => call.includes('/list')).length).toBe(before)
    vi.useRealTimers()
  })
})

describe('a slow poll racing a mutation', () => {
  it('does not resurrect a row that was just deleted', async () => {
    // The poll's request left before the delete, so its answer still contains
    // the file. Applying it would make a deleted file reappear for seconds.
    let deleted = false
    // Held in an object and read through a function: assigning null narrows
    // the property, and TS cannot see that the fetch stub fills it back in.
    const slow: { release: (() => void) | null } = { release: null }
    const pendingRelease = (): (() => void) | null => slow.release
    calls = []

    vi.stubGlobal('fetch', vi.fn((input: string) => {
      const url = new URL(input, 'http://host')
      calls.push(url.pathname + url.search)
      const json = (body: unknown): Response =>
        ({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve('{}') }) as Response
      const listing = (entries: unknown[]): unknown => ({ root: 'workspace', path: '', absolutePath: '/ws', entries, truncated: false })
      const doomed = [{ name: 'doomed.txt', type: 'file', size: 1, mtime: 'm' }]

      if (url.pathname.endsWith('/health')) return Promise.resolve(json({ ok: true, writeEnabled: true, ptyEnabled: false }))
      if (url.pathname.endsWith('/roots')) return Promise.resolve(json({ roots: [{ id: 'workspace', path: '/ws', label: 'ws' }] }))
      if (url.pathname.endsWith('/delete')) { deleted = true; return Promise.resolve(json({ ok: true })) }
      if (url.pathname.endsWith('/list')) {
        if (deleted) return Promise.resolve(json(listing([])))
        // hold the second listing open so it lands after the delete
        if (pendingRelease() !== null) return Promise.resolve(json(listing(doomed)))
        return new Promise<Response>((resolve) => {
          slow.release = () => { resolve(json(listing(doomed))) }
        })
      }
      return Promise.resolve(json({}))
    }))

    render(<FileBrowser labels={labels} />)
    // first listing is the held one; release it so the pane has content
    await waitFor(() => { expect(pendingRelease()).not.toBeNull() })
    pendingRelease()?.()
    await waitFor(() => { expect(screen.getByText('doomed.txt')).toBeDefined() })

    // start a poll that will answer late
    slow.release = null
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => { expect(pendingRelease()).not.toBeNull() })

    fireEvent.click(screen.getAllByLabelText('Select')[0] as Element)
    fireEvent.click(screen.getByText('Delete'))
    fireEvent.click(screen.getByText('Confirm delete?'))
    await waitFor(() => { expect(screen.queryByText('doomed.txt')).toBeNull() })

    pendingRelease()?.()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(screen.queryByText('doomed.txt')).toBeNull()
  })
})
