import { describe, expect, test } from 'bun:test'
import type { Passage, Showing } from 'roadmap-module-protocol'

import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import { toWireContext } from '@/host/context.ts'
import { ANSWERED_BY_THE_VIEW, unanswered } from '@/host/division.ts'
import { containersKey, containersOf } from '@/host/showing.ts'

/**
 * `context.containers`: every container on the kehikko, whether it is picked
 * out, and what it shows — and `showing.set`, the method that fills the last
 * of those.
 *
 * The ask, in the user's words: "multiple things in kehikko that can have a
 * checklist ... we should be able to show both items checklists. And if user
 * selects x number of the modules then we should only show those modules
 * checklist". These tests are the host's half of that: the composition in
 * `host/showing.ts` is a table, and the routing is the same guard
 * `passage.test.ts` runs from the other end.
 */

const chapter: Passage = { path: '/Users/x/thesis/chapters/3_methods.tex', page: null, from: null, to: null, quoted: '' }
const paragraph: Passage = { ...chapter, page: 3, from: 4120, to: 4180, quoted: 'the wire is narrow on purpose' }

const at = (i: string, y: number, selected = false) => ({ i, x: 0, y, selected })

describe('the host answers the method the protocol names', () => {
  test('nothing the protocol names falls between the two halves', () => {
    expect(unanswered()).toEqual([])
  })

  test('showing.set is answered by the VIEW, for the reason passage.set is', () => {
    expect([...ANSWERED_BY_THE_VIEW]).toContain('showing.set')
  })
})

describe('what the canvas does when a container says what it shows', () => {
  function canvasThatRemembers() {
    const shown: { from: string; showing: Showing }[] = []
    const controls: CanvasControls = {
      showEpic: () => {},
      select: () => {},
      point: () => {},
      show: (from, showing) => shown.push({ from, showing }),
      emit: () => ({ ok: true, delivered: 0 }),
      project: () => null,
      filter: () => ({ ok: true as const, filters: {} }),
      pickProject: () => Promise.resolve({ outcome: 'declined' as const, project: null, why: '' }),
    }
    return { controls, shown }
  }

  test('the statement reaches the canvas attributed to the module, and the answer repeats it', async () => {
    const { controls, shown } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)

    const answer = await ask('showing.set', { refs: ['gh#105'], documents: [chapter] })

    expect(answer.ok).toBe(true)
    expect(shown).toEqual([{ from: 'roadmap.paper', showing: { refs: ['gh#105'], documents: [chapter] } }])
  })

  test('the attribution is the registration\'s and nothing the frame said reaches it', async () => {
    /* A module that could name itself could put words in another container's
       row. `from` is bound by `makeAsk` and there is no field for it in the
       params — one that is sent is dropped by the schema. */
    const { controls, shown } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)
    await ask('showing.set', { refs: [], documents: [], from: 'roadmap.journeys' })
    expect(shown[0]?.from).toBe('roadmap.paper')
  })

  test('showing nothing is a real call, and half a statement is refused', async () => {
    const { controls, shown } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)
    expect((await ask('showing.set', { refs: [], documents: [] })).ok).toBe(true)
    expect(shown).toHaveLength(1)
    const half = await ask('showing.set', { refs: ['gh#1'] })
    expect(half.ok).toBe(false)
    if (!half.ok) expect(half.error).toContain('documents')
    expect(shown).toHaveLength(1)
  })

  test('a document inside is held to the passage rules', async () => {
    const { controls } = canvasThatRemembers()
    const ask = makeAsk('roadmap.paper', controls)
    const half = await ask('showing.set', { refs: [], documents: [{ ...chapter, from: 10 }] })
    expect(half.ok).toBe(false)
  })
})

