/**
 * Mutating controls for the file list: create, upload, rename, delete.
 *
 * Naming and confirmation are inline rather than `prompt()`/`confirm()`, which
 * are easy for an embedding context to suppress and impossible to style.
 */

import { useRef, useState } from 'react'
import css from './FileActions.module.css'

/** Localized copy for the action bar. */
export interface FileActionLabels {
  newFile: string
  newFolder: string
  upload: string
  rename: string
  delete: string
  confirmDelete: string
  create: string
  cancel: string
  namePlaceholder: string
}

/** What the action bar can do; every call refreshes the listing on success. */
export interface FileActionsProps {
  /** Currently selected entry, if any. */
  selected: { path: string; name: string; isDirectory: boolean } | null
  /** Localized copy. */
  labels: FileActionLabels
  /** Create an empty file in the current directory. */
  onCreateFile: (name: string) => Promise<void>
  /** Create a directory in the current directory. */
  onCreateFolder: (name: string) => Promise<void>
  /** Upload one picked file into the current directory. */
  onUpload: (file: File) => Promise<void>
  /** Rename the selected entry. */
  onRename: (name: string) => Promise<void>
  /** Delete the selected entry. */
  onDelete: () => Promise<void>
  /** Report a failure to the surrounding panel, which words it for the user. */
  onError: (error: unknown) => void
}

type Pending = 'file' | 'folder' | 'rename' | null

/** Render the action bar and its inline name/confirm affordances. */
export function FileActions(props: FileActionsProps) {
  const { selected, labels, onError } = props
  const [pending, setPending] = useState<Pending>(null)
  const [name, setName] = useState('')
  const [armed, setArmed] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const run = (action: () => Promise<void>): void => {
    action().catch((error: unknown) => { onError(error) })
  }

  const startNaming = (mode: Exclude<Pending, null>): void => {
    setPending(mode)
    setName(mode === 'rename' ? selected?.name ?? '' : '')
    setArmed(false)
  }

  const submitName = (): void => {
    const trimmed = name.trim()
    setPending(null)
    if (trimmed === '') return
    if (pending === 'file') run(() => props.onCreateFile(trimmed))
    if (pending === 'folder') run(() => props.onCreateFolder(trimmed))
    if (pending === 'rename') run(() => props.onRename(trimmed))
  }

  return (
    <div className={css.actions}>
      <div className={css.row}>
        <button type="button" className={css.button} onClick={() => { startNaming('file') }}>{labels.newFile}</button>
        <button type="button" className={css.button} onClick={() => { startNaming('folder') }}>{labels.newFolder}</button>
        <button type="button" className={css.button} onClick={() => fileInput.current?.click()}>{labels.upload}</button>
        <input
          ref={fileInput}
          type="file"
          className={css.hidden}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) run(() => props.onUpload(file))
          }}
        />
      </div>

      {selected === null ? null : (
        <div className={css.row}>
          <button type="button" className={css.button} onClick={() => { startNaming('rename') }}>{labels.rename}</button>
          <button
            type="button"
            className={armed ? `${css.button} ${css.danger}` : css.button}
            onClick={() => {
              if (!armed) { setArmed(true); return }
              setArmed(false)
              run(props.onDelete)
            }}
          >
            {armed ? labels.confirmDelete : labels.delete}
          </button>
        </div>
      )}

      {pending === null ? null : (
        <div className={css.row}>
          <input
            className={css.input}
            autoFocus
            value={name}
            placeholder={labels.namePlaceholder}
            onChange={(event) => { setName(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitName()
              if (event.key === 'Escape') setPending(null)
            }}
          />
          <button type="button" className={css.button} onClick={submitName}>{labels.create}</button>
          <button type="button" className={css.button} onClick={() => { setPending(null) }}>{labels.cancel}</button>
        </div>
      )}
    </div>
  )
}
