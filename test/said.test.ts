import { describe, expect, test } from 'bun:test'
import type { ModuleContext, Passage } from 'kehikot-module-protocol'

import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import { toWireContext } from '@/host/context.ts'
import { NOTHING_SAID, forgotten, passageOn, pointed, pointedBy, shown, type Said } from '@/host/said.ts'
import { containersOf } from '@/host/showing.ts'

/**
 * What modules said, and which kehikko is told it.
 *
 * The fault these exist for, as it was measured in WebKit on a project with
 * two kehikot: the paper and the questions were on both, the frames stayed
 * loaded across the switch (as they must — nothing typed is lost), and the
 * second kehikko was told `passage: null` and every row empty. What the
 * modules had said was filed under the kehikko that was open when they said
 * it, and both of them say a thing once per change.
 */

const PAPER = 'kehikot.paper'
const NOTES = 'kehikot.notes'
const LEARNING = 'kehikot.learning'
const SOURCE = 'kehikot.source'

const file = (name: string): Passage => ({ path: `/Users/x/thesis/${name}`, page: null, from: null, to: null, quoted: '', section: null })
const methods = file('3_methods.tex')
const results = file('4_results.tex')
const paragraph: Passage = { ...methods, from: 4120, to: 4180, quoted: 'the wire is narrow on purpose' }
const noted: Passage = { ...results, from: 10, to: 60, quoted: 'a note was written here' }

describe('what each module said', () => {
  test('a statement repeated is the same object, so nothing is broadcast', () => {
    const once = shown(NOTHING_SAID, PAPER, { refs: [], documents: [methods] })
    expect(shown(once, PAPER, { refs: [], documents: [{ ...methods }] })).toBe(once)
    expect(shown(once, PAPER, { refs: [], documents: [results] })).not.toBe(once)
  })

  test('a pointing repeated is the same object while nobody has pointed since', () => {
    const once = pointed(NOTHING_SAID, PAPER, paragraph)
    expect(pointed(once, PAPER, { ...paragraph })).toBe(once)
  })

  test('the same place said again AFTER a neighbour pointed is news: the finger came back', () => {
    let said = pointed(NOTHING_SAID, PAPER, paragraph)
    said = pointed(said, NOTES, noted)
    expect(passageOn(said, [PAPER, NOTES])).toEqual(noted)
    const again = pointed(said, PAPER, paragraph)
    expect(again).not.toBe(said)
    expect(passageOn(again, [PAPER, NOTES])).toEqual(paragraph)
  })

  test('pointing at nothing clears the passage when it is the last word, and only that module\'s row', () => {
    let said = pointed(NOTHING_SAID, PAPER, paragraph)
    said = pointed(said, NOTES, noted)
    said = pointed(said, NOTES, null)
    expect(passageOn(said, [PAPER, NOTES])).toBeNull()
    expect(pointedBy(said)).toEqual({ [PAPER]: paragraph })
  })

  test('a module that never pointed saying "nothing" is not news', () => {
    expect(pointed(NOTHING_SAID, PAPER, null)).toBe(NOTHING_SAID)
  })

  test('a frame that went away takes what it said with it, and nobody else\'s', () => {
    let said = shown(NOTHING_SAID, PAPER, { refs: [], documents: [methods] })
    said = pointed(said, PAPER, paragraph)
    said = pointed(said, NOTES, noted)
    const after = forgotten(said, PAPER)
    expect(after.showing).toEqual({})
    expect(pointedBy(after)).toEqual({ [NOTES]: noted })
    expect(passageOn(after, [PAPER, NOTES])).toEqual(noted)
    expect(forgotten(after, PAPER)).toBe(after)
    /* A reloaded paper is greeted with a context that does not hand it its
       predecessor's passage as somebody else's. */
    expect(passageOn(forgotten(pointed(NOTHING_SAID, PAPER, paragraph), PAPER), [PAPER])).toBeNull()
  })

  test('the last pointer going away leaves NOTHING pointed at, not the pointing before it', () => {
    /* Measured in WebKit with the fallback this refuses: the paper's page
       reloaded, and the fresh page was told somebody was pointing at a
       question's source pressed ten minutes earlier — and walked there. */
    let said = pointed(NOTHING_SAID, LEARNING, noted)
    said = pointed(said, PAPER, paragraph)
    const after = forgotten(said, PAPER)
    expect(passageOn(after, [PAPER, LEARNING])).toBeNull()
    /* The neighbour's row still says what it pointed at; that claim is its own. */
    expect(pointedBy(after)).toEqual({ [LEARNING]: noted })
    /* And it is the finger again the moment it points again. */
    expect(passageOn(pointed(after, LEARNING, noted), [PAPER, LEARNING])).toEqual(noted)
  })
})

