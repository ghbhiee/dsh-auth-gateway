/** Read-only preview pane — images, markdown, source — with an edit mode. */

import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownText, ReadBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { bytesUrl, fetchStat, fetchText, writeText, WorkbenchApiError } from './api.ts'
import { htmlSandbox, languageOf, previewKind } from './preview-kind.ts'
import css from './FilePreview.module.css'

/**
 * How many lines the pane will lay out.
 *
 * The primitive's own default is 16 — right for a tool-result card, useless
 * for reading a file. The other extreme is worse: rendering every line of a
 * 30 000-line file locks the tab up for tens of seconds. This is a viewer's
 * middle: generous to read, quick to lay out, and honest about the remainder.
 * Anyone who needs the whole thing has a terminal in the same panel.
 */
const MAX_PREVIEW_LINES = 2000

/** What to preview. */
export interface FilePreviewProps {
  /** Root id the path belongs to. */
  root: string
  /** Path relative to the root. */
  path: string
  /** Basename, used for the label and for preview routing. */
  name: string
  /** Whether the host accepts writes. */
  writeEnabled: boolean
  /** Poll the file for outside changes while open. Off for one-shot inline previews. */
  poll?: boolean
  /** Called after a successful save, so the listing can refresh sizes. */
  onSaved: () => void
  /** Localized copy. */
  labels: {
    loading: string; binary: string; notUtf8: string; empty: string
    edit: string; save: string; cancel: string; saved: string
    staleVersion: string
    /** Shown while editing when the file changed underneath. */
    changedOnDisk: string
    /** Button that discards the draft and re-reads the current file. */
    reload: string
    /** Switch an HTML preview from the rendered frame to its source. */
    htmlViewSource: string
    /** Switch an HTML preview back from source to the rendered frame. */
    htmlViewRendered: string
    /** Opt the HTML frame into running its scripts (still origin-isolated). */
    htmlEnableScripts: string
    /** Turn the opted-in scripts back off. */
    htmlDisableScripts: string
  }
}

/**
 * Build the preview pane's localized copy from a translate function.
 * @param t - locale lookup for the workbench namespace.
 * @returns the label bag {@link FilePreview} expects.
 */
export function filePreviewLabels(t: PropsLocale<'workbench'>['t']): FilePreviewProps['labels'] {
  return {
    loading: t('loading'), binary: t('binary'), notUtf8: t('notUtf8'), empty: t('emptyFile'),
    edit: t('edit'), save: t('save'), cancel: t('cancel'), saved: t('saved'),
    staleVersion: t('staleVersion'), changedOnDisk: t('changedOnDisk'), reload: t('reload'),
    htmlViewSource: t('htmlViewSource'), htmlViewRendered: t('htmlViewRendered'),
    htmlEnableScripts: t('htmlEnableScripts'), htmlDisableScripts: t('htmlDisableScripts'),
  }
}

interface TextState {
  status: 'loading' | 'ready' | 'error'
  content: string
  message: string
  /** Freshness token from the read this edit is based on. */
  version: string | null
}

