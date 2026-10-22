import { describe, expect, test } from 'bun:test'
import { LIMITS, type Passage, type Showing } from 'kehikot-module-protocol'

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

const chapter: Passage = { path: '/Users/x/thesis/chapters/3_methods.tex', page: null, from: null, to: null, quoted: '', section: null }
const paragraph: Passage = { ...chapter, page: 3, from: 4120, to: 4180, quoted: 'the wire is narrow on purpose' }

const at = (i: string, y: number, selected = false, collapsed = false) => ({ i, x: 0, y, selected, collapsed })

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
      goto: () => ({ outcome: 'declined', epic: null, why: '' }),
      select: () => {},
      point: () => {},
      locate: () => ({ outcome: 'declined' as const, why: '' }),
      show: (from, showing) => shown.push({ from, showing }),
      emit: () => ({ ok: true, delivered: 0 }),
      project: () => null,
      filter: () => ({ ok: true as const, filters: {} }),
      pickProject: () => Promise.resolve({ outcome: 'declined' as const, project: null, why: '' }),
      fold: () => ({ outcome: 'declined' as const, folded: [], unfolded: [], why: '' }),
    }
    return { controls, shown }
  }

  test('the statement reaches the canvas attributed to the module, and the answer repeats it', async () => {
    const { controls, shown } = canvasThatRemembers()
    const ask = makeAsk('kehikot.paper', controls)

    const answer = await ask('showing.set', { refs: ['gh#105'], documents: [chapter] })

    expect(answer.ok).toBe(true)
    expect(shown).toEqual([{ from: 'kehikot.paper', showing: { refs: ['gh#105'], documents: [chapter] } }])
  })

  test('the attribution is the registration\'s and nothing the frame said reaches it', async () => {
    /* A module that could name itself could put words in another container's
       row. `from` is bound by `makeAsk` and there is no field for it in the
       params — one that is sent is dropped by the schema. */
    const { controls, shown } = canvasThatRemembers()
    const ask = makeAsk('kehikot.paper', controls)
    await ask('showing.set', { refs: [], documents: [], from: 'kehikot.journeys' })
    expect(shown[0]?.from).toBe('kehikot.paper')
  })

  test('showing nothing is a real call, and half a statement is refused', async () => {
    const { controls, shown } = canvasThatRemembers()
    const ask = makeAsk('kehikot.paper', controls)
    expect((await ask('showing.set', { refs: [], documents: [] })).ok).toBe(true)
    expect(shown).toHaveLength(1)
    const half = await ask('showing.set', { refs: ['gh#1'] })
    expect(half.ok).toBe(false)
    if (!half.ok) expect(half.error).toContain('documents')
    expect(shown).toHaveLength(1)
  })

  test('a document inside is held to the passage rules', async () => {
    const { controls } = canvasThatRemembers()
    const ask = makeAsk('kehikot.paper', controls)
    const half = await ask('showing.set', { refs: [], documents: [{ ...chapter, from: 10 }] })
    expect(half.ok).toBe(false)
  })
})

