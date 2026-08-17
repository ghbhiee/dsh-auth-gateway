// @vitest-environment jsdom
/** The window-event bridge session-scoped seats use to drive the root surface. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  onWorkbenchRequests, requestOpenFile, requestToggle,
  WORKBENCH_OPEN_FILE, WORKBENCH_TOGGLE,
} from '../src/client/workbench-events.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('workbench event bridge', () => {
  it('delivers a toggle request to a subscriber', () => {
    const toggle = vi.fn()
    const off = onWorkbenchRequests({ toggle, openFile: vi.fn() })
    requestToggle()
    expect(toggle).toHaveBeenCalledTimes(1)
    off()
  })

  it('delivers an open-file request with its detail', () => {
    const openFile = vi.fn()
    const off = onWorkbenchRequests({ toggle: vi.fn(), openFile })
    requestOpenFile({ root: 'workspace', path: 'sub/report.html', name: 'report.html' })
    expect(openFile).toHaveBeenCalledWith({ root: 'workspace', path: 'sub/report.html', name: 'report.html' })
    off()
  })

  it('stops delivering after unsubscribe', () => {
    const toggle = vi.fn()
    const off = onWorkbenchRequests({ toggle, openFile: vi.fn() })
    off()
    requestToggle()
    expect(toggle).not.toHaveBeenCalled()
  })

  it('uses distinct, namespaced event names', () => {
    // Guards against a rename silently splitting sender and listener.
    expect(WORKBENCH_TOGGLE).toBe('dsh-workbench:toggle')
    expect(WORKBENCH_OPEN_FILE).toBe('dsh-workbench:open-file')
  })
})
