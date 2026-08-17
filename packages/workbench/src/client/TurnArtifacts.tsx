/**
 * The turn footer's file artifacts: chips for the files a completed turn wrote
 * or named, each expanding to an inline preview right in the conversation.
 *
 * This takes over the `conversation.chat.turnTail` chain (a single-winner seat
 * dsh's own ProducedFiles otherwise renders): it shows the same produced files
 * — read from the `deliverables` turn data via the `matched` prop — plus files
 * the assistant merely named in its prose (which the structured signal misses,
 * e.g. a `bash` step's output), each checked to exist before it becomes a chip.
 * Clicking a chip previews the file inline through the workbench's own safe
 * renderer (sandboxed HTML, images, code), not the host opener.
 */

import { useEffect, useState } from 'react'
import type { AssistantBlock, ConversationNode, ConversationSnapshot, SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { extractPathTokens } from './artifact-paths.ts'
import { resolveArtifacts, type ResolvedArtifact } from './artifact-resolve.ts'
import { FilePreview, filePreviewLabels } from './FilePreview.tsx'
import css from './TurnArtifacts.module.css'

/** Props the framework composes for the turn-tail registration (subset we use). */
export type TurnArtifactsProps = {
  /** Produced-file paths, from the chain `select` reading the deliverables turn data. */
  matched: readonly string[]
  /** The closing assistant message's seq — the anchor for reading its prose. */
  seq: number
  /** Conversation-snapshot selector, for the closing message text. */
  useSession: SnapshotSelectorHook<ConversationSnapshot>
  /** Session-list selector, for this session's working directory. */
  useSessions: SnapshotSelectorHook<SessionListState>
  /** Which session this turn belongs to. */
  sessionId: SessionId
} & PropsLocale<'workbench'>

/** Concatenated text of the assistant message at `seq`, or '' if not found. */
function closingText(snapshot: ConversationSnapshot, seq: number): string {
  const node: ConversationNode | undefined = snapshot.nodes.find(item => item.kind === 'assistant' && item.seq === seq)
  if (node === undefined || node.kind !== 'assistant') return ''
  return node.blocks
    .filter((block): block is Extract<AssistantBlock, { kind: 'text' }> => block.kind === 'text')
    .map(block => block.text)
    .join('')
}

/** Render the turn's file chips and an inline preview for the expanded one. */
export function TurnArtifacts({ matched, seq, useSession, useSessions, sessionId, t }: TurnArtifactsProps) {
  const text = useSession(snapshot => closingText(snapshot, seq))
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const [files, setFiles] = useState<ResolvedArtifact[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

  // Union the structured produced paths with what the prose names, then keep
  // only what resolves to a real file inside a read root. Async (it stats the
  // candidates), so the footer stays empty until the check settles.
  useEffect(() => {
    const tokens = [...new Set([...matched, ...extractPathTokens(text)])]
    if (tokens.length === 0) { setFiles([]); return }
    let cancelled = false
    resolveArtifacts(tokens, cwd).then((resolved) => {
      if (!cancelled) setFiles(resolved)
    }).catch(() => { /* a failed probe just means no chips */ })
    return () => { cancelled = true }
  }, [matched, text, cwd])

  if (files.length === 0) return null
  const open = files.find(file => file.absolute === expanded) ?? null

  return (
    <div className={css.root}>
      <div className={css.chips}>
        {files.map(file => (
          <button
            key={file.absolute}
            type="button"
            className={file.absolute === expanded ? `${css.chip} ${css.chipActive}` : css.chip}
            title={file.absolute}
            aria-expanded={file.absolute === expanded}
            onClick={() => { setExpanded(current => (current === file.absolute ? null : file.absolute)) }}
          >
            {file.name}
          </button>
        ))}
      </div>
      {open === null ? null : (
        <div className={css.preview}>
          <FilePreview
            root={open.root}
            path={open.path}
            name={open.name}
            writeEnabled={false}
            poll={false}
            onSaved={() => { /* read-only inline preview */ }}
            labels={filePreviewLabels(t)}
          />
        </div>
      )}
    </div>
  )
}