describe('composing the list', () => {
  test('every container is a row, in reading order, whether or not it said anything', () => {
    const rows = containersOf({
      placements: [at('roadmap.notes', 5), at('roadmap.paper', 0, true), at('roadmap.journeys', 0)],
      said: {},
      passage: null,
      pointedBy: null,
      selection: [],
      selectedBy: null,
    })
    expect(rows.map((r) => r.module)).toEqual(['roadmap.paper', 'roadmap.journeys', 'roadmap.notes'])
    expect(rows.map((r) => r.selected)).toEqual([true, false, false])
    expect(rows.every((r) => r.showing.refs.length === 0 && r.showing.documents.length === 0)).toBe(true)
  })

  test('what a module said is its row, and nobody else\'s', () => {
    const rows = containersOf({
      placements: [at('roadmap.paper', 0), at('roadmap.journeys', 1)],
      said: { 'roadmap.journeys': { refs: ['gh#10', 'gh#11'], documents: [] } },
      passage: null,
      pointedBy: null,
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.refs).toEqual([])
    expect(rows[1]?.showing.refs).toEqual(['gh#10', 'gh#11'])
  })

  test('the passage is folded into the row of the container that pointed, first', () => {
    /* The projection the protocol's essay allows and this host says it does:
       a module that only ever calls `passage.set` is showing what it points
       at. The reader's finger goes first, ahead of whatever the module said. */
    const rows = containersOf({
      placements: [at('roadmap.paper', 0), at('roadmap.notes', 1)],
      said: { 'roadmap.paper': { refs: [], documents: [chapter] } },
      passage: paragraph,
      pointedBy: 'roadmap.paper',
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.documents).toEqual([paragraph, chapter])
    expect(rows[1]?.showing.documents).toEqual([])
  })

  test('the selection is folded into its setter\'s row, and into nobody\'s after a reload', () => {
    const picked = containersOf({
      placements: [at('roadmap.references', 0), at('roadmap.checklist', 1)],
      said: {},
      passage: null,
      pointedBy: null,
      selection: ['gh#7'],
      selectedBy: 'roadmap.references',
    })
    expect(picked[0]?.showing.refs).toEqual(['gh#7'])
    expect(picked[1]?.showing.refs).toEqual([])

    /* Nobody the host heard set it — it came back out of the database. It is
       still `context.selection`; it is in no row, because inventing who said
       it would be the host stating something it did not hear. */
    const reloaded = containersOf({
      placements: [at('roadmap.references', 0)],
      said: {},
      passage: null,
      pointedBy: null,
      selection: ['gh#7'],
      selectedBy: null,
    })
    expect(reloaded[0]?.showing.refs).toEqual([])
  })

  test('a setter no longer on the kehikko contributes nothing, and the same place is listed once', () => {
    const rows = containersOf({
      placements: [at('roadmap.paper', 0)],
      said: { 'roadmap.paper': { refs: ['gh#1', 'gh#1'], documents: [paragraph] } },
      passage: paragraph,
      pointedBy: 'roadmap.gone',
      selection: ['gh#1'],
      selectedBy: 'roadmap.paper',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.showing.refs).toEqual(['gh#1'])
    expect(rows[0]?.showing.documents).toEqual([paragraph])
  })

  test('the key is by value, so two equal lists are one dependency', () => {
    const a = containersOf({ placements: [at('roadmap.paper', 0, true)], said: {}, passage: null, pointedBy: null, selection: [], selectedBy: null })
    const b = containersOf({ placements: [at('roadmap.paper', 0, true)], said: {}, passage: null, pointedBy: null, selection: [], selectedBy: null })
    expect(a).not.toBe(b)
    expect(containersKey(a)).toBe(containersKey(b))
  })
})

describe('the list goes out in the context', () => {
  const subject = { epic: 'thesis', project: { id: 1, name: 'Thesis', path: '/Users/x/thesis', epics: true, git: false, shared: false } }

  test('carried whole, and empty when the canvas has no containers', () => {
    const rows = containersOf({
      placements: [at('roadmap.paper', 0, true)],
      said: {},
      passage: paragraph,
      pointedBy: 'roadmap.paper',
      selection: [],
      selectedBy: null,
    })
    const told = toWireContext(subject, 'light', [], null, paragraph, rows)
    expect(told.containers).toEqual(rows)
    expect(toWireContext(subject, 'light').containers).toEqual([])
  })

  test('an epic slug that will not parse drops the selection from the rows too', () => {
    /* The selection goes because it was picked out of an epic this context no
       longer names. A row still saying a container picked those refs would be
       the row and the canvas disagreeing. The documents stay, for the reason
       the passage stays. */
    const rows = containersOf({
      placements: [at('roadmap.references', 0), at('roadmap.paper', 1)],
      said: { 'roadmap.paper': { refs: [], documents: [chapter] } },
      passage: null,
      pointedBy: null,
      selection: ['gh#7'],
      selectedBy: 'roadmap.references',
    })
    const told = toWireContext({ ...subject, epic: 'Not An Epic!' }, 'light', ['gh#7'], null, null, rows)
    expect(told.epic).toBeNull()
    expect(told.selection).toEqual([])
    expect(told.containers.map((r) => r.showing.refs)).toEqual([[], []])
    expect(told.containers[1]?.showing.documents).toEqual([chapter])
  })
})
