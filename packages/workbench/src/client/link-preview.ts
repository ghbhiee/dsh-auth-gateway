/**
 * Recognizing the conversation's file-link buttons, and the open/close rules of
 * the link-driven preview.
 *
 * dsh renders several kinds of clickable file references — inline-code mentions
 * in a message, the produced-file chips under a turn, the path links on tool
 * cards — and all of them open through the *host* opener: the file opens on the
 * machine dsh runs on. Fine at a desk, useless from a phone or another machine,
 * and this is a web app. The workbench intercepts those clicks and previews the
 * file in its own docked panel instead, which works wherever the browser is.
 *
 * There is no supported way to re-point the links themselves: the providing
 * service refuses a second registration (verified — it fails plugin load), and
 * the buttons carry no stable data attribute, only compiled hash classes this
 * plugin will not key on. So recognition is by *content*: a button whose title
 * or entire text is shaped like a file path. The pieces here are pure so the
 * heuristic and the toggle rules can be pinned by tests.
 *
 * @module dsh-plugin-workbench/client/link-preview
 */

/**
 * Whether a token is shaped like a single file path.
 *
 * Conservative: one token (no whitespace), bounded length, not a URL, and a
 * last segment shaped like `name.ext`. Existence on disk is verified by the
 * caller before anything opens, so this only has to be a cheap first gate.
 * @param token - the candidate, already trimmed.
 * @returns true when it is worth resolving.
 */
export function isPathLike(token: string): boolean {
  if (token === '' || token.length > 512 || /\s/.test(token)) return false
  if (token.includes('://')) return false
  const last = token.slice(token.lastIndexOf('/') + 1)
  return /^[^/]+\.[A-Za-z0-9]{1,8}$/.test(last)
}

/**
 * The path a clicked button refers to, if it is a file link at all.
 *
 * Two shapes cover every dsh file link: the full path as the button's text
 * (inline mentions), or a basename label with the full path in `title` (the
 * produced-file chips, and this plugin's own preview labels the same way). The
 * title wins when both are path-shaped — it carries the full path.
 * @param title - the button's `title` attribute, or ''.
 * @param text - the button's entire text content.
 * @returns the path token to resolve, or null when this is not a file link.
 */
export function candidatePath(title: string, text: string): string | null {
  const fromTitle = title.trim()
  const fromText = text.trim()
  if (isPathLike(fromTitle)) {
    // The visible label must agree with the title (the path itself, or its
    // basename) — otherwise the title is a tooltip on an unrelated control.
    if (fromText === '' || fromText === fromTitle || fromTitle.endsWith(`/${fromText}`)) return fromTitle
    return null
  }
  if (isPathLike(fromText)) return fromText
  return null
}

/** The slice of workbench state the link-driven preview owns. */
export interface LinkPreviewSlice {
  /** Whether the surface is visible. */
  open: boolean
  /** Absolute path of the file a link opened, or null when none is showing. */
  linkPreviewPath: string | null
  /** Whether the surface was open before the link took it over, for restore. */
  openBeforeLink: boolean
}

/**
 * What one link click does to the state: open the preview, switch it to another
 * file, or — same link again — close it and restore what was there before.
 * @param slice - current state slice.
 * @param absolute - the clicked file's absolute path.
 * @returns the next slice, plus whether the click opens (true) or closes.
 */
export function linkClick(slice: LinkPreviewSlice, absolute: string): LinkPreviewSlice & { opens: boolean } {
  if (slice.open && slice.linkPreviewPath === absolute) {
    return { open: slice.openBeforeLink, linkPreviewPath: null, openBeforeLink: false, opens: false }
  }
  return {
    open: true,
    linkPreviewPath: absolute,
    // Only the first link in a run records the restore point; switching files
    // keeps it, so closing still lands where the user actually was.
    openBeforeLink: slice.linkPreviewPath === null ? slice.open : slice.openBeforeLink,
    opens: true,
  }
}
