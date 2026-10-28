import { afterEach, describe, expect, test } from 'bun:test'
import { MESSAGE, type EpicPart, type Passage } from 'kehikot-module-protocol'

import { makeAsk, type CanvasControls } from '../src/host/ask.ts'
import { handed } from '../src/host/address.ts'
import { receiverContext, type ContextFacts } from '../src/host/connectionContext.ts'
import { AUTOMATIC, HOST_NODE, delivered, doorsHanded, readersFor, stepsWithheld, switched, tidy } from '../src/host/connections.ts'
import { EventBus } from '../src/host/events.ts'
import { NOTHING_SAID, passageOn, pointed } from '../src/host/said.ts'
import { modulesOn, type ModuleAbout } from '../server/placeRoutes.ts'

/*
 * Each switch kind, ENFORCED: what the host delivers changes, and a module that is switched off from
 * a provider is where it would be if that provider were not on the kehikko.
 */

const PAPER = 'kehikot.paper'
const LEARNING = 'kehikot.learning'
const NOTES = 'kehikot.notes'
const JOURNEYS = 'kehikot.journeys'
const DIFF = 'kehikot.diff'
const REVIEW = 'kehikot.review'
const BROWSER = 'kehikot.browser'

const at = (path: string): Passage => ({ path, page: null, from: null, to: null, quoted: '', section: null })
const place = (i: string, x: number) => ({ i, x, y: 0, w: 3, h: 10, selected: false, collapsed: false })

/* Learning pointed first, Paper last: Paper's is the kehikko's passage. */
const said = pointed(pointed(NOTHING_SAID, LEARNING, at('/p/learning.md')), PAPER, at('/p/paper.tex'))
const parts: EpicPart[] = [
  { id: 'a', heading: 'A', refs: [], picked: true },
  { id: 'b', heading: 'B', refs: [], picked: false },
] as EpicPart[]

function facts(more: Partial<ContextFacts> = {}): ContextFacts {
  const placed = [PAPER, LEARNING, NOTES, JOURNEYS, DIFF, REVIEW, BROWSER]
  return {
    subject: { epic: 'e', project: { id: 1, name: 'p', path: '/p', uid: null } as never },
    theme: 'light',
    selection: ['gh#1'],
    selectedBy: JOURNEYS,
    kehikko: { id: 1, name: 'one', key: 'one' },
    said,
    placed: [...placed, HOST_NODE],
    hostPoints: HOST_NODE,
    placements: placed.map(place),
    dispositions: [],
    tracker: { at: null, refreshing: false },
    content: [],
    parts,
    location: { change: 'gh#1', path: 'src/a.ts', line: 3, side: 'new', intent: 'show', by: DIFF, at: '2026-10-28T10:00:00.000Z' },
    address: { url: 'https://example.com/', by: REVIEW, at: '2026-10-28T10:00:00.000Z' } as never,
    ...more,
  }
}

describe('the context a module is told', () => {
  test('nothing switched off: no context of its own, so it is sent the shared one', () => {
    expect(receiverContext(facts(), NOTES, AUTOMATIC)).toBeNull()
  })

  test('a passage: Notes off from Paper follows the latest pointing of the others; everybody else still follows Paper', () => {
    const off = switched(AUTOMATIC, { kind: 'passage', from: PAPER, to: NOTES, about: '' }, false)
    const told = receiverContext(facts(), NOTES, off)!
    expect(told.passage?.path).toBe('/p/learning.md')
    /* Exactly where it would be if Paper were not on the kehikko. */
    expect(told.passage).toEqual(passageOn(said, [LEARNING, NOTES, JOURNEYS, DIFF, REVIEW, BROWSER, HOST_NODE]))
    /* Nor is Paper's pointing in Paper's row of the containers. */
    expect(told.containers.find((c) => c.module === PAPER)!.showing.documents).toEqual([])
    expect(told.selection).toEqual(['gh#1'])
    /* And everything else it is told is the shared context's: the code location, the address. */
    expect(told.location?.by).toBe(DIFF)
    expect(told.address?.by).toBe(REVIEW)
    expect(receiverContext(facts(), LEARNING, off)).toBeNull()
  })

  test('a selection: held back with its code location; Journeys’ row no longer carries the refs', () => {
    const off = switched(AUTOMATIC, { kind: 'selection', from: JOURNEYS, to: REVIEW, about: '' }, false)
    const told = receiverContext(facts(), REVIEW, off)!
    expect(told.selection).toEqual([])
    expect(told.location).toBeNull()
    expect(told.containers.find((c) => c.module === JOURNEYS)!.showing.refs).toEqual([])
    /* A selection nobody is heard to have made (a reload) is not anybody's to withhold. */
    expect(receiverContext(facts({ selectedBy: null }), REVIEW, off)).toBeNull()
  })

  test('a code location: Review off from Diff is told none; the selection stays', () => {
    const off = switched(AUTOMATIC, { kind: 'location', from: DIFF, to: REVIEW, about: '' }, false)
    const told = receiverContext(facts(), REVIEW, off)!
    expect(told.location).toBeNull()
    expect(told.selection).toEqual(['gh#1'])
  })

  test('an address: the Browser off from Review is not handed Review’s page', () => {
    const off = switched(AUTOMATIC, { kind: 'address', from: REVIEW, to: BROWSER, about: '' }, false)
    expect(receiverContext(facts(), BROWSER, off)!.address).toBeNull()
    /* One from somebody it still takes is handed over. */
    expect(receiverContext(facts({ address: { url: 'https://example.com/', by: JOURNEYS, at: '2026-10-28T10:00:00.000Z' } as never }), BROWSER, off)).toBeNull()
  })

  test('the picked parts: Notes off from the bar is told the parts with none picked — the whole epic', () => {
    const off = switched(AUTOMATIC, { kind: 'parts', from: HOST_NODE, to: NOTES, about: '' }, false)
    const told = receiverContext(facts(), NOTES, off)!
    expect(told.parts.map((p) => [p.id, p.picked])).toEqual([['a', false], ['b', false]])
    expect(told.passage?.path).toBe('/p/paper.tex')
  })
})

