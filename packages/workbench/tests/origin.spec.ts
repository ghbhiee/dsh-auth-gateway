/** The same-origin gate, as pure header logic. */

import { describe, expect, it } from 'vitest'
import { isSameOrigin } from '../src/origin.ts'

const req = (headers: Record<string, string | undefined>) => ({ headers })

describe('isSameOrigin', () => {
  it('passes a request with no Origin (not a browser)', () => {
    expect(isSameOrigin(req({ host: '127.0.0.1:3080' }))).toBe(true)
  })

  it('passes when Origin host matches Host, port and all', () => {
    expect(isSameOrigin(req({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }))).toBe(true)
    expect(isSameOrigin(req({ origin: 'https://app.example.com', host: 'app.example.com' }))).toBe(true)
  })

  it('refuses a different host', () => {
    expect(isSameOrigin(req({ origin: 'http://evil.example.com', host: '127.0.0.1:3080' }))).toBe(false)
  })

  it('refuses a different port on the same host', () => {
    // A page on :9999 attacking the app on :3080 is the exact attack seen.
    expect(isSameOrigin(req({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3080' }))).toBe(false)
  })

  it('refuses a malformed Origin rather than trusting it', () => {
    expect(isSameOrigin(req({ origin: 'not a url', host: '127.0.0.1:3080' }))).toBe(false)
  })

  it('refuses when there is an Origin but no Host to compare against', () => {
    expect(isSameOrigin(req({ origin: 'http://127.0.0.1:3080' }))).toBe(false)
  })
})
