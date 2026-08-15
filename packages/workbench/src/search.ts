/**
 * Filename search across a read root.
 *
 * A plain bounded walk rather than ripgrep: the harness's `tool-fs-search`
 * owns a vendored rg binary, but it is an internal dependency resolved from
 * the harness's own tree, and matching names does not need it. What this does
 * need is limits — a workspace can contain a million files, and a browser
 * asking for "a" must not stall the server or the event loop.
 *
 * @module dsh-plugin-workbench/search
 */

import { opendir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** One hit, relative to the searched root. */
export interface SearchHit {
  /** Path relative to the root, with forward slashes. */
  path: string
  /** Basename. */
  name: string
  /** Whether the hit is a directory. */
  isDirectory: boolean
}

/** What a search may spend before giving up. */
export interface SearchLimits {
  /** Stop after this many hits. */
  maxResults: number
  /** Stop after visiting this many entries. */
  maxScanned: number
  /** Stop after this long, whatever else is true. */
  budgetMs: number
}

/** Directories never worth walking for a filename search. */
const SKIPPED = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', '.turbo'])

/** Default limits: generous for a person, cheap for the server. */
export const DEFAULT_LIMITS: SearchLimits = { maxResults: 200, maxScanned: 20000, budgetMs: 2000 }

/** Outcome of one search. */
export interface SearchResult {
  hits: SearchHit[]
  /** True when a limit cut the walk short, so the UI can say "more exist". */
  truncated: boolean
  /** Entries visited, for the caller's own telemetry. */
  scanned: number
}

/**
 * Walk `root` breadth-first, collecting entries whose name contains `query`.
 *
 * Breadth-first on purpose: shallow matches are the ones a person means, so a
 * truncated search still returns the useful half. Symlinked directories are
 * listed but never descended — that is both the cycle guard and the fence,
 * since a link could otherwise walk straight out of the root.
 * @param root - absolute directory to search.
 * @param query - case-insensitive substring; the caller enforces a minimum length.
 * @param limits - stopping conditions.
 * @param now - clock, injectable for tests.
 * @returns hits in breadth-first order.
 */
export async function searchNames(
  root: string,
  query: string,
  limits: SearchLimits = DEFAULT_LIMITS,
  now: () => number = Date.now,
): Promise<SearchResult> {
  // macOS stores names decomposed (NFD) while a person types the composed
  // form (NFC), so "café" would miss a file literally called café. Normalize
  // both sides and the two spellings meet.
  const needle = query.normalize('NFC').toLowerCase()
  const deadline = now() + limits.budgetMs
  const queue: string[] = [root]
  const hits: SearchHit[] = []
  let scanned = 0
  let truncated = false

  while (queue.length > 0) {
    const dir = queue.shift() as string
    let handle
    try {
      handle = await opendir(dir)
    } catch {
      continue // vanished or unreadable mid-walk; the rest of the tree still counts
    }
    for await (const entry of handle) {
      scanned += 1
      if (scanned > limits.maxScanned || now() > deadline) {
        truncated = true
        break
      }
      const absolute = join(dir, entry.name)
      const isDirectory = entry.isDirectory()
      if (entry.name.normalize('NFC').toLowerCase().includes(needle)) {
        hits.push({ path: relative(root, absolute).split('\\').join('/'), name: entry.name, isDirectory })
        if (hits.length >= limits.maxResults) {
          truncated = true
          break
        }
      }
      if (isDirectory && !entry.isSymbolicLink() && !SKIPPED.has(entry.name)) queue.push(absolute)
    }
    if (truncated) break
  }

  return { hits, truncated, scanned }
}