describe('composing the list', () => {
  test('every row says whether its container is folded to its header', () => {
    const rows = containersOf({
      placements: [at('kehikot.paper', 0), at('kehikot.notes', 5, false, true)],
      said: {},
      pointed: {},
      selection: [],
      selectedBy: null,
    })
    expect(rows.map((r) => [r.module, r.folded])).toEqual([['kehikot.paper', false], ['kehikot.notes', true]])
    /* And it reaches every module, through the protocol's own schema. */
    const told = toWireContext({ epic: null, project: null }, 'dark', [], { id: 1, name: 'writing' }, null, rows)
    expect(told.containers.map((c) => c.folded)).toEqual([false, true])
  })

  test('every container is a row, in reading order, whether or not it said anything', () => {
    const rows = containersOf({
      placements: [at('kehikot.notes', 5), at('kehikot.paper', 0, true), at('kehikot.journeys', 0)],
      said: {},
      pointed: {},
      selection: [],
      selectedBy: null,
    })
    expect(rows.map((r) => r.module)).toEqual(['kehikot.paper', 'kehikot.journeys', 'kehikot.notes'])
    expect(rows.map((r) => r.selected)).toEqual([true, false, false])
    expect(rows.every((r) => r.showing.refs.length === 0 && r.showing.documents.length === 0)).toBe(true)
  })

  test('what a module said is its row, and nobody else\'s', () => {
    const rows = containersOf({
      placements: [at('kehikot.paper', 0), at('kehikot.journeys', 1)],
      said: { 'kehikot.journeys': { refs: ['gh#10', 'gh#11'], documents: [] } },
      pointed: {},
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.refs).toEqual([])
    expect(rows[1]?.showing.refs).toEqual(['gh#10', 'gh#11'])
  })

  test('a module that only points is showing what it points at', () => {
    /* The projection the protocol's essay allows and this host says it does:
       a module that only ever calls `passage.set` has no other word, and its
       row is what it points at. */
    const rows = containersOf({
      placements: [at('kehikot.paper', 0), at('kehikot.notes', 1)],
      said: {},
      pointed: { 'kehikot.paper': paragraph },
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.documents).toEqual([paragraph])
    expect(rows[1]?.showing.documents).toEqual([])
  })

  test('a module that says what it shows has the whole of its row, and its pointing is not put in front', () => {
    /*
     * Measured: a paper listing its files with `showing.set`, its editor in
     * the methods chapter, and its last pointing an hour old on page 1 of
     * `main.tex` — it had been walked since by a neighbour's press and
     * rightly said nothing. The pointing went FIRST, and every consumer that
     * keeps one place per path took the stale page for `main.tex`.
     */
    const main: Passage = { ...chapter, path: '/Users/x/thesis/main.tex' }
    const stale: Passage = { ...main, page: 1 }
    const rows = containersOf({
      placements: [at('kehikot.paper', 0, true), at('kehikot.notes', 1)],
      said: { 'kehikot.paper': { refs: [], documents: [main, chapter] } },
      pointed: { 'kehikot.paper': stale },
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.documents).toEqual([main, chapter])
    /* What a consumer does with it: the first place per path. */
    const perPath = new Map<string, Passage>()
    for (const one of rows[0]?.showing.documents ?? []) if (!perPath.has(one.path)) perPath.set(one.path, one)
    expect(perPath.get(main.path)?.page).toBeNull()
  })

  test('a pointing somewhere the module does not list is not added either', () => {
    /* The same staleness with the parts narrowed: the paper says it shows the
       methods chapter and only that; an older pointing into `main.tex` must
       not make its row claim a file it has said it is not showing. */
    const elsewhere: Passage = { ...chapter, path: '/Users/x/thesis/main.tex', page: 1 }
    const rows = containersOf({
      placements: [at('kehikot.paper', 0)],
      said: { 'kehikot.paper': { refs: [], documents: [chapter] } },
      pointed: { 'kehikot.paper': elsewhere },
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.documents).toEqual([chapter])
  })

  test('sixteen documents said and a pointing: all sixteen are in the row, in order', () => {
    /* The bound is the protocol's and `showing.set` is refused past it, so a
       module can say exactly sixteen. The pointing used to be put in front
       before the cut, and the sixteenth file was dropped for a second mention
       of a file already listed. */
    const files = Array.from({ length: LIMITS.SHOWING_DOCUMENTS }, (_, n): Passage => ({ ...chapter, path: `/Users/x/thesis/chapters/${n}.tex` }))
    const rows = containersOf({
      placements: [at('kehikot.paper', 0)],
      said: { 'kehikot.paper': { refs: [], documents: files } },
      pointed: { 'kehikot.paper': { ...files[4]!, from: 10, to: 20, quoted: 'ten bytes' } },
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.documents).toEqual(files)
  })

  test('showing nothing, said, is an empty row even while the module points', () => {
    /* `{ refs: [], documents: [] }` is the protocol's "real call for showing
       nothing". A host that folded the pointing in would make it impossible
       to mean. Where the finger is stays in `context.passage`. */
    const rows = containersOf({
      placements: [at('kehikot.paper', 0)],
      said: { 'kehikot.paper': { refs: [], documents: [] } },
      pointed: { 'kehikot.paper': paragraph },
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.documents).toEqual([])
  })

  test('a container keeps showing what it pointed at after another container points', () => {
    /*
     * The bug, in one table. The paper pointed at page 3; the notes pane then
     * pointed at a note's passage. With one "who pointed last" per canvas the
     * paper's row went empty — the host telling every consumer that a
     * container with a chapter open on screen was showing nothing, and a
     * checklist narrowed to the picked-out paper emptied with it. Each
     * pointer's last pointing is its own claim and outlives the next pointer.
     */
    const notesAt: Passage = { ...chapter, from: 2781, to: 2929, quoted: 'Front matter, in the order' }
    const rows = containersOf({
      placements: [at('kehikot.paper', 0, true), at('kehikot.notes', 1)],
      said: {},
      pointed: { 'kehikot.paper': paragraph, 'kehikot.notes': notesAt },
      selection: [],
      selectedBy: null,
    })
    expect(rows[0]?.showing.documents).toEqual([paragraph])
    expect(rows[1]?.showing.documents).toEqual([notesAt])
  })

  test('a pointing with no range or page — an adrift note\'s document — is a document shown, not nothing', () => {
    /* The notes pane no longer points at an adrift note at all; but a bare
       document is a legitimate rung-1 passage from any module, and a row
       holding one is a row showing that document. */
    const rows = containersOf({
      placements: [at('kehikot.paper', 0, true), at('kehikot.notes', 1)],
      said: {},
      pointed: { 'kehikot.paper': paragraph, 'kehikot.notes': chapter },
      selection: [],
      selectedBy: null,
    })
    expect(rows[1]?.showing.documents).toEqual([chapter])
    expect(rows[0]?.showing.documents).toEqual([paragraph])
  })

  test('the selection is folded into its setter\'s row, and into nobody\'s after a reload', () => {
    const picked = containersOf({
      placements: [at('kehikot.references', 0), at('kehikot.checklist', 1)],
      said: {},
      pointed: {},
      selection: ['gh#7'],
      selectedBy: 'kehikot.references',
    })
    expect(picked[0]?.showing.refs).toEqual(['gh#7'])
    expect(picked[1]?.showing.refs).toEqual([])

    /* Nobody the host heard set it — it came back out of the database. It is
       still `context.selection`; it is in no row, because inventing who said
       it would be the host stating something it did not hear. */
    const reloaded = containersOf({
      placements: [at('kehikot.references', 0)],
      said: {},
      pointed: {},
      selection: ['gh#7'],
      selectedBy: null,
    })
    expect(reloaded[0]?.showing.refs).toEqual([])
  })

  test('a setter no longer on the kehikko contributes nothing, and the same place is listed once', () => {
    const rows = containersOf({
      placements: [at('kehikot.paper', 0)],
      said: { 'kehikot.paper': { refs: ['gh#1', 'gh#1'], documents: [paragraph] } },
      pointed: { 'kehikot.gone': paragraph },
      selection: ['gh#1'],
      selectedBy: 'kehikot.paper',
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.showing.refs).toEqual(['gh#1'])
    expect(rows[0]?.showing.documents).toEqual([paragraph])
  })

  test('the key is by value, so two equal lists are one dependency', () => {
    const a = containersOf({ placements: [at('kehikot.paper', 0, true)], said: {}, pointed: {}, selection: [], selectedBy: null })
    const b = containersOf({ placements: [at('kehikot.paper', 0, true)], said: {}, pointed: {}, selection: [], selectedBy: null })
    expect(a).not.toBe(b)
    expect(containersKey(a)).toBe(containersKey(b))
  })
})

describe('the list goes out in the context', () => {
  const subject = { epic: 'thesis', project: { id: 1, name: 'Thesis', path: '/Users/x/thesis', epics: true, git: false, shared: false } }

  test('carried whole, and empty when the canvas has no containers', () => {
    const rows = containersOf({
      placements: [at('kehikot.paper', 0, true)],
      said: {},
      pointed: { 'kehikot.paper': paragraph },
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
      placements: [at('kehikot.references', 0), at('kehikot.paper', 1)],
      said: { 'kehikot.paper': { refs: [], documents: [chapter] } },
      pointed: {},
      selection: ['gh#7'],
      selectedBy: 'kehikot.references',
    })
    const told = toWireContext({ ...subject, epic: 'Not An Epic!' }, 'light', ['gh#7'], null, null, rows)
    expect(told.epic).toBeNull()
    expect(told.selection).toEqual([])
    expect(told.containers.map((r) => r.showing.refs)).toEqual([[], []])
    expect(told.containers[1]?.showing.documents).toEqual([chapter])
  })
})
