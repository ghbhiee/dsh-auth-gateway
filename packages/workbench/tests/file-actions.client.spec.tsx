// @vitest-environment jsdom
/**
 * The mutating controls: inline naming instead of `prompt()`, and an
 * arm-then-confirm delete instead of `confirm()`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileActions, type FileActionLabels, type FileActionsProps } from '../src/client/FileActions.tsx'

const labels: FileActionLabels = {
  newFile: 'New file',
  newFolder: 'New folder',
  upload: 'Upload',
  rename: 'Rename',
  delete: 'Delete',
  confirmDelete: 'Confirm delete?',
  create: 'OK',
  cancel: 'Cancel',
  namePlaceholder: 'Name',
}

function setup(overrides: Partial<FileActionsProps> = {}) {
  const props: FileActionsProps = {
    selected: null,
    labels,
    onCreateFile: vi.fn().mockResolvedValue(undefined),
    onCreateFolder: vi.fn().mockResolvedValue(undefined),
    onUpload: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    ...overrides,
  }
  render(<FileActions {...props} />)
  return props
}

const type = (value: string): void => {
  fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value } })
}

afterEach(cleanup)

describe('creating', () => {
  it('asks for a name inline, then creates the file', async () => {
    const props = setup()
    expect(screen.queryByPlaceholderText('Name')).toBeNull()
    fireEvent.click(screen.getByText('New file'))
    type('notes.md')
    fireEvent.click(screen.getByText('OK'))
    await waitFor(() => { expect(props.onCreateFile).toHaveBeenCalledWith('notes.md') })
  })

  it('creates a folder through the same flow', async () => {
    const props = setup()
    fireEvent.click(screen.getByText('New folder'))
    type('drafts')
    fireEvent.click(screen.getByText('OK'))
    await waitFor(() => { expect(props.onCreateFolder).toHaveBeenCalledWith('drafts') })
  })

  it('submits on Enter', async () => {
    const props = setup()
    fireEvent.click(screen.getByText('New file'))
    type('quick.txt')
    fireEvent.keyDown(screen.getByPlaceholderText('Name'), { key: 'Enter' })
    await waitFor(() => { expect(props.onCreateFile).toHaveBeenCalledWith('quick.txt') })
  })

  it('abandons on Escape', () => {
    const props = setup()
    fireEvent.click(screen.getByText('New file'))
    type('never.txt')
    fireEvent.keyDown(screen.getByPlaceholderText('Name'), { key: 'Escape' })
    expect(screen.queryByPlaceholderText('Name')).toBeNull()
    expect(props.onCreateFile).not.toHaveBeenCalled()
  })

  it('trims the name and ignores a blank one', () => {
    const props = setup()
    fireEvent.click(screen.getByText('New file'))
    type('   ')
    fireEvent.click(screen.getByText('OK'))
    expect(props.onCreateFile).not.toHaveBeenCalled()
  })

  it('trims surrounding whitespace off a real name', async () => {
    const props = setup()
    fireEvent.click(screen.getByText('New file'))
    type('  spaced.txt  ')
    fireEvent.click(screen.getByText('OK'))
    await waitFor(() => { expect(props.onCreateFile).toHaveBeenCalledWith('spaced.txt') })
  })
})

describe('selection-scoped actions', () => {
  const selected = { path: 'sub/notes.md', name: 'notes.md', isDirectory: false }

  it('offers nothing to rename or delete until something is marked', () => {
    setup()
    expect(screen.queryByText('Rename')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('pre-fills the current name when renaming', () => {
    setup({ selected })
    fireEvent.click(screen.getByText('Rename'))
    expect((screen.getByPlaceholderText('Name') as HTMLInputElement).value).toBe('notes.md')
  })

  it('renames to the typed name', async () => {
    const props = setup({ selected })
    fireEvent.click(screen.getByText('Rename'))
    type('renamed.md')
    fireEvent.click(screen.getByText('OK'))
    await waitFor(() => { expect(props.onRename).toHaveBeenCalledWith('renamed.md') })
  })
})

describe('deleting', () => {
  const selected = { path: 'sub/notes.md', name: 'notes.md', isDirectory: false }

  it('arms on the first click and does not delete yet', () => {
    const props = setup({ selected })
    fireEvent.click(screen.getByText('Delete'))
    expect(props.onDelete).not.toHaveBeenCalled()
    expect(screen.getByText('Confirm delete?')).toBeDefined()
  })

  it('deletes on the confirming second click', async () => {
    const props = setup({ selected })
    fireEvent.click(screen.getByText('Delete'))
    fireEvent.click(screen.getByText('Confirm delete?'))
    await waitFor(() => { expect(props.onDelete).toHaveBeenCalledTimes(1) })
  })

  it('disarms when another flow starts', () => {
    setup({ selected })
    fireEvent.click(screen.getByText('Delete'))
    fireEvent.click(screen.getByText('New file'))
    expect(screen.queryByText('Confirm delete?')).toBeNull()
    expect(screen.getByText('Delete')).toBeDefined()
  })
})

describe('uploading', () => {
  it('passes the picked file straight through', async () => {
    const props = setup()
    const input = document.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })
    fireEvent.change(input as Element, { target: { files: [file] } })
    await waitFor(() => { expect(props.onUpload).toHaveBeenCalledWith(file) })
  })
})

describe('failures', () => {
  it('hands the failure up rather than swallowing it', async () => {
    // The error object travels, not a string: the panel decides the wording,
    // because the host's own text is written for an operator.
    const failure = new Error('protected_path')
    const props = setup({ onCreateFolder: vi.fn().mockRejectedValue(failure) })
    fireEvent.click(screen.getByText('New folder'))
    type('.git')
    fireEvent.click(screen.getByText('OK'))
    await waitFor(() => { expect(props.onError).toHaveBeenCalledWith(failure) })
  })
})
