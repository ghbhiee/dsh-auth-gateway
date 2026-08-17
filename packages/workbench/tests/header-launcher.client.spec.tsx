// @vitest-environment jsdom
/** The conversation-header launcher: it toggles the surface through the bridge. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchHeaderLauncher } from '../src/client/WorkbenchHeaderLauncher.tsx'
import { WORKBENCH_TOGGLE } from '../src/client/workbench-events.ts'

const Launcher = WorkbenchHeaderLauncher as unknown as (props: { t: (key: string) => string }) => React.ReactElement

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('WorkbenchHeaderLauncher', () => {
  it('is a labelled button', () => {
    render(<Launcher t={key => key} />)
    expect(screen.getByRole('button', { name: 'open' })).toBeDefined()
  })

  it('asks the surface to toggle on click, without binding the store', () => {
    // Session-scoped, so it cannot mount the root store; it fires the bridge
    // event the always-mounted overlay listens on.
    const heard = vi.fn()
    window.addEventListener(WORKBENCH_TOGGLE, heard)
    render(<Launcher t={key => key} />)
    fireEvent.click(screen.getByRole('button', { name: 'open' }))
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener(WORKBENCH_TOGGLE, heard)
  })
})
