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
export type PreviewKind = 'image' | 'markdown' | 'text'

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
  return 'text'
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
