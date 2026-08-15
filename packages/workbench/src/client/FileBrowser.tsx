/** Directory listing with breadcrumbs, paired with the preview pane. */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteEntry, fetchCapabilities, fetchListing, fetchRoots, makeDirectory,
  renameEntry, searchFiles, uploadFile, writeText, type ListEntry, type Root, type SearchHit,
} from './api.ts'
import { formatSize } from './preview-kind.ts'
import { FileActions, type FileActionLabels } from './FileActions.tsx'
import { messageFor, type ErrorCopy } from './error-copy.ts'
import { FilePreview } from './FilePreview.tsx'
import css from './FileBrowser.module.css'

/** Localized copy the browser needs. */
export interface FileBrowserLabels extends FileActionLabels {
  /** Shown over the list while files are dragged onto it. */
  dropHint: string
  /** Placeholder for the filename search box. */
  searchPlaceholder: string
  /** Shown when a search found nothing. */
  noMatches: string
  /** Marks a symlink whose target is missing. */
  brokenLink: string
  /** Prefix for the notice listing files an upload replaced. */
  replaced: string
  /** Prefix for the notice listing files an upload could not take. */
  uploadFailed: string
  /** Shown when a save is refused because the file changed underneath. */
  staleVersion: string
  /** Shown while editing when the file changed underneath. */
  changedOnDisk: string
  /** Button that discards the draft and re-reads the current file. */
  reload: string
  /** Localized copy for host error codes. */
  errors: ErrorCopy
  /** Shown when the search walk stopped at a limit rather than finishing. */
  searchTruncated: string
  loading: string
  empty: string
  truncated: string
  binary: string
  /** Shown for a text file that is not UTF-8. */
  notUtf8: string
  emptyFile: string
  selectFile: string
  parent: string
  select: string
  open: string
  save: string
  edit: string
  saved: string
}

/** Props for the browser body. */
export interface FileBrowserProps {
  labels: FileBrowserLabels
}

interface Marked {
  path: string
  name: string
  isDirectory: boolean
}

function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

/** How often to re-check the open directory while the panel is on screen. */
const REFRESH_INTERVAL_MS = 5000

/** A cheap fingerprint of a listing, so an unchanged poll changes nothing. */
function signatureOf(entries: readonly ListEntry[]): string {
  return entries.map(entry => `${entry.name}:${entry.type}:${String(entry.size)}:${entry.mtime}`).join('|')
}

