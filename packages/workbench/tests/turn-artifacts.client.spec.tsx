// @vitest-environment jsdom
/**
 * The turn-footer artifacts: chips from produced + prose-mentioned files that
 * exist, each expanding to an inline preview. This is the surface that catches
 * a bash-written file the structured signal misses.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnArtifacts, type TurnArtifactsProps } from '../src/client/TurnArtifacts.tsx'
import { resetArtifactCaches } from '../src/client/artifact-resolve.ts'

/** Files the fake host says exist (as files). Everything else 404s. */
let existing: Set<string>

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    const url = new URL(input, 'http://host')
    const json = (body: unknown, ok = true, status = 200): Response =>
      ({ ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) }) as Response
    if (url.pathname.endsWith('/roots')) return Promise.resolve(json({ roots: [{ id: 'workspace', path: '/ws', label: 'ws' }] }))
    if (url.pathname.endsWith('/stat')) {
      const path = url.searchParams.get('path') ?? ''
      return existing.has(path)
        ? Promise.resolve(json({ type: 'file', size: 10, version: 'v1' }))
        : Promise.resolve(json({ code: 'not_found', error: 'no' }, false, 404))
    }
    if (url.pathname.endsWith('/read')) return Promise.resolve(json({ path: 'x', size: 5, content: 'hello', version: 'v1' }))
    if (url.pathname.endsWith('/health')) return Promise.resolve(json({ ok: true, writeEnabled: false }))
    return Promise.resolve(json({}))
  }))
}

/** A session snapshot whose closing assistant message names two files. */
function useSessionStub(closingText: string): TurnArtifactsProps['useSession'] {
  const snapshot = { nodes: [{ kind: 'assistant', seq: 5, blocks: [{ kind: 'text', text: closingText }] }] }
  return ((selector: (s: unknown) => unknown) => selector(snapshot)) as TurnArtifactsProps['useSession']
}
const useSessionsStub = ((selector: (s: unknown) => unknown) =>
  selector({ byId: { s1: { cwd: '/ws' } } })) as TurnArtifactsProps['useSessions']

function show(overrides: Partial<TurnArtifactsProps> = {}) {
  const props: TurnArtifactsProps = {
    matched: [],
    seq: 5,
    sessionId: 's1' as TurnArtifactsProps['sessionId'],
    useSession: useSessionStub('nothing here'),
    useSessions: useSessionsStub,
    t: ((key: string) => key) as TurnArtifactsProps['t'],
    ...overrides,
  }
  return render(<TurnArtifacts {...props} />)
}

beforeEach(() => { existing = new Set(); resetArtifactCaches(); stubFetch() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('TurnArtifacts', () => {
  it('renders nothing when the turn touched no files', async () => {
    const { container } = show()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(container.querySelector('button')).toBeNull()
  })

  it('chips a produced file and a prose-mentioned file that exist', async () => {
    existing = new Set(['made.txt', 'report.html'])
    show({ matched: ['made.txt'], useSession: useSessionStub('I also wrote `report.html` for you.') })
    await waitFor(() => { expect(screen.getByText('made.txt')).toBeDefined() })
    expect(screen.getByText('report.html')).toBeDefined()
  })

  it('drops a mentioned path that does not exist on disk', async () => {
    existing = new Set(['real.md']) // imaginary.md is NOT in the set
    show({ useSession: useSessionStub('see `real.md` and `imaginary.md`') })
    await waitFor(() => { expect(screen.getByText('real.md')).toBeDefined() })
    expect(screen.queryByText('imaginary.md')).toBeNull()
  })

  it('expands an inline preview when a chip is clicked', async () => {
    existing = new Set(['report.html'])
    show({ useSession: useSessionStub('the report is `report.html`') })
    const chip = await screen.findByText('report.html')
    fireEvent.click(chip)
    // FilePreview fetches /read then renders; the html kind puts it in an iframe.
    await waitFor(() => { expect(document.querySelector('iframe')).not.toBeNull() })
    const iframe = document.querySelector('iframe') as HTMLIFrameElement
    expect(iframe.getAttribute('title')).toBe('report.html')
    // Inert by default — the whole point of the safe renderer.
    expect(iframe.getAttribute('sandbox')).toBe('')
  })
})
