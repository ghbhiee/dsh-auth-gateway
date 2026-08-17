/**
 * xterm.js pane over the workbench PTY gateway.
 *
 * Terminal instances stay alive in a Map and are moved between the DOM and a
 * detached holder when tabs switch, instead of being recreated — recreating
 * them throws away the scrollback.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  EMPTY_STATE, parseFrame, retryDelay, sessionClosed, sessionCreated, sessionExited,
  sessionSwitched, type TerminalState,
} from './terminal-model.ts'
import { fetchCapabilities } from './api.ts'
import css from './TerminalPane.module.css'

/** Localized copy for the terminal pane. */
export interface TerminalPaneLabels {
  connecting: string
  newTab: string
  closeTab: string
  exited: string
  disconnected: string
  reconnect: string
  /** Shown when the deployment has terminals switched off. */
  disabled: string
}

/** Props for the terminal pane. */
export interface TerminalPaneProps {
  /** Whether the pane is on screen; terminals only fit while visible. */
  active: boolean
  /** The active session's working directory; new shells open here. */
  cwd?: string | undefined
  /** Localized copy. */
  labels: TerminalPaneLabels
}

interface TerminalHandle {
  term: Terminal
  fit: FitAddon
  opened: boolean
}

function socketUrl(cwd?: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const base = `${protocol}//${window.location.host}/plugins/workbench/pty`
  // The first shell (and the one a reconnect brings up) opens in the session's
  // directory; the host fences it, so an unusable value just falls back there.
  return cwd === undefined || cwd === '' ? base : `${base}?cwd=${encodeURIComponent(cwd)}`
}

/**
 * Read xterm's colors off the harness theme.
 *
 * xterm needs concrete color values, so the CSS custom properties have to be
 * resolved here — and re-resolved when the theme flips, or a dark-mode switch
 * leaves dark text on a dark surface.
 * @returns foreground/background/cursor for the xterm theme.
 */
function themeColors(): { foreground: string; background: string; cursor: string } {
  const style = getComputedStyle(document.body)
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    foreground: read('--dsw-alias-label-primary', '#1a1a1a'),
    // The pane paints the surface; a transparent terminal inherits it.
    background: 'rgba(0, 0, 0, 0)',
    cursor: read('--dsw-alias-label-secondary', '#666666'),
  }
}