describe('which kehikko is told it', () => {
  test('nobody placed, nobody pointing', () => {
    const said = pointed(NOTHING_SAID, PAPER, paragraph)
    expect(passageOn(said, [])).toBeNull()
    expect(passageOn(NOTHING_SAID, [PAPER])).toBeNull()
  })

  test('the latest pointing among the modules placed THERE', () => {
    let said = pointed(NOTHING_SAID, PAPER, paragraph)
    said = pointed(said, NOTES, noted)
    expect(passageOn(said, [PAPER, NOTES, LEARNING])).toEqual(noted)
    /* A kehikko without the notes: their press is not pointing here. */
    expect(passageOn(said, [PAPER, LEARNING])).toEqual(paragraph)
    /* And one with neither. */
    expect(passageOn(said, [SOURCE])).toBeNull()
  })

  test('a module that is elsewhere does not take the passage away by speaking', () => {
    /* Measured with the other reading — "the last pointing anybody made, and
       nothing where its owner is not placed": a kehikko holding a file viewer
       and the questions lost its passage on every tick of a part, because the
       paper, running for the kehikko next door, re-says where it stands. */
    let said = pointed(NOTHING_SAID, LEARNING, noted)
    said = pointed(said, PAPER, paragraph)
    expect(passageOn(said, [SOURCE, LEARNING])).toEqual(noted)
    said = pointed(said, PAPER, null)
    expect(passageOn(said, [SOURCE, LEARNING])).toEqual(noted)
  })
})

/**
 * The switch, through everything between a module's call and the context a
 * frame is posted — `makeAsk`, the memory, `containersOf`, `toWireContext` —
 * with the three lines of `App.tsx` that join them written out as `host`.
 */
