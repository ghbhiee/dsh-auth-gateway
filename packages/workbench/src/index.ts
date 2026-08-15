/**
 * Workbench host half: HTTP + WebSocket surface for the browser workbench
 * (file browsing, previews, and — later — a PTY terminal).
 *
 * Everything is served under `/plugins/workbench/…` on the harness web server
 * rather than through the RPC gateway: `RpcMethodMap` is a closed interface
 * whose dispatch table is compiler-locked, so an out-of-tree plugin cannot add
 * methods to it.
 *
 * @module dsh-plugin-workbench
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createApiHandler } from './api.ts'
import { validateReadRoots } from './roots.ts'
import { createPtyGateway } from './pty.ts'

/** Cordis plugin name. */
export const name = 'workbench'

/** Services the host half needs to be present. */
export const inject = ['webServer', 'fs', 'sandboxPolicy']

/** Deployment-varying knobs. Everything mutating is off until asked for. */
export interface Config {
  /** Extra absolute directories the browser may read, beyond the session workspace root. */
  readRoots: string[]
  /** Allow write/rename/delete/upload through the file API. */
  writeEnabled: boolean
  /** Allow spawning PTY sessions from the browser. */
  ptyEnabled: boolean
  /** Refuse requests that did not arrive over the loopback interface. */
  loopbackOnly: boolean
  /** Cap on entries returned by one directory listing. */
  maxListEntries: number
  /** Shell to spawn for browser terminals; empty means detect from the environment. */
  shell: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  readRoots: z.array(z.string()).default([]),
  writeEnabled: z.boolean().default(false),
  ptyEnabled: z.boolean().default(false),
  loopbackOnly: z.boolean().default(true),
  maxListEntries: z.number().default(1000),
  shell: z.string().default(''),
})

/** Mount the workbench host surface. */
export function apply(ctx: Context, config: Config): void {
  // Fail here rather than answering puzzling 404s later.
  validateReadRoots(config.readRoots)

  const handler = createApiHandler(ctx, {
    readRoots: config.readRoots,
    loopbackOnly: config.loopbackOnly,
    maxListEntries: config.maxListEntries,
    writeEnabled: config.writeEnabled,
    ptyEnabled: config.ptyEnabled,
  })

  // The webserver contract wants an absolute pathname with no trailing slash;
  // one here makes the prefix match nothing.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/plugins/workbench/api',
    handler,
  }), 'workbench: file API')

  if (!config.ptyEnabled) return

  ctx.effect(() => {
    const gateway = createPtyGateway(ctx, { loopbackOnly: config.loopbackOnly, shell: config.shell })
    const removeRoute = ctx.webServer.registerUpgrade({
      path: '/plugins/workbench/pty',
      handler: gateway.handler,
    })
    // One disposer, ordered: stop accepting first, then kill live shells.
    return () => {
      removeRoute()
      gateway.dispose()
    }
  }, 'workbench: pty gateway')
}