/** Render one file, choosing the renderer from its extension. */
export function FilePreview({ root, path, name, writeEnabled, poll = true, onSaved, labels }: FilePreviewProps) {
  const kind = previewKind(name)
  const isHtml = kind === 'html'
  const [state, setState] = useState<TextState>({ status: 'loading', content: '', message: '', version: null })
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [changedOnDisk, setChangedOnDisk] = useState(false)
  /** HTML only: show the source instead of the rendered frame. */
  const [htmlSource, setHtmlSource] = useState(false)
  /** HTML only: whether the frame may run its scripts (origin-isolated). */
  const [htmlScripts, setHtmlScripts] = useState(false)

  // Every file starts rendered and inert. Scripts are a per-file opt-in, so a
  // new file must never inherit the last one's "scripts on" — that default is
  // the safe one, and switching files silently keeping it would not be.
  useEffect(() => {
    setHtmlSource(false)
    setHtmlScripts(false)
  }, [root, path])

  useEffect(() => {
    if (kind === 'image') return
    let cancelled = false
    setState({ status: 'loading', content: '', message: '', version: null })
    setDraft(null)
    fetchText(root, path).then((file) => {
      if (!cancelled) setState({ status: 'ready', content: file.content, message: '', version: file.version })
    }).catch((error: unknown) => {
      if (cancelled) return
      const message = error instanceof WorkbenchApiError && (error.code === 'binary_file' || error.code === 'not_utf8')
        ? (error.code === 'binary_file' ? labels.binary : labels.notUtf8)
        : error instanceof Error ? error.message : String(error)
      setState({ status: 'error', content: '', message, version: null })
    })
    return () => { cancelled = true }
  }, [root, path, kind, labels.binary, labels.notUtf8])

  // Same reasoning as the listing: the agent rewrites files while they are on
  // screen. A version probe is cheap; re-reading only happens when it moved.
  // While the user is editing, the draft is never touched — the pane says the
  // file changed and the conditional save refuses to clobber it anyway.
  useEffect(() => {
    if (!poll || kind === 'image' || state.status !== 'ready') return
    let cancelled = false
    const check = (): void => {
      if (document.visibilityState !== 'visible') return
      fetchStat(root, path).then((info) => {
        if (cancelled || info.version === null || info.version === state.version) return
        if (draft !== null) { setChangedOnDisk(true); return }
        return fetchText(root, path).then((file) => {
          if (!cancelled) setState({ status: 'ready', content: file.content, message: '', version: file.version })
        })
      }).catch(() => { /* a transient failure is not worth shouting about mid-poll */ })
    }
    const timer = window.setInterval(check, 5000)
    const onVisible = (): void => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', check)
    }
  }, [poll, root, path, kind, state.status, state.version, draft])

  if (kind === 'image') {
    return (
      <div className={css.imageWrap}>
        <img className={css.image} src={bytesUrl(root, path)} alt={name} />
      </div>
    )
  }

  if (state.status === 'loading') return <div className={css.notice}>{labels.loading}</div>
  if (state.status === 'error') return <div className={css.notice}>{state.message}</div>

  const save = (): void => {
    if (draft === null) return
    setSaving(true)
    writeText(root, path, draft, state.version).then((version) => {
      // The host hands back the new token, so the pane stays in step without
      // another read and the freshness poll has something to compare with.
      setState({ status: 'ready', content: draft, message: '', version })
      setChangedOnDisk(false)
      setDraft(null)
      setSavedAt(Date.now())
      onSaved()
    }).catch((error: unknown) => {
      const stale = error instanceof WorkbenchApiError && error.code === 'stale_version'
      const message = stale
        ? labels.staleVersion
        : error instanceof Error ? error.message : String(error)
      setState(current => ({ ...current, message }))
      // A stale refusal means the file moved under this edit. Flag it so the
      // Reload affordance appears — clicking the file again is a no-op (the load
      // effect is keyed on the path, which has not changed), and the freshness
      // poll only recovers after Cancel and only while the tab is visible.
      if (stale) setChangedOnDisk(true)
    }).finally(() => { setSaving(false) })
  }

  // Recover from an out-of-date edit: re-read the current file and start the
  // draft over from it, so the user redoes their change on top of what is now
  // on disk rather than clobbering it. The one reliable, immediate path back —
  // it needs neither a path change nor the visibility-gated poll.
  const reload = (): void => {
    fetchText(root, path).then((file) => {
      setState({ status: 'ready', content: file.content, message: '', version: file.version })
      setChangedOnDisk(false)
      setDraft(file.content)
    }).catch((error: unknown) => {
      setState(current => ({ ...current, message: error instanceof Error ? error.message : String(error) }))
    })
  }

  const toolbar = (
    <div className={css.toolbar}>
      <span className={css.path}>{path}</span>
      {state.message === '' ? null : <span className={css.error}>{state.message}</span>}
      {changedOnDisk && draft !== null ? <span className={css.error}>{labels.changedOnDisk}</span> : null}
      {savedAt !== 0 && draft === null ? <span className={css.saved}>{labels.saved}</span> : null}
      {isHtml && draft === null ? (
        <>
          <button type="button" className={css.button} onClick={() => { setHtmlSource(source => !source) }}>
            {htmlSource ? labels.htmlViewRendered : labels.htmlViewSource}
          </button>
          {htmlSource ? null : (
            <button
              type="button"
              className={css.button}
              aria-pressed={htmlScripts}
              onClick={() => { setHtmlScripts(scripts => !scripts) }}
            >
              {htmlScripts ? labels.htmlDisableScripts : labels.htmlEnableScripts}
            </button>
          )}
        </>
      ) : null}
      {writeEnabled && draft === null
        ? <button type="button" className={css.button} onClick={() => { setDraft(state.content) }}>{labels.edit}</button>
        : null}
      {draft === null ? null : (
        <>
          <button type="button" className={css.button} disabled={saving} onClick={save}>{labels.save}</button>
          {changedOnDisk ? <button type="button" className={css.button} onClick={reload}>{labels.reload}</button> : null}
          <button type="button" className={css.button} onClick={() => { setDraft(null) }}>{labels.cancel}</button>
        </>
      )}
    </div>
  )

  if (draft !== null) {
    return (
      <div className={css.editor}>
        {toolbar}
        <textarea
          className={css.textarea}
          value={draft}
          spellCheck={false}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); save() }
          }}
        />
      </div>
    )
  }

  if (state.content === '') {
    return <div className={css.editor}>{toolbar}<div className={css.notice}>{labels.empty}</div></div>
  }

  // HTML renders in a sandboxed frame rather than as source. The frame is the
  // whole trust boundary: srcDoc gives it an opaque origin, and `htmlSandbox`
  // never grants `allow-same-origin`, so even a workspace page full of
  // <script> cannot reach the app it is being viewed inside. "View source"
  // drops back to the read block; Edit (below) still edits the raw markup.
  if (isHtml && !htmlSource) {
    return (
      <div className={css.editor}>
        {toolbar}
        <iframe
          // Remount when the mode flips: mutating `sandbox` on a live srcdoc
          // frame does not re-load it, so the document would keep whatever
          // sandbox it first loaded under. A fresh element loads the markup
          // under the current sandbox, which is the whole point of the toggle.
          key={htmlScripts ? 'scripts' : 'inert'}
          className={css.htmlFrame}
          title={name}
          srcDoc={state.content}
          sandbox={htmlSandbox(htmlScripts)}
          referrerPolicy="no-referrer"
        />
      </div>
    )
  }

  // Markdown has no windowing of its own, so an enormous document falls back
  // to the line-capped source view rather than parsing megabytes on the main
  // thread.
  if (kind === 'markdown' && state.content.split('\n').length <= MAX_PREVIEW_LINES) {
    return (
      <div className={css.editor}>
        {toolbar}
        <div className={css.markdown}><MarkdownText text={state.content} /></div>
      </div>
    )
  }

  const allLines = state.content.split('\n')
  const lines = allLines.slice(0, MAX_PREVIEW_LINES).map((text, index) => ({ number: index + 1, text }))
  return (
    <div className={css.editor}>
      {toolbar}
      <ReadBlock
        label={name}
        lines={lines}
        totalLines={allLines.length}
        lang={languageOf(name)}
        maxLines={MAX_PREVIEW_LINES}
        className={css.read}
      />
    </div>
  )
}
