/**
 * Narrow-viewport shell, host half.
 *
 * The plugin's behaviour is all in the browser, but its settings belong here:
 * a client entry never sees its row's config, so the browser asks for it over
 * a small route rather than shipping hardcoded numbers.
 *
 * @module dsh-plugin-mobile-shell
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name. */
export const name = 'mobile-shell'

/** Services the host half needs. */
export const inject = ['webServer']

/** Deployment-varying knobs. */
export interface Config {
  /** Frame width at or below which the sidebar becomes a drawer. */
  narrowMaxWidth: number
  /**
   * Browser tab title. `{host}` is replaced with the page's hostname; an empty
   * string leaves the shell's own session title alone.
   */
  documentTitle: string
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  narrowMaxWidth: z.number().default(1023),
  documentTitle: z.string().default('DSH · {host}'),
})

/** Publish the settings the browser half needs. */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isFinite(config.narrowMaxWidth) || config.narrowMaxWidth <= 0) {
    throw new Error(`mobile-shell: narrowMaxWidth must be a positive number, got ${String(config.narrowMaxWidth)}`)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/plugins/mobile-shell/config',
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ narrowMaxWidth: config.narrowMaxWidth, documentTitle: config.documentTitle }))
    },
  }), 'mobile-shell: config route')
}