/** Render the terminal pane: a tab strip plus the active xterm surface. */
export function TerminalPane({ active, cwd, labels }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  // Read through a ref so a session switch updates where the *next* shell opens
  // without tearing down the socket (and the running shells) to reconnect.
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const termsRef = useRef(new Map<string, TerminalHandle>())
  const activeIdRef = useRef<string | null>(null)
  const [state, setState] = useState<TerminalState>(EMPTY_STATE)
  const { tabs, activeId } = state
  const [connected, setConnected] = useState(false)
  const attemptRef = useRef(0)
  /** undefined until the host answers; false stops the pane from dialing at all. */
  const [ptyEnabled, setPtyEnabled] = useState<boolean | undefined>(undefined)
  const [reconnectToken, setReconnectToken] = useState(0)

  /** Retry now instead of waiting out the backoff. */
  const reconnectNow = useCallback(() => {
    attemptRef.current = 0
    setReconnectToken(token => token + 1)
  }, [])

  const send = useCallback((message: object) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }, [])

  const fitActive = useCallback(() => {
    const id = activeIdRef.current
    if (id === null) return
    const handle = termsRef.current.get(id)
    if (handle === undefined) return
    try {
      handle.fit.fit()
      send({ type: 'resize', cols: handle.term.cols, rows: handle.term.rows })
    } catch {
      // The pane can be measured at zero size mid-transition; the observer refits.
    }
  }, [send])

  const mount = useCallback((id: string) => {
    const host = hostRef.current
    const handle = termsRef.current.get(id)
    if (host === null || handle === undefined) return
    while (host.firstChild !== null) host.removeChild(host.firstChild)
    if (handle.opened) {
      if (handle.term.element !== undefined) host.appendChild(handle.term.element)
    } else {
      handle.term.open(host)
      handle.opened = true
    }
    handle.term.focus()
    window.setTimeout(fitActive, 0)
    window.setTimeout(fitActive, 120)
  }, [fitActive])

  const ensureTerm = useCallback((id: string): TerminalHandle => {
    const existing = termsRef.current.get(id)
    if (existing !== undefined) return existing
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: themeColors(),
      allowTransparency: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Tools print URLs constantly (dev servers, CI, docs); make them clickable
    // rather than something to select and paste by hand.
    term.loadAddon(new WebLinksAddon())
    term.onData((data) => { socketRef.current?.send(data) })
    const handle: TerminalHandle = { term, fit, opened: false }
    termsRef.current.set(id, handle)
    return handle
  }, [])

  // One socket, re-established after a drop. A dropped socket means the
  // server's PTYs are gone with it, so the old tabs are cleared rather than
  // left looking alive; the reconnect gets a fresh shell from the server.
  const [attempt, setAttempt] = useState(0)

  // Ask before dialing: with terminals off there is no upgrade route, and
  // retrying it forever reports a disabled feature as a broken one.
  useEffect(() => {
    let cancelled = false
    fetchCapabilities()
      .then((caps) => { if (!cancelled) setPtyEnabled(caps.ptyEnabled) })
      .catch(() => { if (!cancelled) setPtyEnabled(true) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (ptyEnabled !== true) return
    let disposed = false
    let timer = 0
    const terms = termsRef.current

    const dropTerminals = (): void => {
      for (const handle of terms.values()) handle.term.dispose()
      terms.clear()
      activeIdRef.current = null
      setState(EMPTY_STATE)
    }

    const connect = (): void => {
      const socket = new WebSocket(socketUrl(cwdRef.current))
      socketRef.current = socket

      socket.onopen = () => {
        if (disposed) { socket.close(); return }
        setConnected(true)
      }

      socket.onclose = () => {
        socketRef.current = null
        if (disposed) return
        setConnected(false)
        dropTerminals()
        const delay = retryDelay(attemptRef.current)
        attemptRef.current += 1
        setAttempt(attemptRef.current)
        timer = window.setTimeout(connect, delay)
      }

      socket.onmessage = (event: MessageEvent<string>) => {
        const frame = parseFrame(typeof event.data === 'string' ? event.data : '')
        if (frame.kind === 'output') {
          const id = activeIdRef.current
          if (id !== null) terms.get(id)?.term.write(frame.data)
          return
        }
        const message = frame.message
        if (message.type === 'created' && 'id' in message) {
          attemptRef.current = 0
          ensureTerm(message.id)
          activeIdRef.current = message.id
          setState(current => sessionCreated(current, message))
          return
        }
        if (message.type === 'exited' && 'id' in message) {
          const code = 'exitCode' in message ? message.exitCode ?? 0 : 0
          terms.get(message.id)?.term.write(`\r\n\x1b[90m[${labels.exited}: ${String(code)}]\x1b[0m\r\n`)
          setState(current => sessionExited(current, message.id))
          return
        }
        if (message.type === 'error' && 'message' in message) {
          const id = activeIdRef.current
          terms.get(id ?? '')?.term.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`)
        }
      }
    }

    connect()

    return () => {
      disposed = true
      window.clearTimeout(timer)
      socketRef.current?.close()
      socketRef.current = null
      dropTerminals()
    }
  }, [ensureTerm, labels.exited, reconnectToken, ptyEnabled])

  // Mount whichever terminal is selected, and keep it fitted to the pane.
  useEffect(() => {
    if (!active || activeId === null) return
    mount(activeId)
    const host = hostRef.current
    if (host === null) return
    const observer = new ResizeObserver(() => { fitActive() })
    observer.observe(host)
    return () => { observer.disconnect() }
  }, [active, activeId, mount, fitActive])

  // Repaint every live terminal when the harness theme flips.
  useEffect(() => {
    const terms = termsRef.current
    const observer = new MutationObserver(() => {
      const theme = themeColors()
      for (const handle of terms.values()) handle.term.options.theme = theme
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
    return () => { observer.disconnect() }
  }, [])

  const selectTab = useCallback((id: string) => {
    activeIdRef.current = id
    setState(current => sessionSwitched(current, id))
    send({ type: 'switch', sessionId: id })
  }, [send])

  const closeTab = useCallback((id: string) => {
    send({ type: 'close', sessionId: id })
    termsRef.current.get(id)?.term.dispose()
    termsRef.current.delete(id)
    setState((current) => {
      const next = sessionClosed(current, id)
      if (next.activeId !== current.activeId) {
        activeIdRef.current = next.activeId
        if (next.activeId !== null) send({ type: 'switch', sessionId: next.activeId })
      }
      return next
    })
  }, [send])

  if (ptyEnabled === false) {
    return <div className={css.pane}><div className={css.status}>{labels.disabled}</div></div>
  }

  return (
    <div className={css.pane}>
      <div className={css.tabs}>
        {tabs.map(tab => (
          <div key={tab.id} className={tab.id === activeId ? `${css.tab} ${css.tabActive}` : css.tab}>
            <button type="button" className={css.tabLabel} onClick={() => { selectTab(tab.id) }}>
              {tab.shell}
              {tab.exited ? ` · ${labels.exited}` : ''}
            </button>
            <button type="button" className={css.tabClose} aria-label={labels.closeTab} onClick={() => { closeTab(tab.id) }}>×</button>
          </div>
        ))}
        <button type="button" className={css.newTab} aria-label={labels.newTab} onClick={() => { send({ type: 'create', cwd }) }}>+</button>
      </div>
      <div className={css.surface} ref={hostRef} />
      {connected ? null : (
        <div className={css.status}>
          <span>{attempt === 0 ? labels.connecting : labels.disconnected}</span>
          {attempt === 0 ? null : (
            <button type="button" className={css.retry} onClick={reconnectNow}>{labels.reconnect}</button>
          )}
        </div>
      )}
    </div>
  )
}
