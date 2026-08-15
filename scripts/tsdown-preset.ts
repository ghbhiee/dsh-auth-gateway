/**
 * Shared tsdown preset for out-of-tree dsh plugins.
 *
 * dsh serves a plugin's browser half from `lib/client.js` and evaluates it
 * through the shell's frozen module table. The physical contract for that file
 * is owned by `packages/client/tsdown.client.ts` inside the harness repo, which
 * is NOT published — so an external plugin has to reproduce it exactly:
 *
 *   1. CJS, wrapped in `window.__ModuleLoader__.load({ id, factory })`
 *      where `id` is the package name;
 *   2. only the platform modules stay external (they are answered by the
 *      injected `require`); everything else must be inlined, because a
 *      `require()` the table cannot answer throws at boot;
 *   3. CSS Modules are compiled with lightningcss and injected at runtime as
 *      `<style data-plugin=...>` tags;
 *   4. `process.env.NODE_ENV` / `import.meta.env` must be substituted — a CJS
 *      output cannot carry `import.meta`.
 *
 * @module dsh-plugins/scripts/tsdown-preset
 */

import { basename, dirname, resolve as resolvePath } from 'node:path'
import { readFile } from 'node:fs/promises'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/**
 * Module specifiers the dsh web shell shares into its frozen module table.
 * Mirrors `PLATFORM_MODULES` in `@deepseek-ai/dsh-client-web/src/platform.ts`
 * plus the documented runtime store exemption. Keep in sync when dsh bumps.
 */
export const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
/** Keeps the virtual id from ending in `.css`, which tsdown's css guard rejects. */
const CSS_VIRTUAL_SUFFIX = '.mjs'
const NODE_ENV = process.env.NODE_ENV ?? 'production'

/** Resolve a `.module.css` specifier against the importing source file. */
function cssAssetPath(source: string, importer: string | undefined): string {
  return importer === undefined ? source : resolvePath(dirname(importer), source)
}

/**
 * Compile CSS Modules into a self-injecting stub, matching the harness output:
 * one `<style data-plugin-css="<id>/<file>">` tag per module file, idempotent
 * under re-evaluation, default-exporting the local→hashed class map.
 * @param id - Plugin id (package name) stamped onto the style tag.
 * @returns A tsdown/rolldown plugin handling `*.module.css`.
 */
function cssModulesPlugin(id: string) {
  return {
    name: 'dsh-css-inline',
    async resolveId(
      this: { resolve: (source: string, importer?: string, options?: { skipSelf?: boolean }) => Promise<{ id: string } | null> },
      source: string,
      importer: string | undefined,
    ): Promise<string | null> {
      if (!source.endsWith('.css')) return null
      // Vendor stylesheets (xterm) arrive as bare specifiers, so ask the default
      // resolver where they live before claiming them.
      if (source.startsWith('.') || source.startsWith('/')) {
        return CSS_VIRTUAL_PREFIX + cssAssetPath(source, importer) + CSS_VIRTUAL_SUFFIX
      }
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      return resolved === null ? null : CSS_VIRTUAL_PREFIX + resolved.id + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile: (file: string) => void }, virtualId: string): Promise<string | null> {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      // Only `*.module.css` is scoped; a plain stylesheet keeps its global
      // selectors (xterm ships one) and exports nothing.
      const scoped = fileId.endsWith('.module.css')
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        ...(scoped ? { cssModules: { pattern: '[hash]_[local]' } } : {}),
        minify: true,
        // Down-level modern syntax (media-query ranges, nesting) for the phone
        // browsers this UI is expected to reach. Encoded as major<<16.
        targets: { safari: 15 << 16, chrome: 100 << 16, firefox: 100 << 16 },
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) classMap[local] = exported.name
      const tagId = `${id}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(id)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/** Node (host) half: a plain ESM library the cordis Loader imports. */
function hostConfig(id: string, entry: readonly string[]): UserConfig {
  return {
    name: `${id}/host`,
    entry: [...entry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
  }
}

/** Browser half: the `lib/client.js` bundle the dsh shell loads. */
function clientConfig(id: string, entry: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    },
    // tsdown auto-externalizes declared dependencies; anything the shell's
    // module table cannot answer must inline instead.
    noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
    plugins: [cssModulesPlugin(id)],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/**
 * Build both halves of a dsh plugin package.
 * @param id - Package name; stamped into the module-table handoff and style tags.
 * @param options - `host` lists node-half entries; `client` is the browser entry
 * (omit for a host-only plugin).
 * @returns tsdown configs for this package.
 */
export function pluginBundle(
  id: string,
  options: { host: readonly string[]; client?: string },
): UserConfig[] {
  const configs = [hostConfig(id, options.host)]
  if (options.client !== undefined) configs.push(clientConfig(id, options.client))
  return configs
}
