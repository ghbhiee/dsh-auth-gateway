/** Typed fetch wrappers over the workbench host routes. */

const BASE = '/plugins/workbench/api'

/** One directory child, as returned by the host. */
export interface ListEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  /** For a symlink, what it resolves to. */
  linkTarget?: 'file' | 'directory' | 'other' | 'broken'
  size: number
  mtime: string
}

/** A readable root offered by the host. */
export interface Root {
  id: string
  path: string
  label: string
}

/** A directory listing plus where it came from. */
export interface Listing {
  root: string
  path: string
  absolutePath: string
  entries: ListEntry[]
  truncated: boolean
}

/** Text file contents. */
export interface FileText {
  path: string
  size: number
  content: string
  /** Opaque freshness token; hand it back on save to detect a lost update. */
  version: string | null
}

/** An error carrying the host's machine-readable code. */
export class WorkbenchApiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkbenchApiError'
    this.code = code
  }
}

async function getJson<T>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(params).toString()
  const response = await fetch(`${BASE}${path}?${query}`, { headers: { accept: 'application/json' } })
  const body = await response.json().catch(() => null) as { error?: string; code?: string } | null
  if (!response.ok) {
    throw new WorkbenchApiError(body?.code ?? 'http_error', body?.error ?? `HTTP ${response.status}`)
  }
  return body as T
}

/** List the roots the browser may read. */
export async function fetchRoots(): Promise<Root[]> {
  const body = await getJson<{ roots: Root[] }>('/roots', {})
  return body.roots
}

/** List one directory inside a root. */
export function fetchListing(root: string, path: string): Promise<Listing> {
  return getJson<Listing>('/list', { root, path })
}

/** Read one text file inside a root. */
export function fetchText(root: string, path: string): Promise<FileText> {
  return getJson<FileText>('/read', { root, path })
}

/** Cheap freshness probe for an open preview. */
export interface FileStat {
  type: 'file' | 'directory' | 'other'
  size: number
  version: string | null
}

/** Ask what a path looks like now, without reading it. */
export function fetchStat(root: string, path: string): Promise<FileStat> {
  return getJson<FileStat>('/stat', { root, path })
}

/** One filename match. */
export interface SearchHit {
  path: string
  name: string
  isDirectory: boolean
}

/** Search filenames under a root; the host bounds the walk. */
export function searchFiles(root: string, path: string, q: string): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  return getJson<{ hits: SearchHit[]; truncated: boolean }>('/search', { root, path, q })
}

/** URL serving the raw bytes of a file (images, downloads). */
export function bytesUrl(root: string, path: string): string {
  return `${BASE}/bytes?${new URLSearchParams({ root, path }).toString()}`
}

/** What the host will let this browser do. */
export interface Capabilities {
  writeEnabled: boolean
  ptyEnabled: boolean
}

/** Ask the host which mutating routes are open. */
export async function fetchCapabilities(): Promise<Capabilities> {
  const body = await getJson<{ writeEnabled?: boolean; ptyEnabled?: boolean }>('/health', {})
  return { writeEnabled: body.writeEnabled === true, ptyEnabled: body.ptyEnabled === true }
}

async function mutate(path: string, params: Record<string, string>, init: RequestInit): Promise<{ overwrote?: boolean; version?: string | null }> {
  const query = new URLSearchParams(params).toString()
  const response = await fetch(`${BASE}${path}?${query}`, init)
  const body = await response.json().catch(() => null) as { error?: string; code?: string; overwrote?: boolean; version?: string | null } | null
  if (response.ok) {
    return {
      ...(body?.overwrote === undefined ? {} : { overwrote: body.overwrote }),
      ...(body?.version === undefined ? {} : { version: body.version }),
    }
  }
  throw new WorkbenchApiError(body?.code ?? 'http_error', body?.error ?? `HTTP ${response.status}`)
}

/**
 * Overwrite a text file.
 * @param version - the token from the read this edit started from; the host
 * refuses the write with `stale_version` if the file moved on since.
 */
export async function writeText(root: string, path: string, content: string, version?: string | null): Promise<string | null> {
  const params = version === undefined || version === null ? { root, path } : { root, path, version }
  const result = await mutate('/write', params, { method: 'PUT', body: content })
  return result.version ?? null
}

/** Upload raw bytes to a path; reports whether it replaced an existing file. */
export async function uploadFile(root: string, path: string, file: File): Promise<{ overwrote: boolean }> {
  const result = await mutate('/upload', { root, path }, { method: 'POST', body: file })
  return { overwrote: result.overwrote === true }
}

/** Create a directory. */
export async function makeDirectory(root: string, path: string): Promise<void> {
  await mutate('/mkdir', { root, path }, { method: 'POST' })
}

/** Move an entry within its root; refused by the host if something is already there. */
export async function renameEntry(root: string, path: string, to: string): Promise<void> {
  await mutate('/rename', { root, path, to }, { method: 'POST' })
}

/** Delete a file, or a directory and everything under it. */
export async function deleteEntry(root: string, path: string, recursive: boolean): Promise<void> {
  await mutate('/delete', recursive ? { root, path, recursive: '1' } : { root, path }, { method: 'DELETE' })
}
