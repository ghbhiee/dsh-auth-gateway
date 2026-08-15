/**
 * The terminal pane's decisions, separated from xterm and the DOM.
 *
 * Everything here is pure: given a frame off the wire, or a socket that just
 * closed, what should the tab list and the active session become? The React
 * component owns the terminals, the socket, and the timers; this module owns
 * the rules, which is the part worth testing without a browser.
 *
 * @module dsh-plugin-workbench/client/terminal-model
 */

/** Reconnect backoff in ms; the last value repeats. */
export const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000] as const

/** One live shell as the tab strip knows it. */
export interface SessionTab {
  id: string
  shell: string
  pid: number
  exited: boolean
}

/** The pane's session state. */
export interface TerminalState {
  tabs: SessionTab[]
  activeId: string | null
}

/** The empty state, also what a dropped socket resets to. */
export const EMPTY_STATE: TerminalState = { tabs: [], activeId: null }

/** A frame as it arrives from the gateway. */
export type Frame =
  | { kind: 'output'; data: string }
  | { kind: 'control'; message: ControlMessage }

/** Control messages the gateway sends. */
export type ControlMessage =
  | { type: 'created'; id: string; pid?: number; shell?: string }
  | { type: 'switched'; id: string }
  | { type: 'exited'; id: string; exitCode?: number }
  | { type: 'error'; message: string }
  | { type: string }

/**
 * Classify one message from the socket.
 *
 * The wire format is deliberately untagged: anything that is not a JSON object
 * is terminal output, so a shell printing `{"a":1}` still has to round-trip.
 * A leading `{` that fails to parse is therefore output, not an error.
 * @param data - the raw text frame.
 * @returns whether this is terminal output or a control message.
 */
export function parseFrame(data: string): Frame {
  if (data.charCodeAt(0) !== 0x7b) return { kind: 'output', data }
  try {
    const parsed = JSON.parse(data) as ControlMessage
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
      return { kind: 'output', data }
    }
    return { kind: 'control', message: parsed }
  } catch {
    return { kind: 'output', data }
  }
}

/**
 * How long to wait before the next reconnect attempt.
 * @param attempt - failures so far; 0 is the first retry.
 * @returns the delay in milliseconds.
 */
export function retryDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 0), RETRY_DELAYS.length - 1)
  return RETRY_DELAYS[index] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1] ?? 15000
}

/** Add a freshly created session and focus it. */
export function sessionCreated(state: TerminalState, message: { id: string; shell?: string; pid?: number }): TerminalState {
  if (state.tabs.some(tab => tab.id === message.id)) return state
  return {
    tabs: [...state.tabs, { id: message.id, shell: message.shell ?? 'shell', pid: message.pid ?? 0, exited: false }],
    activeId: message.id,
  }
}

/** Mark a session's process as gone, keeping the tab so its output stays readable. */
export function sessionExited(state: TerminalState, id: string): TerminalState {
  if (!state.tabs.some(tab => tab.id === id)) return state
  return { ...state, tabs: state.tabs.map(tab => (tab.id === id ? { ...tab, exited: true } : tab)) }
}

/**
 * Drop a closed session, moving focus if it held it.
 * @param state - current state.
 * @param id - the session being closed.
 * @returns the state without it, focused on the first survivor.
 */
export function sessionClosed(state: TerminalState, id: string): TerminalState {
  const tabs = state.tabs.filter(tab => tab.id !== id)
  if (tabs.length === state.tabs.length) return state
  const activeId = state.activeId === id ? tabs[0]?.id ?? null : state.activeId
  return { tabs, activeId }
}

/** Focus an existing session; unknown ids leave the state alone. */
export function sessionSwitched(state: TerminalState, id: string): TerminalState {
  if (!state.tabs.some(tab => tab.id === id)) return state
  return { ...state, activeId: id }
}
