/**
 * CLI startup: parse the flags the launcher forwards, then publish them as the
 * `cliStartup` service the runner injects.
 *
 * @module dsh-plugin-cli-session/startup
 */

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Cordis plugin name. */
export const name = 'cli-startup'

/** Services required before this plugin can parse the command line. */
export const inject = ['cmdlineArgs']

/** Service key this plugin provides. */
export const CLI_STARTUP_SERVICE = 'cliStartup'

/** Output shapes the runner can emit. */
export const OUTPUT_FORMATS = ['text', 'json', 'stream-json'] as const

/** One parsed invocation. */
export interface CliStartupRequest {
  /** What the runner should do with the session. */
  action: 'list' | 'new' | 'resume-last' | 'resume-session'
  /** Task text; empty for `--list`. */
  task: string
  /** Explicit session id for `resume-session`; empty otherwise. */
  sessionId: string
  /** One of {@link OUTPUT_FORMATS}. */
  outputFormat: string
  /** JSON Schema the answer should follow; empty when unset. */
  jsonSchema: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Parsed CLI invocation published by this plugin. */
    cliStartup: CliStartupRequest
  }
}

function cliCommand(): Command {
  return new Command()
    .name('dsh --profile <name>')
    .description('Run a task in a resumable session; print conversational text or machine-readable JSON.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .option('-o, --output-format <format>', `output format: ${OUTPUT_FORMATS.join(', ')}`, 'text')
    .option('--json-schema <schema>', 'JSON Schema the response should conform to (asked for in the prompt)')
    .option('-n, --new', 'start a new session (this is the default)')
    .option('-r, --resume', 'resume the most recent session of this profile in the current working directory')
    .option('-s, --session <id>', 'resume a specific session id')
    .option('-w, --workdir <dir>', 'working directory for a NEW session (chdir before creating)')
    .option('-l, --list', "list this profile's sessions in the current working directory and exit")
    // This program owns the whole command line of whatever profile installs
    // the plugin. In the wrong profile that shows up as the host app's own
    // flags being rejected, so the error says who is parsing.
    .showHelpAfterError('(dsh-plugin-cli-session owns this command line; install it in a headless-style profile)')
    .addHelpText('after', [
      '',
      'Examples:',
      '  dsh --profile chat "explain this file"',
      '  dsh --profile chat --resume "follow-up"',
      '  dsh --profile api -o json "explain this file"',
      '  dsh --profile api -o json --json-schema \'{"type":"object"}\' "summarize this file"',
      '',
    ].join('\n'))
}

/** Parse argv and publish the request. */
export function apply(ctx: Context): void {
  const program = cliCommand()
  program.action(() => {
    const opts = program.opts<{
      outputFormat?: string
      jsonSchema?: string
      new?: boolean
      resume?: boolean
      session?: string
      workdir?: string
      list?: boolean
    }>()
    const outputFormat = opts.outputFormat ?? 'text'
    if (!OUTPUT_FORMATS.includes(outputFormat as typeof OUTPUT_FORMATS[number])) {
      program.error(`error: --output-format must be one of: ${OUTPUT_FORMATS.join(', ')}`)
    }

    if (opts.list === true) {
      ctx.provide(CLI_STARTUP_SERVICE, {
        action: 'list',
        task: '',
        sessionId: '',
        outputFormat,
        jsonSchema: '',
      } satisfies CliStartupRequest)
      return
    }

    const task = program.args.join(' ').trim()
    if (task === '') program.error('error: a task is required, e.g. dsh --profile chat "your task"')
    if (opts.session !== undefined && opts.resume === true) program.error('error: --session and --resume are mutually exclusive')
    if (opts.new === true && (opts.session !== undefined || opts.resume === true)) {
      program.error('error: --new cannot be combined with --session/--resume')
    }
    if (opts.workdir !== undefined && (opts.session !== undefined || opts.resume === true)) {
      program.error('error: --workdir applies to a new session only; a resumed session keeps its own cwd')
    }
    if (opts.workdir !== undefined) {
      const dir = resolve(opts.workdir)
      mkdirSync(dir, { recursive: true })
      process.chdir(dir)
    }

    ctx.provide(CLI_STARTUP_SERVICE, {
      action: opts.session !== undefined ? 'resume-session' : (opts.resume === true ? 'resume-last' : 'new'),
      task,
      sessionId: opts.session ?? '',
      outputFormat,
      jsonSchema: opts.jsonSchema ?? '',
    } satisfies CliStartupRequest)
  })
  // dsh-cmdline's types are pinned to its own (older) commander copy, and an
  // out-of-tree plugin necessarily brings its own — which is why parseCmdline
  // classifies commander errors structurally instead of by instanceof. The
  // shapes differ only in readonly-ness, so the cast is the whole fix.
  parseCmdline(ctx, program as unknown as Parameters<typeof parseCmdline>[1])
}
