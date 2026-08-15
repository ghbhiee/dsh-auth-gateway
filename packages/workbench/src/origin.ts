/**
 * A same-origin gate for browser-driven requests.
 *
 * `loopbackOnly` is not the defence it looks like. A WebSocket handshake and a
 * cross-site `fetch` are not stopped by the same-origin policy the way an XHR
 * *read* is, and both still originate from the user's own browser — so the
 * connection still arrives from loopback and still passes the address check. A
 * page the user merely visits can therefore reach a loopback-only PTY and get a
 * shell (confirmed against this plugin before this file existed), or, with
 * writes on, POST a file into the workspace.
 *
 * Browsers always attach `Origin` to these requests, and a same-origin one
 * carries an `Origin` whose host matches the `Host` header. A request with no
 * `Origin` is not coming from a browser page (curl, a native client, a test
 * harness) and is not subject to this confused-deputy problem, so it passes —
 * this is the standard, deliberate shape of a CSWSH/CSRF origin check, not an
 * oversight.
 *
 * @module dsh-plugin-workbench/origin
 */

import type { IncomingMessage } from 'node:http'

/**
 * Whether a request may act on the app's behalf: either it is not from a
 * browser (no `Origin`), or its `Origin` is this same server.
 *
 * @param req - the incoming HTTP request or upgrade.
 * @returns `true` when the request is allowed to proceed.
 */
export function isSameOrigin(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin
  // No Origin header → not a browser page. Not a confused-deputy risk.
  if (origin === undefined) return true
  const host = req.headers.host
  if (host === undefined) return false
  try {
    // URL.host is host:port, which is exactly what the Host header carries.
    return new URL(origin).host === host
  } catch {
    // A malformed Origin is not one we put there.
    return false
  }
}
