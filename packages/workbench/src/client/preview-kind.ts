/** Extension-driven preview routing and grammar hints. */

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml', svg: 'xml',
  md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', sql: 'sql', lua: 'lua',
}

const NAMED_FILES: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
}

/** How the preview pane should render a file. */
export type PreviewKind = 'image' | 'markdown' | 'html' | 'text'

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Choose a preview mode for a filename.
 * @param name - basename.
 * @returns the preview kind.
 */
export function previewKind(name: string): PreviewKind {
  const ext = extensionOf(name)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  // SVG stays an image (rendered through <img>, which never runs its scripts);
  // only real HTML documents get the framed renderer below.
  if (ext === 'html' || ext === 'htm') return 'html'
  return 'text'
}

/**
 * The `sandbox` attribute for the HTML preview iframe.
 *
 * This is the whole security boundary of the HTML renderer, so it lives here
 * where it can be tested on its own. A workspace is full of files nobody here
 * wrote — a cloned repo, a package's assets, whatever an agent just generated —
 * and rendering one as a document on the app's own origin is exactly the
 * stored-XSS hole the `bytes` route was hardened against (it would reach the
 * app's storage and this very API, the PTY route included).
 *
 * The framed document therefore always runs in an opaque origin: `allow-scripts`
 * is the *only* token ever granted, and never together with `allow-same-origin`
 * — that pair is what re-opens the hole, because a same-origin sandboxed frame
 * can reach back into the parent. Inert mode (the default) grants nothing, so no
 * script runs at all. With scripts opted in, they run walled off from the app:
 * no access to its DOM, cookies, or storage, no top-frame navigation, and —
 * because the origin is opaque and the API sets no CORS headers — no readable
 * fetch of the workbench routes either.
 * @param runScripts - whether the user opted into running the page's scripts.
 * @returns the sandbox token string; `''` (fully locked down) when inert.
 */
export function htmlSandbox(runScripts: boolean): string {
  return runScripts ? 'allow-scripts' : ''
}

/**
 * Grammar hint for the syntax highlighter.
 * @param name - basename.
 * @returns a shiki language id, or undefined for plain monospace.
 */
export function languageOf(name: string): string | undefined {
  return NAMED_FILES[name] ?? LANGUAGES[extensionOf(name)]
}

/**
 * Format a byte count for the file list.
 * @param bytes - size in bytes.
 * @returns a short human-readable size.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
