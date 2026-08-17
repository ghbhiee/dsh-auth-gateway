/** The dock-width bound shared by the drag handle and the store action. */

import { describe, expect, it } from 'vitest'
import { clampDockWidth, MAX_DOCK_WIDTH, MIN_DOCK_WIDTH } from '../src/client/dock-width.ts'

describe('clampDockWidth', () => {
  it('keeps a sensible width unchanged (but integral)', () => {
    expect(clampDockWidth(460)).toBe(460)
    expect(clampDockWidth(512.6)).toBe(513)
  })

  it('never returns less than the minimum', () => {
    expect(clampDockWidth(10)).toBe(MIN_DOCK_WIDTH)
    expect(clampDockWidth(-1000)).toBe(MIN_DOCK_WIDTH)
  })

  it('never returns more than the maximum', () => {
    expect(clampDockWidth(5000)).toBe(MAX_DOCK_WIDTH)
  })
})
