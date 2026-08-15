/**
 * Turning host error codes into something a person should read.
 *
 * The API's messages are written for whoever is holding a request log: they are
 * English, they name query parameters, and they describe the rule rather than
 * the way out. Showing them verbatim in the panel is how a user ends up being
 * told to "pass overwrite=1". The codes are the stable part, so the browser
 * translates those and keeps the host's text only for codes it does not know.
 *
 * @module dsh-plugin-workbench/client/error-copy
 */

import { WorkbenchApiError } from './api.ts'

/** The error codes the browser has its own words for. */
export const KNOWN_ERROR_CODES = [
  'destination_exists',
  'protected_file',
  'protected_path',
  'sandbox_read_only',
  'write_disabled',
  'outside_writable_root',
  'outside_root',
  'root_is_not_a_target',
  'symlink_target',
  'body_too_large',
  'file_too_large',
  'not_found',
  'invalid_path',
  'is_directory',
  'not_a_file',
  'query_too_short',
  'stale_version',
] as const

/** Localized copy for {@link KNOWN_ERROR_CODES}. */
export type ErrorCopy = Record<(typeof KNOWN_ERROR_CODES)[number], string>

/**
 * Pick the sentence to show for a failure.
 * @param error - whatever the call threw.
 * @param copy - localized copy keyed by error code.
 * @returns a message meant for the person looking at the screen.
 */
export function messageFor(error: unknown, copy: ErrorCopy): string {
  if (error instanceof WorkbenchApiError) {
    const known = (KNOWN_ERROR_CODES as readonly string[]).includes(error.code)
    if (known) return copy[error.code as keyof ErrorCopy]
    // An unknown code means the host grew a case the browser has not learned;
    // its own text beats inventing a vague apology.
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}