describe('an extension', () => {
  test('is not relayed to a receiver switched off from its sender, and still is to the others', () => {
    const bus = new EventBus()
    const heard: string[] = []
    bus.join('kehikot.notifications', { consumes: ['kehikot.notifications@1'], send: () => void heard.push('notifications') })
    bus.join('kehikot.feed', { consumes: ['kehikot.notifications@1'], send: () => void heard.push('feed') })
    const off = switched(AUTOMATIC, { kind: 'extension', from: 'kehikot.claude', to: 'kehikot.notifications', about: 'kehikot.notifications@1' }, false)
    bus.holds = (from, to, extension) => !delivered(off, 'extension', from, to, extension)
    const line = { epic: 'e', message: 'done' }
    expect(bus.emit('kehikot.claude', 'kehikot.notifications@1', line, null)).toEqual({ ok: true, delivered: 1 })
    expect(heard).toEqual(['feed'])
    /* Another sender's line still reaches it. */
    expect(bus.emit('kehikot.checklist', 'kehikot.notifications@1', line, null)).toEqual({ ok: true, delivered: 2 })
    expect(heard).toEqual(['feed', 'notifications', 'feed'])
    void MESSAGE
  })
})

describe('an address handed to the kehikko', () => {
  test('with the only reader switched off from the asker, the person is offered it instead', () => {
    const off = switched(AUTOMATIC, { kind: 'address', from: REVIEW, to: BROWSER, about: '' }, false)
    const out = handed({}, {
      kehikko: 1,
      url: 'https://example.com/',
      asker: { by: REVIEW },
      at: '2026-10-28T10:00:00.000Z',
      readers: readersFor(off, REVIEW, [BROWSER]),
    })
    expect(out.answer.outcome).toBe('offered')
    expect(out.offer).not.toBeNull()
    const kept = handed({}, { kehikko: 1, url: 'https://example.com/', asker: { by: JOURNEYS }, at: '2026-10-28T10:00:00.000Z', readers: readersFor(off, JOURNEYS, [BROWSER]) })
    expect(kept.answer.outcome).toBe('shown')
  })
})

describe('a skill', () => {
  const flows: ModuleAbout = { id: 'kehikot.flows', name: 'Flows', skills: [{ name: 'flow-design', needs: [{ provides: 'documents' }] }] }
  const paper: ModuleAbout = { id: PAPER, name: 'Paper', skills: [], manifest: { declares: { provides: ['documents'] }, build: { protocol: '2.21.0' } } }
  const placements = [{ i: 'kehikot.flows', x: 0, y: 0, w: 1, h: 1 }, { i: PAPER, x: 1, y: 0, w: 1, h: 1 }]
  const offered = (connections: typeof AUTOMATIC) =>
    modulesOn({ placements, connections } as never, [flows, paper], []).find((one) => one.module === 'kehikot.flows')!.skills

  test('whose need is met only by a module switched off for it is not offered', () => {
    expect(offered(AUTOMATIC)).toEqual(['flow-design'])
    expect(offered(switched(AUTOMATIC, { kind: 'skill', from: PAPER, to: 'kehikot.flows', about: 'flow-design' }, false))).toEqual([])
  })
})

describe('an agent session', () => {
  test('is not handed the door of a module switched off for it; the host’s door always', () => {
    const off = tidy({ off: [{ kind: 'agent', from: NOTES, to: 'kehikot.claude' }], only: [] })
    const doors = [{ module: HOST_NODE }, { module: NOTES }, { module: PAPER }]
    expect(doorsHanded(off, 'kehikot.claude', doors).map((d) => d.module)).toEqual([HOST_NODE, PAPER])
  })
})

describe('the steps', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('of a provider switched off for a module are not in what its page is answered', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, data: { steps: [{ id: 's1', module: JOURNEYS }, { id: 's2', module: 'kehikot.planner' }], providers: [{ module: JOURNEYS }, { module: 'kehikot.planner' }] } }))) as unknown as typeof fetch
    const off = switched(AUTOMATIC, { kind: 'steps', from: JOURNEYS, to: 'kehikot.references', about: '' }, false)
    const canvas = {
      project: () => 1,
      withhold: (module: string, method: string, data: unknown) =>
        method === 'steps.list' ? stepsWithheld(data, (provider) => delivered(off, 'steps', provider, module)) : data,
    } as unknown as CanvasControls
    const forReferences = await makeAsk('kehikot.references', canvas)('steps.list', { epic: 'e' })
    expect(forReferences).toEqual({ ok: true, data: { steps: [{ id: 's2', module: 'kehikot.planner' }], providers: [{ module: 'kehikot.planner' }] } })
    const forFlows = await makeAsk('kehikot.flows', canvas)('steps.list', { epic: 'e' })
    expect((forFlows as { data: { steps: unknown[] } }).data.steps).toHaveLength(2)
  })
})
