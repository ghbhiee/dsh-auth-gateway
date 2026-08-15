/**
 * Every `--dsw-*` custom property these plugins reference must be one the
 * harness theme actually publishes.
 *
 * An invented token is silent: CSS falls back to the initial value (or the
 * literal fallback beside it), so the page still renders and only looks subtly
 * wrong — usually in the theme you were not looking at. `--dsw-alias-bg-mask`
 * shipped that way until a dark-mode pass caught it; the real name is
 * `--dsw-alias-bg-mask-1`.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

/** Custom properties declared by the theme package's stylesheets. */
function declaredTokens(): Set<string> {
  const themeRoot = dirname(require.resolve('@deepseek-ai/dsh-client-ui-theme/package.json'))
  const styles = join(themeRoot, 'lib', 'styles')
  const declared = new Set<string>()
  for (const file of readdirSync(styles)) {
    if (!file.endsWith('.css')) continue
    const css = readFileSync(join(styles, file), 'utf8')
    for (const match of css.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) declared.add(match[1] as string)
    for (const match of css.matchAll(/(--ds-[a-z0-9-]+)\s*:/g)) declared.add(match[1] as string)
  }
  return declared
}

/** Custom properties our own stylesheets consume through var(). */
function usedTokens(): Map<string, string[]> {
  const used = new Map<string, string[]>()
  const packages = join(import.meta.dirname, '..', '..')
  for (const pkg of readdirSync(packages)) {
    const clientDir = join(packages, pkg, 'src', 'client')
    let files: string[]
    try {
      files = readdirSync(clientDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.css')) continue
      const css = readFileSync(join(clientDir, file), 'utf8')
      for (const match of css.matchAll(/var\(\s*(--ds[a-z0-9-]+)/g)) {
        const token = match[1] as string
        used.set(token, [...(used.get(token) ?? []), `${pkg}/${file}`])
      }
    }
  }
  return used
}

describe('theme tokens', () => {
  const declared = declaredTokens()
  const used = usedTokens()

  it('finds the theme package and its tokens', () => {
    expect(declared.size).toBeGreaterThan(50)
    expect(declared.has('--dsw-alias-bg-base')).toBe(true)
  })

  it('reads our stylesheets', () => {
    expect(used.size).toBeGreaterThan(5)
  })

  it('references only tokens the theme publishes', () => {
    const invented = [...used.entries()]
      .filter(([token]) => !declared.has(token))
      .map(([token, files]) => `${token} (in ${files.join(', ')})`)
    expect(invented).toEqual([])
  })
})
