/** Host error codes become sentences meant for a person. */

import { describe, expect, it } from 'vitest'
import { WorkbenchApiError } from '../src/client/api.ts'
import { KNOWN_ERROR_CODES, messageFor, type ErrorCopy } from '../src/client/error-copy.ts'

const copy = Object.fromEntries(KNOWN_ERROR_CODES.map(code => [code, `copy:${code}`])) as ErrorCopy

describe('messageFor', () => {
  it('uses its own words for a code it knows', () => {
    const error = new WorkbenchApiError('destination_exists', 'Something is already there; pass overwrite=1 to replace it')
    // The host tells an operator to pass a query parameter; a user should not read that.
    expect(messageFor(error, copy)).toBe('copy:destination_exists')
  })

  it('covers every code it claims to know', () => {
    for (const code of KNOWN_ERROR_CODES) {
      expect(messageFor(new WorkbenchApiError(code, 'raw'), copy)).toBe(`copy:${code}`)
    }
  })

  it('falls back to the host text for a code it has not learned', () => {
    const error = new WorkbenchApiError('some_future_code', 'the host explains itself')
    expect(messageFor(error, copy)).toBe('the host explains itself')
  })

  it('handles a plain error', () => {
    expect(messageFor(new Error('network down'), copy)).toBe('network down')
  })

  it('handles something that is not an error at all', () => {
    expect(messageFor('just a string', copy)).toBe('just a string')
  })
})
