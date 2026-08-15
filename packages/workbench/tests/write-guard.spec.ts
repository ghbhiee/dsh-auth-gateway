/** The write fence: sandbox mode, protected names, writable roots. */

import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { assertWritable, assertWritableRequest } from '../src/write-guard.ts'

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** A context stub exposing only what the guard reads. */
function fakeCtx(mode: Mode, workspaceRoot: string): Context {
  return { sandboxPolicy: { resolve: () => ({ mode, workspaceRoot }) } } as unknown as Context
}

let workspace: string
let elsewhere: string

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'wb-guard-'))
  workspace = join(base, 'ws')
  elsewhere = join(base, 'elsewhere')
  await mkdir(workspace, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
})

afterAll(async () => {
  await rm(join(workspace, '..'), { recursive: true, force: true })
})

describe('assertWritableRequest', () => {
  it('refuses everything in read-only mode', () => {
    expect(() => { assertWritableRequest(fakeCtx('read-only', workspace), 'notes.txt') })
      .toThrowError(/read-only/)
  })

  it.each(['.env', 'auth.json', 'id_rsa', '.npmrc'])('refuses the protected name %s', (name) => {
    expect(() => { assertWritableRequest(fakeCtx('workspace-write', workspace), `sub/${name}`) })
      .toThrowError(/cannot be modified/)
  })

  it.each(['.git/config', 'sub/.ssh/key', 'pkg/node_modules/x'])('refuses the protected segment in %s', (path) => {
    expect(() => { assertWritableRequest(fakeCtx('workspace-write', workspace), path) })
      .toThrowError(/cannot be modified/)
  })

  it('allows an ordinary path', () => {
    expect(() => { assertWritableRequest(fakeCtx('workspace-write', workspace), 'sub/notes.txt') })
      .not.toThrow()
  })

  it('runs before any filesystem access, so a missing parent still reports the policy failure', () => {
    // The regression this pins: resolving first turned a 403 into a 404.
    expect(() => { assertWritableRequest(fakeCtx('workspace-write', workspace), 'absent/.git/hook') })
      .toThrowError(/\.git\//)
  })
})

describe('assertWritable', () => {
  it('accepts a target inside the workspace root', async () => {
    await expect(assertWritable(fakeCtx('workspace-write', workspace), join(workspace, 'new.txt')))
      .resolves.toBeUndefined()
  })

  it('accepts a target in the OS temp dir', async () => {
    await expect(assertWritable(fakeCtx('workspace-write', workspace), join(tmpdir(), 'wb-scratch.txt')))
      .resolves.toBeUndefined()
  })

  it('refuses a target outside every writable root', async () => {
    // Not `elsewhere`: it lives under the OS temp dir, which the sandbox
    // policy counts as writable — same rule the harness applies.
    await expect(assertWritable(fakeCtx('workspace-write', workspace), '/etc/wb-nope.txt'))
      .rejects.toMatchObject({ code: 'outside_writable_root', status: 403 })
  })

  it('counts the OS temp dir as writable, like the harness does', async () => {
    await expect(assertWritable(fakeCtx('workspace-write', workspace), join(elsewhere, 'new.txt')))
      .resolves.toBeUndefined()
  })

  it('skips the root check under full access', async () => {
    await expect(assertWritable(fakeCtx('danger-full-access', workspace), join(elsewhere, 'new.txt')))
      .resolves.toBeUndefined()
  })

  it('still refuses a protected name under full access', async () => {
    await expect(assertWritable(fakeCtx('danger-full-access', workspace), join(workspace, '.env')))
      .rejects.toMatchObject({ code: 'protected_file' })
  })
})
