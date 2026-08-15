/**
 * Documentation drift, caught mechanically.
 *
 * These READMEs are the only description of the plugins' contracts, and they
 * have been edited on almost every change. A config field renamed in the
 * schema, a route added, or an error code the browser never learned to word
 * are all invisible until somebody reads carefully — so read them here instead.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_ERROR_CODES } from '../src/client/error-copy.ts'

const packages = join(import.meta.dirname, '..', '..')

const read = (...parts: string[]): string => readFileSync(join(packages, ...parts), 'utf8')

/** Config field names a package's schema declares, in source order. */
function schemaFields(source: string): string[] {
  const block = /export const Config: z<Config> = z\.object\(\{([\s\S]*?)\n\}\)/.exec(source)
  if (block === null) return []
  return [...(block[1] as string).matchAll(/^\s{2}(\w+):/gm)].map(match => match[1] as string)
}

/** Error codes the host actually throws. */
function thrownCodes(source: string): string[] {
  return [...source.matchAll(/new ApiError\(\s*\d+,\s*'([a-z_]+)'/g)].map(match => match[1] as string)
}

/** Routes the host actually serves, from its `route === '...'` branches. */
function servedRoutes(source: string): string[] {
  return [...source.matchAll(/route === '([a-z]+)'/g)].map(match => match[1] as string)
}

describe('workbench', () => {
  const readme = read('workbench', 'README.md')
  const index = read('workbench', 'src', 'index.ts')
  const api = read('workbench', 'src', 'api.ts')

  it('documents every config field', () => {
    const fields = schemaFields(index)
    expect(fields.length).toBeGreaterThan(3)
    const undocumented = fields.filter(field => !readme.includes(`\`${field}\``))
    expect(undocumented).toEqual([])
  })

  it('documents every route it serves', () => {
    const routes = servedRoutes(api).filter(route => route !== 'health')
    expect(routes.length).toBeGreaterThan(5)
    const undocumented = routes.filter(route => !readme.includes(`/api/${route}`))
    expect(undocumented).toEqual([])
  })

  it('gives the browser wording for every error code the host can throw', () => {
    // An unworded code falls back to the host's operator-facing text, which is
    // the thing the error-copy module exists to avoid.
    const hostSources = ['api.ts', 'roots.ts', 'write-guard.ts', 'search.ts', 'index.ts']
      .map(file => read('workbench', 'src', file)).join('\n')
    const unworded = [...new Set(thrownCodes(hostSources))]
      .filter(code => !(KNOWN_ERROR_CODES as readonly string[]).includes(code))
      // Codes a person never sees: they mean the caller is not the browser.
      .filter(code => !['missing_param', 'unknown_route', 'unknown_root', 'not_loopback', 'cross_origin', 'method_not_allowed', 'not_a_directory', 'binary_file', 'not_utf8', 'internal'].includes(code))
    expect(unworded).toEqual([])
  })

  it('claims no error code the host cannot produce', () => {
    // Guards live in their own module, so scan the whole host half — scanning
    // one file made six real codes look invented.
    const hostSources = ['api.ts', 'roots.ts', 'write-guard.ts', 'search.ts', 'index.ts']
      .map(file => read('workbench', 'src', file)).join('\n')
    const thrown = new Set([...thrownCodes(hostSources), 'stale_version'])
    const stale = (KNOWN_ERROR_CODES as readonly string[]).filter(code => !thrown.has(code))
    expect(stale).toEqual([])
  })
})

describe('cli-session', () => {
  const readme = read('cli-session', 'README.md')
  const index = read('cli-session', 'src', 'index.ts')

  it('documents every config field', () => {
    const fields = schemaFields(index).filter(field => field !== 'request')
    expect(fields).toContain('sessionTag')
    const undocumented = fields.filter(field => !readme.includes(`\`${field}\``))
    expect(undocumented).toEqual([])
  })

  it('documents every flag the startup declares', () => {
    const startup = read('cli-session', 'src', 'startup.ts')
    // Long-form-only flags count too: `--json-schema` has no short form and a
    // short-plus-long pattern would have let it go undocumented.
    const flags = [...startup.matchAll(/\.option\('(?:-\w, )?--([a-z-]+)/g)].map(match => `--${match[1] as string}`)
    expect(flags.length).toBeGreaterThan(5)
    const undocumented = flags.filter(flag => !readme.includes(flag))
    expect(undocumented).toEqual([])
  })
})

describe('mobile-shell', () => {
  const readme = read('mobile-shell', 'README.md')
  const index = read('mobile-shell', 'src', 'index.ts')

  it('documents every config field', () => {
    const fields = schemaFields(index)
    expect(fields).toEqual(['narrowMaxWidth', 'documentTitle'])
    const undocumented = fields.filter(field => !readme.includes(field))
    expect(undocumented).toEqual([])
  })
})