function joinPath(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`
}

/** Whether opening this entry should navigate rather than preview. */
function isNavigable(entry: ListEntry): boolean {
  return entry.type === 'directory' || (entry.type === 'symlink' && entry.linkTarget === 'directory')
}

/** Two-pane file browser: listing on the left, preview on the right. */
export function FileBrowser({ labels }: FileBrowserProps) {
  const [roots, setRoots] = useState<Root[]>([])
  const [rootId, setRootId] = useState('')
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<ListEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [writeEnabled, setWriteEnabled] = useState(false)
  const [marked, setMarked] = useState<Marked | null>(null)
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  /**
   * Bumped by every mutation. A poll that started before one must not apply
   * its result afterwards, or a file you just deleted comes back for a few
   * seconds — the request left before the delete and knows nothing about it.
   */
  const generationRef = useRef(0)
  const [dropActive, setDropActive] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searchTruncated, setSearchTruncated] = useState(false)

  const refresh = useCallback(() => { setReloadToken(token => token + 1) }, [])

  useEffect(() => {
    let cancelled = false
    fetchRoots().then((list) => {
      if (cancelled) return
      setRoots(list)
      setRootId(current => (current === '' ? list[0]?.id ?? '' : current))
    }).catch((error: unknown) => {
      if (!cancelled) {
        setStatus('error')
        setMessage(messageFor(error, labels.errors))
      }
    })
    fetchCapabilities().then((caps) => {
      if (!cancelled) setWriteEnabled(caps.writeEnabled)
    }).catch(() => { /* capabilities are advisory; the host enforces them anyway */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (rootId === '') return
    let cancelled = false
    setStatus('loading')
    fetchListing(rootId, path).then((listing) => {
      if (cancelled) return
      setEntries(listing.entries)
      setTruncated(listing.truncated)
      setStatus('ready')
    }).catch((error: unknown) => {
      if (cancelled) return
      setStatus('error')
      setMessage(messageFor(error, labels.errors))
    })
    return () => { cancelled = true }
  }, [rootId, path, reloadToken, labels.errors])

  // Search replaces the listing while a query is active. Debounced, because
  // every keystroke would otherwise start a walk.
  useEffect(() => {
    const trimmed = query.trim()
    if (rootId === '' || trimmed.length < 2) {
      setHits(null)
      setSearchTruncated(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      searchFiles(rootId, path, trimmed).then((result) => {
        if (cancelled) return
        setHits(result.hits)
        setSearchTruncated(result.truncated)
      }).catch((error: unknown) => {
        if (!cancelled) setMessage(messageFor(error, labels.errors))
      })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [rootId, path, query, labels.errors])

  /** Open a search hit: files go to the preview, directories become the listing. */
  const openHit = useCallback((hit: SearchHit) => {
    const parent = hit.path.includes('/') ? hit.path.slice(0, hit.path.lastIndexOf('/')) : ''
    setQuery('')
    setHits(null)
    if (hit.isDirectory) {
      setPath(joinPath(path, hit.path))
      setPreview(null)
      setMarked(null)
      return
    }
    setPath(joinPath(path, parent))
    const full = joinPath(path, hit.path)
    setPreview({ path: full, name: hit.name })
    setMarked({ path: full, name: hit.name, isDirectory: false })
  }, [path])

  // The agent writes files while you are looking at them, so the listing keeps
  // itself current: on an interval while visible, and immediately when the tab
  // regains focus. Unchanged results are dropped rather than re-rendered.
  useEffect(() => {
    if (rootId === '' || hits !== null) return
    let cancelled = false
    const poll = (): void => {
      if (document.visibilityState !== 'visible') return
      const generation = generationRef.current
      fetchListing(rootId, path).then((listing) => {
        if (cancelled || generation !== generationRef.current) return
        setEntries((current) => (signatureOf(current) === signatureOf(listing.entries) ? current : listing.entries))
        setTruncated(listing.truncated)
      }).catch(() => { /* a transient failure is not worth shouting about mid-poll */ })
    }
    const timer = window.setInterval(poll, REFRESH_INTERVAL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') poll() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', poll)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', poll)
    }
  }, [rootId, path, hits])

  const openEntry = useCallback((entry: ListEntry) => {
    if (isNavigable(entry)) {
      setPreview(null)
      setMarked(null)
      setPath(current => joinPath(current, entry.name))
      return
    }
    const full = joinPath(path, entry.name)
    setPreview({ path: full, name: entry.name })
    setMarked({ path: full, name: entry.name, isDirectory: false })
  }, [path])

  const afterMutation = useCallback((clearSelection: boolean) => {
    generationRef.current += 1
    if (clearSelection) { setMarked(null); setPreview(null) }
    setMessage('')
    refresh()
  }, [refresh])

  /**
   * Upload everything in a drop, then refresh once.
   *
   * One bad file must not abandon the rest of the batch: drop four files with
   * an oversized one among them and the other three should still land, and the
   * listing should still refresh to prove it. So each file is accounted for
   * separately and the notice names both outcomes.
   */
  const uploadAll = useCallback(async (files: readonly File[]) => {
    const replaced: string[] = []
    const failed: string[] = []
    for (const file of files) {
      try {
        const result = await uploadFile(rootId, joinPath(path, file.name), file)
        if (result.overwrote) replaced.push(file.name)
      } catch (error: unknown) {
        failed.push(`${file.name} — ${messageFor(error, labels.errors)}`)
      }
    }
    afterMutation(false)
    const notices: string[] = []
    // Replacing is a legitimate upload, but it should never be silent.
    if (replaced.length > 0) notices.push(`${labels.replaced}: ${replaced.join(', ')}`)
    if (failed.length > 0) notices.push(`${labels.uploadFailed}: ${failed.join('; ')}`)
    if (notices.length > 0) setMessage(notices.join(' · '))
  }, [rootId, path, afterMutation, labels.replaced, labels.uploadFailed, labels.errors])

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    setDropActive(false)
    if (!writeEnabled) return
    const files = [...event.dataTransfer.files]
    if (files.length === 0) return
    uploadAll(files).catch((error: unknown) => {
      setMessage(messageFor(error, labels.errors))
    })
  }, [writeEnabled, uploadAll, labels.errors])

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!writeEnabled) return
    // Claiming the dragover is what makes this element a drop target at all.
    event.preventDefault()
    setDropActive(true)
  }, [writeEnabled])

  const crumbs = path.split('/').filter(Boolean)

  return (
    <div className={css.browser}>
      <aside
        className={dropActive ? `${css.list} ${css.listDropping}` : css.list}
        onDragOver={onDragOver}
        onDragLeave={() => { setDropActive(false) }}
        onDrop={onDrop}
      >
        {dropActive ? <div className={css.dropHint}>{labels.dropHint}</div> : null}
        <div className={css.toolbar}>
          <select
            className={css.rootPicker}
            value={rootId}
            onChange={(event) => { setRootId(event.target.value); setPath(''); setPreview(null); setMarked(null) }}
          >
            {roots.map(root => <option key={root.id} value={root.id}>{root.label}</option>)}
          </select>
          <input
            className={css.search}
            type="search"
            value={query}
            placeholder={labels.searchPlaceholder}
            aria-label={labels.searchPlaceholder}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </div>

        {writeEnabled ? (
          <FileActions
            selected={marked}
            labels={labels}
            onError={(error: unknown) => { setMessage(messageFor(error, labels.errors)) }}
            onCreateFile={async (name) => { await writeText(rootId, joinPath(path, name), ''); afterMutation(false) }}
            onCreateFolder={async (name) => { await makeDirectory(rootId, joinPath(path, name)); afterMutation(false) }}
            onUpload={async (file) => { await uploadAll([file]) }}
            onRename={async (name) => {
              if (marked === null) return
              await renameEntry(rootId, marked.path, joinPath(parentOf(marked.path), name))
              afterMutation(true)
            }}
            onDelete={async () => {
              if (marked === null) return
              await deleteEntry(rootId, marked.path, marked.isDirectory)
              afterMutation(true)
            }}
          />
        ) : null}

        <div className={css.crumbs}>
          <button type="button" className={css.crumb} onClick={() => { setPath(''); setPreview(null); setMarked(null) }}>/</button>
          {crumbs.map((crumb, index) => (
            <button
              key={`${crumb}-${String(index)}`}
              type="button"
              className={css.crumb}
              onClick={() => { setPath(crumbs.slice(0, index + 1).join('/')); setPreview(null); setMarked(null) }}
            >
              {crumb}
            </button>
          ))}
        </div>

        {status === 'loading' ? <div className={css.notice}>{labels.loading}</div> : null}
        {status === 'error' ? <div className={css.notice}>{message}</div> : null}
        {message !== '' && status === 'ready' ? <div className={css.notice}>{message}</div> : null}
        {hits !== null ? (
          <ul className={css.rows}>
            {hits.map(hit => (
              <li key={hit.path} className={css.entry}>
                <button type="button" className={css.row} onClick={() => { openHit(hit) }}>
                  <span className={css.icon} aria-hidden="true">{hit.isDirectory ? '▸' : '·'}</span>
                  <span className={css.name}>{hit.path}</span>
                </button>
              </li>
            ))}
            {hits.length === 0 ? <li className={css.notice}>{labels.noMatches}</li> : null}
            {searchTruncated ? <li className={css.notice}>{labels.searchTruncated}</li> : null}
          </ul>
        ) : null}

        {hits === null && status === 'ready' ? (
          <ul className={css.rows}>
            {path === '' ? null : (
              <li>
                <button type="button" className={css.row} onClick={() => { setPath(parentOf(path)); setPreview(null); setMarked(null) }}>
                  <span className={css.name}>{labels.parent}</span>
                </button>
              </li>
            )}
            {entries.map((entry) => {
              const full = joinPath(path, entry.name)
              return (
                <li key={entry.name} className={marked?.path === full ? `${css.entry} ${css.entryActive}` : css.entry}>
                  {/* Clicking the icon marks an entry (including a directory)
                      for rename/delete; clicking the name opens it. */}
                  <button
                    type="button"
                    className={css.icon}
                    aria-label={labels.select}
                    onClick={() => { setMarked({ path: full, name: entry.name, isDirectory: isNavigable(entry) }) }}
                  >
                    {entry.type === 'symlink' ? '↗' : entry.type === 'directory' ? '▸' : '·'}
                  </button>
                  <button type="button" className={css.row} aria-label={labels.open} onClick={() => { openEntry(entry) }}>
                    <span className={css.name}>{entry.name}</span>
                    {entry.type === 'file' ? <span className={css.size}>{formatSize(entry.size)}</span> : null}
                    {entry.linkTarget === 'broken' ? <span className={css.size}>{labels.brokenLink}</span> : null}
                  </button>
                </li>
              )
            })}
            {entries.length === 0 ? <li className={css.notice}>{labels.empty}</li> : null}
            {truncated ? <li className={css.notice}>{labels.truncated}</li> : null}
          </ul>
        ) : null}
      </aside>

      <section className={css.preview}>
        {preview === null
          ? <div className={css.notice}>{labels.selectFile}</div>
          : (
            <FilePreview
              root={rootId}
              path={preview.path}
              name={preview.name}
              writeEnabled={writeEnabled}
              onSaved={refresh}
              labels={{
                loading: labels.loading,
                binary: labels.binary,
                notUtf8: labels.notUtf8,
                empty: labels.emptyFile,
                edit: labels.edit,
                save: labels.save,
                cancel: labels.cancel,
                saved: labels.saved,
                staleVersion: labels.staleVersion,
                changedOnDisk: labels.changedOnDisk,
                reload: labels.reload,
              }}
            />
          )}
      </section>
    </div>
  )
}
