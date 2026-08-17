/**
 * Pull candidate file paths out of an assistant message's prose.
 *
 * The structured produced-files signal only knows files written through the
 * file-edit tools; a file a `bash` step wrote and the assistant then named in
 * its reply is invisible to it. So the reply text is scanned too — but only for
 * tokens shaped like a real filename, and every hit is checked against the disk
 * before it becomes a chip, so a token that names nothing is dropped rather than
 * shown as a dead link.
 *
 * @module dsh-plugin-workbench/client/artifact-paths
 */

/**
 * Whether a bare token looks like a single file path worth resolving.
 *
 * Conservative: one token (no whitespace), bounded length, and a last segment
 * shaped like `name.ext`. Existence is verified later, so this only has to be a
 * cheap first filter.
 * @param token - a candidate token, already trimmed of surrounding syntax.
 * @returns true when it is worth an existence check.
 */
export function isPathToken(token: string): boolean {
  if (token === '' || token.length > 512 || /\s/.test(token)) return false
  const last = token.slice(token.lastIndexOf('/') + 1)
  return /^[^/]+\.[A-Za-z0-9]{1,8}$/.test(last)
}

/** Trailing punctuation that clings to a path in prose but is not part of it. */
const TRAILING = /[)\]}>.,;:!?'"`）】」』，。；：！？]+$/
/** Leading punctuation likewise. */
const LEADING = /^[(\[{<'"`（【「『]+/

/**
 * Extract unique file-path tokens from prose/markdown.
 *
 * Inline-code spans (`` `path` ``) are the strongest signal and are taken whole;
 * the rest of the text is scanned word by word with surrounding punctuation
 * stripped. Order is first-seen; duplicates collapse.
 * @param text - the assistant message text.
 * @returns candidate path tokens, deduped, in first-seen order.
 */
export function extractPathTokens(text: string): string[] {
  const found = new Set<string>()
  const add = (raw: string): void => {
    const token = raw.replace(LEADING, '').replace(TRAILING, '')
    if (isPathToken(token)) found.add(token)
  }
  for (const span of text.match(/`[^`\n]+`/g) ?? []) add(span.slice(1, -1).trim())
  for (const word of text.split(/[\s]+/)) add(word)
  return [...found]
}
