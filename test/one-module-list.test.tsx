import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { ModuleList, ModuleListAsked } from '../src/canvas/Modules.tsx'
import { UpdatesContext, type UpdatesEngine } from '../src/canvas/Updates.tsx'
import { TooltipProvider } from '../src/components/ui/tooltip.tsx'
import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * One list of modules, as an editor's extensions view: every module in "All", each with its update on
 * its own row, and the Updates filter with every update's whole row — from the one engine the Updates
 * menu reads too (`Updates.tsx`).
 */

const AT = 'http://127.0.0.1:7870'
const presence = (over: Partial<Presence> & { id: string }): Presence => ({ at: AT, condition: 'ready', reached: true, line: `${over.id} answers.`, ...over })
const registry = { presences: [presence({ id: 'kehikot.paper', name: 'Paper', tags: ['writing'] }), presence({ id: 'kehikot.diff', name: 'Diff', tags: ['code'] }), presence({ id: 'kehikot.notes', name: 'Notes', tags: ['writing'] })], sweep: { dir: '/x', rejected: [] } } as unknown as RegistryView

/** A stand-in engine: Paper has an update ready, Diff's update failed, Notes is up to date. */
function engine(over: Partial<Record<string, unknown>> = {}): UpdatesEngine {
  const paper = { id: 'kehikot.paper', name: 'Paper' }
  const diff = { id: 'kehikot.diff', name: 'Diff' }
  return {
    attention: [paper, diff],
    ready: [paper],
    level: [{ id: 'kehikot.notes', name: 'Notes', release: null, branch: 'main', commit: 'abc' }],
    outcomes: { 'kehikot.diff': { kind: 'failed', why: 'It did not start.' } },
    updating: null,
    mine: () => false,
    updateAll: async () => {},
    setAsked: () => {},
    asked: null,
    showLevel: false,
    setShowLevel: () => {},
    pins: {},
    told: {},
    steps: {},
    check: null,
    retryingIds: [],
    cancel: () => {},
    retry: async () => {},
    armed: null,
    restartAnyway: async () => {},
    restartApp: async () => {},
    showModuleNotes: () => {},
    app: null,
    endsAll: null,
    skipped: [],
    everything: 1,
    unfetchedOnes: [],
    checkAll: () => {},
    now: new Date(),
    phase: { kind: 'idle' },
    notice: null,
    lastFailed: null,
    moduleNotes: { dialog: null },
    ...over,
  } as unknown as UpdatesEngine
}

const draw = (with_: UpdatesEngine | null, filter?: 'all' | 'updates') =>
  renderToStaticMarkup(
    <TooltipProvider>
      <UpdatesContext.Provider value={with_}>
        <ModuleListAsked.Provider value={filter ? { filter } : {}}>
          <ModuleList registry={registry} onCanvas={new Set()} onPlace={() => {}} onUnplace={() => {}} />
        </ModuleListAsked.Provider>
      </UpdatesContext.Provider>
    </TooltipProvider>,
  )

describe('one list of modules', () => {
  test('All: the filter says how many have an update; each module’s update is on its own row', () => {
    const html = draw(engine())
    expect(html).toContain('data-module-filter="all"')
    expect(html).toContain('Updates (2)')
    /* Paper's update is only that: one press. Diff's failed one has more to read: See update. Notes has none. */
    expect(html.match(/data-inline-update="ready"/g)).toHaveLength(1)
    expect(html.match(/data-inline-update="see"/g)).toHaveLength(1)
  })

  test('the Updates filter draws the updates, with Check now and the ones up to date', () => {
    /* Nothing needs attention here: the row component itself is the Updates menu's, tested there. */
    const html = draw(engine({ attention: [], ready: [] }), 'updates')
    expect(html).toContain('data-testid="module-updates"')
    expect(html).toContain('Check now')
    expect(html).toContain('1 other up to date')
    /* The module rows of "All" are not drawn under it. */
    expect(html).not.toContain('data-inline-update')
  })

  test('while one is updating its row says so instead of a button', () => {
    const html = draw(engine({ updating: { kind: 'updating', ids: ['kehikot.paper'], running: { 'kehikot.paper': 'updating' }, finished: 0 }, mine: (id: string) => id === 'kehikot.paper' }))
    expect(html).toContain('data-inline-update="running"')
  })

  test('with no engine (a list drawn on its own) there is no filter and no update on any row', () => {
    const html = draw(null)
    expect(html).not.toContain('data-module-filter')
    expect(html).not.toContain('data-inline-update')
  })
})