describe('switching between two kehikot in one project', () => {
  const subject = { epic: 'thesis', project: { id: 1, name: 'Thesis', path: '/Users/x/thesis', epics: true, git: false, shared: false } }
  const at = (i: string, y: number) => ({ i, x: 0, y, selected: false, collapsed: false })
  const writing = [at(PAPER, 0), at(NOTES, 1), at(LEARNING, 2)]
  const revising = [at(PAPER, 0), at(LEARNING, 1)]
  const reading = [at(SOURCE, 0), at(LEARNING, 1)]

  function host() {
    let said: Said = NOTHING_SAID
    const controls: CanvasControls = {
      showEpic: () => {},
      select: () => {},
      point: (from, passage) => { said = pointed(said, from, passage) },
      show: (from, showing) => { said = shown(said, from, showing) },
      emit: () => ({ ok: true, delivered: 0 }),
      project: () => 1,
      filter: () => ({ ok: true as const, filters: {} }),
      pickProject: () => Promise.resolve({ outcome: 'declined' as const, project: null, why: '' }),
      fold: () => ({ outcome: 'declined' as const, folded: [], unfolded: [], why: '' }),
    }
    const told = (placements: typeof writing): ModuleContext =>
      toWireContext(
        subject,
        'light',
        [],
        null,
        passageOn(said, placements.map((p) => p.i)),
        containersOf({ placements, said: said.showing, pointed: pointedBy(said), selection: [], selectedBy: null }),
      )
    const row = (context: ModuleContext, module: string) => context.containers.find((c) => c.module === module)?.showing.documents
    return { ask: (module: string) => makeAsk(module, controls), told, row, unload: (module: string) => { said = forgotten(said, module) } }
  }

  test('what was said on the first kehikko stands on the second, with nobody saying it again', async () => {
    const { ask, told, row } = host()
    /* On `writing`: the paper lists its files and points, the questions say theirs. */
    await ask(PAPER)('showing.set', { refs: [], documents: [methods, results] })
    await ask(PAPER)('passage.set', { passage: paragraph })
    await ask(LEARNING)('showing.set', { refs: [], documents: [methods] })

    /* The switch: nothing is asked, nothing is said. Only the placements differ. */
    const there = told(revising)
    expect(there.passage).toEqual(paragraph)
    expect(row(there, PAPER)).toEqual([methods, results])
    expect(row(there, LEARNING)).toEqual([methods])
    expect(there.containers.map((c) => c.module)).toEqual([PAPER, LEARNING])
  })

  test('and back again, including what was said while away', async () => {
    const { ask, told, row } = host()
    await ask(PAPER)('showing.set', { refs: [], documents: [methods, results] })
    await ask(PAPER)('passage.set', { passage: paragraph })
    const before = told(writing)

    /* Away, on `revising`, a part is ticked: the paper narrows and re-points. */
    await ask(PAPER)('showing.set', { refs: [], documents: [results] })
    await ask(PAPER)('passage.set', { passage: results })
    expect(row(told(revising), PAPER)).toEqual([results])

    const back = told(writing)
    expect(row(back, PAPER)).toEqual([results])
    expect(back.passage).toEqual(results)
    expect(row(before, PAPER)).toEqual([methods, results])
  })

  test('a module on one kehikko and not the other speaks only where it is', async () => {
    const { ask, told, row } = host()
    await ask(PAPER)('showing.set', { refs: [], documents: [methods] })
    await ask(PAPER)('passage.set', { passage: paragraph })
    /* The notes are on `writing` only, and a note is pressed there last. */
    await ask(NOTES)('passage.set', { passage: noted })

    expect(told(writing).passage).toEqual(noted)
    expect(row(told(writing), NOTES)).toEqual([noted])

    /* `revising` has no notes: nobody there is pointing at the note, and the
       latest pointing by a module that IS there — the paper's own — is the
       passage. */
    const revised = told(revising)
    expect(revised.passage).toEqual(paragraph)
    expect(row(revised, PAPER)).toEqual([methods])
    expect(revised.containers.some((c) => c.module === NOTES)).toBe(false)

    /* `reading` has neither: no passage at all, and nothing shown by the paper
       leaks into a kehikko the paper is not on. */
    const read = told(reading)
    expect(read.passage).toBeNull()
    expect(read.containers.flatMap((c) => c.showing.documents)).toEqual([])

    /* Back where the notes are, their press is the passage again. */
    expect(told(writing).passage).toEqual(noted)
  })

  test('a module that speaks while its kehikko is not the open one is heard for its own', async () => {
    /* Its frame is loaded and running wherever it is placed. Filed under the
       OPEN kehikko, this used to set the passage of a kehikko the module is
       not even on. */
    const { ask, told } = host()
    await ask(NOTES)('passage.set', { passage: noted })
    expect(told(reading).passage).toBeNull()
    expect(told(writing).passage).toEqual(noted)
  })

  test('a module that was reloaded has said nothing yet, on either kehikko', async () => {
    const { ask, told, row, unload } = host()
    await ask(PAPER)('showing.set', { refs: [], documents: [methods] })
    await ask(PAPER)('passage.set', { passage: paragraph })
    unload(PAPER)
    for (const placements of [writing, revising]) {
      expect(told(placements).passage).toBeNull()
      expect(row(told(placements), PAPER)).toEqual([])
    }
  })
})
