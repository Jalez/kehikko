import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import {
  JOURNEYS_FILE,
  JOURNEYS_MODULE,
  LIMITS,
  METHODS,
  PARTS_BEFORE_1_2,
  contextSchema,
  moduleFile,
  partListSchema,
  partsOf,
  partsSetResult,
  type EpicPart,
  type PartsSetResult,
} from 'kehikot-module-protocol'
import { holdingsSpoken, readHoldings, writeHoldings } from 'kehikot-module-protocol/serve'
import { z } from 'zod'

import { answer, type PartsDoor } from '../server/answers.ts'
import { createCanvas, open, setSubject } from '../server/canvases.ts'
import { call, mcp, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { Wakes } from '../server/wake.ts'
import { editParts, listEpics, readEpic, readParts, retitleEpic, withMember } from '../server/holdings.ts'
import { epicsDir } from '../server/hostData.ts'
import { ANSWERED_BY_THE_SERVER, unanswered } from '../src/host/division.ts'
import { readableBy, toWireContext } from '../src/host/context.ts'
import { edited, listedIn, partsHeld, partsOnWire, pickedIn, stepTo, type Part, type PartsEdit } from '../src/host/parts.ts'

/**
 * The parts of an epic are the epic's: a list in its own file, edited through
 * one writer, with what every module holds for each part unioned in.
 *
 * The fixture is the shape of the project this was built for — a thesis, a
 * chapter to a part, the list kept (until somebody edits it) as the `groups`
 * of its journey record — because the promise that matters most is about that
 * project: with nothing edited, every module is sent exactly what it was sent
 * before this host kept a list at all, and after the first edit, the same.
 */

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const CHAPTERS = [
  ['introduction', 'Introduction', 'chapters/1_introduction.tex'],
  ['literature-review', 'Literature Review', 'chapters/2_literature_review.tex'],
  ['methods', 'Methods', 'chapters/3_methods.tex'],
  ['results', 'Results', 'chapters/4_results.tex'],
  ['discussion', 'Discussion', 'chapters/5_discussion.tex'],
  ['conclusion', 'Conclusion', 'chapters/6_conclusion.tex'],
  ['appendices', 'Appendices', 'chapters/appendix_instruments.tex'],
] as const
const IDS = CHAPTERS.map(([id]) => id)

const record = {
  slug: 'thesis',
  title: 'Chat as an Exercise',
  steps: CHAPTERS.slice(0, 6).map(([id, heading], n) => ({ title: `A reader… ${heading}`, body: '', refs: n === 2 ? ['gh#12'] : [], notes: [], part: id })),
  groups: CHAPTERS.map(([id, heading, file]) => ({ heading, refs: [], id, files: [file] })),
}

/* The epic's own file as a person's repository has it: four-space-free,
   two-space JSON, with prose the writer must not touch. */
const OWN = `{
  "slug": "thesis",
  "title": "Chat as an Exercise",
  "lede": "Read chapter by chapter — with a \\"quote\\", a } and a ] in it.",
  "written": "2026-08-30",
  "steps": [
    { "title": "kept as it is", "refs": [] }
  ]
}
`

function thesis(own = OWN, withRecord = true): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-parts-of-the-epic-')))
  made.push(dir)
  mkdirSync(epicsDir(dir), { recursive: true })
  writeFileSync(join(epicsDir(dir), 'thesis.json'), own)
  if (withRecord) {
    const file = moduleFile(dir, JOURNEYS_MODULE, JOURNEYS_FILE)!
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, journeys: { thesis: record } }, null, 2))
  }
  return dir
}

const file = (dir: string) => readFileSync(join(epicsDir(dir), 'thesis.json'), 'utf8')
const partsIn = (dir: string): Part[] => listEpics(dir).find((epic) => epic.slug === 'thesis')?.parts ?? []
/** What a module on the canvas is sent for the parts, with `methods` picked. */
const sent = (dir: string, stored: string[] = ['methods']) => partsOnWire(partsIn(dir), stored)
/** A part as a module built before 1.2.0 reads it: `documents` is a key it has never heard of. */
const asBefore = (parts: readonly EpicPart[]) => parts.map(({ documents: _documents, ...rest }) => rest)
/** What `origin/main` sent: the record's groups through `partsOf`, and nothing else. */
const before = (stored: string[] = ['methods']) => partsOnWire(partsOf(record), stored)

describe('nothing edited: every module is sent what it was sent before', () => {
  test('the seven parts, with their ids, names, refs and files, exactly', () => {
    const dir = thesis()
    expect(asBefore(sent(dir))).toEqual(before())
    expect(sent(dir).map((part) => part.id)).toEqual(IDS)
    expect(sent(dir).find((part) => part.id === 'methods')).toEqual({
      id: 'methods',
      heading: 'Methods',
      refs: ['gh#12'],
      picked: true,
      files: ['chapters/3_methods.tex'],
      documents: ['.kehikot/paper/thesis/chapters/3_methods.tex'],
    })
    /* And nothing was written to find that out. */
    expect(file(dir)).toBe(OWN)
    expect(listedIn(JSON.parse(file(dir)))).toBeNull()
  })

  test('with nothing picked, and with every way of picking', () => {
    const dir = thesis()
    for (const stored of [[], ['methods'], ['results', 'introduction'], ['gone'], IDS]) {
      expect(asBefore(sent(dir, stored))).toEqual(before(stored))
    }
  })

  test('the steps and their count on the row are what they were', () => {
    const dir = thesis()
    expect(partsIn(dir).map((part) => part.steps)).toEqual([1, 1, 1, 1, 1, 1, 0])
    expect(partsIn(dir).map(({ documents: _d, ...rest }) => rest)).toEqual(partsOf(record))
  })

  test('an epic with no record and groups in its own file is read as it always was', () => {
    const own = JSON.stringify({ slug: 'thesis', title: 'T', groups: [{ heading: 'Only part', refs: ['gh#1'] }] })
    const dir = thesis(own, false)
    expect(partsIn(dir)).toEqual([{ id: 'only-part', heading: 'Only part', refs: ['gh#1'], steps: 0 }])
  })
})

describe('adopted once, on the first edit', () => {
  test('the list is written with every id and name exactly as it was read, plus the one change', () => {
    const dir = thesis()
    const done = editParts(dir, 'thesis', { add: { name: 'Acknowledgements' } })
    expect(done.written).toBe(true)
    expect(done.result.outcome).toBe('changed')
    expect(done.result.id).toBe('acknowledgements')
    expect(done.result.parts).toEqual([
      ...CHAPTERS.map(([id, name]) => ({ id, name })),
      { id: 'acknowledgements', name: 'Acknowledgements' },
    ])
    expect(listedIn(JSON.parse(file(dir)))).toEqual(done.result.parts)
    expect(partListSchema.safeParse(JSON.parse(file(dir)).parts).success).toBe(true)
  })

  test('and afterwards every module is still sent the same seven, the same way', () => {
    const dir = thesis()
    editParts(dir, 'thesis', { add: { name: 'Acknowledgements' } })
    editParts(dir, 'thesis', { remove: { id: 'acknowledgements' } })
    expect(listedIn(JSON.parse(file(dir)))!.map((part) => part.id)).toEqual(IDS)
    for (const stored of [[], ['methods'], ['results', 'introduction']]) {
      expect(asBefore(sent(dir, stored))).toEqual(before(stored))
    }
    expect(partsIn(dir).map((part) => part.steps)).toEqual([1, 1, 1, 1, 1, 1, 0])
  })

  test('from then on only the epic’s file is read for the list', () => {
    const dir = thesis()
    editParts(dir, 'thesis', { rename: { id: 'methods', name: 'How it was done' } })
    /* The record goes on saying "Methods", and gains a group; neither is the list. */
    const journeys = moduleFile(dir, JOURNEYS_MODULE, JOURNEYS_FILE)!
    const more = { ...record, groups: [...record.groups, { heading: 'Late', refs: [], id: 'late' }] }
    writeFileSync(journeys, JSON.stringify({ version: 1, journeys: { thesis: more } }))
    expect(partsIn(dir).map((part) => part.id)).toEqual(IDS)
    expect(partsIn(dir).find((part) => part.id === 'methods')!.heading).toBe('How it was done')
    /* What the record holds for a part of that id is still folded in. */
    expect(partsIn(dir).find((part) => part.id === 'methods')!.files).toEqual(['chapters/3_methods.tex'])
  })

  test('an empty list of its own is no parts, and does not fall back', () => {
    const dir = thesis()
    for (const id of IDS) editParts(dir, 'thesis', { remove: { id } })
    expect(JSON.parse(file(dir)).parts).toEqual([])
    expect(partsIn(dir)).toEqual([])
    expect(listEpics(dir)[0]!.parts).toBeUndefined()
  })

  test('an edit that changes nothing adopts nothing and writes nothing', () => {
    const dir = thesis()
    for (const edit of [
      { rename: { id: 'methods', name: 'Methods' } },
      { move: { id: 'introduction', after: null } },
      { move: { id: 'appendices' } },
      { remove: { id: 'no-such' } },
    ] as PartsEdit[]) {
      const done = editParts(dir, 'thesis', edit)
      expect(done.written).toBe(false)
      expect(done.result.parts.map((part) => part.id)).toEqual(IDS)
    }
    expect(file(dir)).toBe(OWN)
  })

  test('a rename keeps the id, so a stored pick and a step’s part go on naming the part', () => {
    const dir = thesis()
    const done = editParts(dir, 'thesis', { rename: { id: 'methods', name: 'How it was done' } })
    expect(done.result).toMatchObject({ outcome: 'changed', id: 'methods' })
    expect(pickedIn(partsIn(dir), ['methods'])).toEqual(['methods'])
    const methods = sent(dir).find((part) => part.id === 'methods')!
    expect(methods).toMatchObject({ heading: 'How it was done', picked: true, refs: ['gh#12'], files: ['chapters/3_methods.tex'] })
    expect(partsIn(dir).find((part) => part.id === 'methods')!.steps).toBe(1)
  })

  test('`epic.get` answers the epic’s own list when it keeps one, and no `parts` when it does not', () => {
    const dir = thesis()
    expect(readEpic(dir, 'thesis')!.parts).toBeUndefined()
    editParts(dir, 'thesis', { move: { id: 'appendices', after: null } })
    expect((readEpic(dir, 'thesis')!.parts as { id: string }[]).map((part) => part.id)).toEqual(['appendices', ...IDS.slice(0, 6)])
  })
})

describe('the writer changes one field, and leaves every other byte', () => {
  test('the list is added after the last member, one part to a line, and nothing else moves', () => {
    const dir = thesis()
    editParts(dir, 'thesis', { add: { name: 'Acknowledgements', after: 'introduction' } })
    const now = file(dir)
    const head = OWN.slice(0, OWN.lastIndexOf('\n}'))
    expect(now.startsWith(`${head},\n  "parts": [\n`)).toBe(true)
    expect(now.endsWith('\n  ]\n}\n')).toBe(true)
    expect(now).toContain('\n    { "id": "introduction", "name": "Introduction" },\n    { "id": "acknowledgements", "name": "Acknowledgements" },\n')
    /* Taking the member out again gives back the file byte for byte. */
    const parsed = JSON.parse(now) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['slug', 'title', 'lede', 'written', 'steps', 'parts'])
    expect(parsed.lede).toBe('Read chapter by chapter — with a "quote", a } and a ] in it.')
  })

  test('a second edit replaces the value where it is, wherever a person put the key', () => {
    const own = '{\n\t"parts": [ {"id":"a","name":"A"} ],\n\t"slug": "thesis",\n\t"title": "T"\n}\n'
    const dir = thesis(own, false)
    editParts(dir, 'thesis', { add: { name: 'B' } })
    expect(file(dir)).toBe('{\n\t"parts": [\n\t\t{ "id": "a", "name": "A" },\n\t\t{ "id": "b", "name": "B" }\n\t],\n\t"slug": "thesis",\n\t"title": "T"\n}\n')
  })

  test('a one-line file, and an empty object, are written without being laid out again', () => {
    expect(withMember('{"slug":"t","title":"T"}', 'parts', (indent) => (indent === null ? '[]' : 'laid out'))).toBe(
      '{"slug":"t","title":"T", "parts": []}',
    )
    expect(JSON.parse(withMember('{}\n', 'parts', () => '[]')!)).toEqual({ parts: [] })
    expect(withMember('[]', 'parts', () => '[]')).toBeNull()
  })

  test('a file that is not JSON is declined and left exactly as it is', () => {
    const dir = thesis('{ not json', false)
    const done = editParts(dir, 'thesis', { add: { name: 'A' } })
    expect(done.result.outcome).toBe('declined')
    expect(done.result.why).toContain('could not be read as JSON')
    expect(file(dir)).toBe('{ not json')
  })

  test('nothing is left beside the file', () => {
    const dir = thesis()
    editParts(dir, 'thesis', { add: { name: 'A' } })
    expect(readdirSync(epicsDir(dir))).toEqual(['thesis.json'])
  })

  test('hand-written entries that are not parts cost only themselves', () => {
    const own = JSON.stringify({ slug: 'thesis', parts: [{ id: 'a', name: ' A ' }, { id: 'Not An Id', name: 'x' }, 7, { id: 'a', name: 'twice' }, { id: 'b' }] })
    expect(listedIn(JSON.parse(own))).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'b' }])
    expect(listedIn({ parts: 'nonsense' })).toEqual([])
    expect(listedIn({})).toBeNull()
  })
})

describe('no edit is lost', () => {
  test('the writer is synchronous from its read to its write: there is nothing to await in between', () => {
    const dir = thesis()
    const done = editParts(dir, 'thesis', { add: { name: 'A' } })
    expect(done).not.toBeInstanceOf(Promise)
    expect((done as unknown as { then?: unknown }).then).toBeUndefined()
  })

  test('thirty edits asked for at once, from three callers, are all in the file', async () => {
    const dir = thesis()
    /* As the server meets them: each inside its own request, started together. */
    const asked = Array.from({ length: 30 }, (_, n) =>
      Promise.resolve().then(() => editParts(dir, 'thesis', { add: { name: `Extra ${n}` } })),
    )
    const done = await Promise.all(asked)
    expect(done.every((one) => one.result.outcome === 'changed')).toBe(true)
    const ids = listedIn(JSON.parse(file(dir)))!.map((part) => part.id)
    expect(ids).toHaveLength(37)
    expect(new Set(ids).size).toBe(37)
    for (let n = 0; n < 30; n += 1) expect(ids).toContain(`extra-${n}`)
  })

  test('a retitle and an edit of the parts, in either order, keep each other’s field', () => {
    const dir = thesis()
    editParts(dir, 'thesis', { add: { name: 'A' } })
    expect(retitleEpic(dir, 'thesis', 'Another title').ok).toBe(true)
    editParts(dir, 'thesis', { rename: { id: 'a', name: 'B' } })
    const now = JSON.parse(file(dir)) as { title: string; parts: { id: string; name: string }[]; lede: string }
    expect(now.title).toBe('Another title')
    expect(now.parts.at(-1)).toEqual({ id: 'a', name: 'B' })
    expect(now.lede).toContain('chapter by chapter')
    /* And the retitle's own answer carries the list, not the record's. */
    const said = retitleEpic(dir, 'thesis', 'A third')
    expect(said.ok && said.epic.parts?.at(-1)).toMatchObject({ id: 'a', heading: 'B' })
  })
})

describe('every outcome of one edit', () => {
  const list = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'c', name: 'C' },
  ]
  const ids = (result: PartsSetResult) => result.parts.map((part) => part.id)

  test('add: last, first, after one; the id is made from the name against the ids taken', () => {
    expect(ids(edited(list, { add: { name: 'D' } }))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(edited(list, { add: { name: 'D', after: null } }))).toEqual(['d', 'a', 'b', 'c'])
    expect(ids(edited(list, { add: { name: 'D', after: 'a' } }))).toEqual(['a', 'd', 'b', 'c'])
    expect(edited(list, { add: { name: '  A  ' } })).toMatchObject({ outcome: 'changed', id: 'a-2' })
    expect(edited(list, { add: { name: 'A' } }).parts.at(-1)).toEqual({ id: 'a-2', name: 'A' })
    expect(edited(list, { add: { name: '!!!' } }).id).toBe('part')
    expect(edited(list, { add: { name: 'D', after: 'nope' } })).toMatchObject({ outcome: 'no-such-part', parts: list })
  })

  test('add is declined past the limit, with a sentence, and the list as it stands', () => {
    const full = Array.from({ length: LIMITS.PARTS }, (_, n) => ({ id: `p${n}`, name: `P${n}` }))
    const said = edited(full, { add: { name: 'One more' } })
    expect(said.outcome).toBe('declined')
    expect(said.why).toContain(String(LIMITS.PARTS))
    expect(said.parts).toHaveLength(LIMITS.PARTS)
    expect(edited(full.slice(1), { add: { name: 'One more' } }).outcome).toBe('changed')
  })

  test('rename: the name only; unchanged when it is already that; never the id', () => {
    expect(edited(list, { rename: { id: 'b', name: 'Something else entirely' } })).toEqual({
      outcome: 'changed',
      parts: [list[0]!, { id: 'b', name: 'Something else entirely' }, list[2]!],
      id: 'b',
      why: '',
    })
    expect(edited(list, { rename: { id: 'b', name: ' B ' } })).toMatchObject({ outcome: 'unchanged', id: 'b', parts: list })
    expect(edited(list, { rename: { id: 'z', name: 'Z' } })).toMatchObject({ outcome: 'no-such-part', parts: list })
    expect(edited(list, { rename: { id: 'b', name: '   ' } }).outcome).toBe('declined')
  })

  test('move: the order only; unchanged when it is already there', () => {
    expect(ids(edited(list, { move: { id: 'c', after: null } }))).toEqual(['c', 'a', 'b'])
    expect(ids(edited(list, { move: { id: 'a' } }))).toEqual(['b', 'c', 'a'])
    expect(ids(edited(list, { move: { id: 'a', after: 'b' } }))).toEqual(['b', 'a', 'c'])
    expect(edited(list, { move: { id: 'a', after: null } })).toMatchObject({ outcome: 'unchanged', id: 'a' })
    expect(edited(list, { move: { id: 'b', after: 'a' } }).outcome).toBe('unchanged')
    expect(edited(list, { move: { id: 'c' } }).outcome).toBe('unchanged')
    expect(edited(list, { move: { id: 'z' } }).outcome).toBe('no-such-part')
    expect(edited(list, { move: { id: 'a', after: 'z' } })).toMatchObject({ outcome: 'no-such-part', parts: list })
    expect(edited(list, { move: { id: 'a', after: 'c' } }).parts.map((part) => part.name)).toEqual(['B', 'C', 'A'])
  })

  test('remove: the entry only', () => {
    expect(edited(list, { remove: { id: 'b' } })).toEqual({ outcome: 'changed', parts: [list[0]!, list[2]!], id: 'b', why: '' })
    expect(edited(list, { remove: { id: 'z' } })).toMatchObject({ outcome: 'no-such-part', parts: list })
  })

  test('every answer is the protocol’s result, whole', () => {
    for (const edit of [{ add: { name: 'D' } }, { rename: { id: 'z', name: 'Z' } }, { move: { id: 'a', after: null } }, { remove: { id: 'a' } }] as PartsEdit[]) {
      const said = edited(list, edit)
      expect(partsSetResult.parse(said)).toEqual(said)
    }
  })

  test('one place up and one place down, as `parts.set` says a place', () => {
    expect(stepTo(list, 'a', -1)).toBeUndefined()
    expect(stepTo(list, 'b', -1)).toBeNull()
    expect(stepTo(list, 'c', -1)).toBe('a')
    expect(stepTo(list, 'a', 1)).toBe('b')
    expect(stepTo(list, 'c', 1)).toBeUndefined()
    expect(ids(edited(list, { move: { id: 'c', after: stepTo(list, 'c', -1) } }))).toEqual(['a', 'c', 'b'])
    expect(ids(edited(list, { move: { id: 'a', after: stepTo(list, 'a', 1) } }))).toEqual(['b', 'a', 'c'])
  })
})

describe('what the modules hold is unioned, and no module is named', () => {
  test('documents and refs from every module’s folder, and the record’s share of a published kind is not read', () => {
    const dir = thesis()
    writeHoldings(dir, 'kehikot.sketches', 'thesis', {
      methods: { documents: ['.kehikot/sketches/thesis/methods.svg', 'src/sim/run.ts'], refs: ['gh#40', 'gh#12'] },
    })
    writeHoldings(dir, 'somebody.elses', 'thesis', {
      methods: { documents: ['.kehikot/paper/thesis/chapters/3b_instruments.tex'], refs: ['gh#41'] },
      'no-such-part': { documents: ['docs/x.md'], refs: [] },
    })
    const methods = sent(dir).find((part) => part.id === 'methods')!
    expect(methods.refs).toEqual(['gh#40', 'gh#12', 'gh#41'])
    expect(methods.documents).toEqual([
      '.kehikot/sketches/thesis/methods.svg',
      'src/sim/run.ts',
      '.kehikot/paper/thesis/chapters/3b_instruments.tex',
    ])
    /* For a module that still reads `files`: the documents that have a name there. */
    expect(methods.files).toEqual(['chapters/3b_instruments.tex'])
    /* A holding under an id the epic does not have is nobody's. */
    expect(sent(dir).map((part) => part.id)).toEqual(IDS)
  })

  test('the same after the list is adopted, and for a part made in the host', () => {
    const dir = thesis()
    const added = editParts(dir, 'thesis', { add: { name: 'Sketches' } })
    writeHoldings(dir, 'kehikot.sketches', 'thesis', { sketches: { documents: ['.kehikot/sketches/thesis/all.svg'], refs: ['gh#50'] } })
    expect(sent(dir, []).at(-1)).toEqual({
      id: added.result.id!,
      heading: 'Sketches',
      refs: ['gh#50'],
      picked: false,
      documents: ['.kehikot/sketches/thesis/all.svg'],
    })
  })

  test('a step filed under a part made in the host is that part’s step, with its refs', () => {
    const steps = [{ title: 'S', refs: ['gh#7'], part: 'made-here' }, { title: 'T', refs: ['gh#8'], part: 'made-here' }]
    const held = partsHeld([{ id: 'made-here', name: 'Made here' }], { steps, groups: [] }, undefined, 'thesis')
    expect(held).toEqual([{ id: 'made-here', heading: 'Made here', refs: ['gh#7', 'gh#8'], steps: 2 }])
  })

  test('bounded as the wire is, and absent when empty', () => {
    const many = Array.from({ length: LIMITS.PART_DOCUMENTS + 10 }, (_, n) => `.kehikot/paper/thesis/f${n}.tex`)
    const [part] = partsHeld([{ id: 'a', name: 'A' }], {}, { a: { documents: many, refs: [] } }, 'thesis')
    expect(part!.documents).toHaveLength(LIMITS.PART_DOCUMENTS)
    expect(part!.files).toHaveLength(LIMITS.PART_FILES)
    const [bare] = partsHeld([{ id: 'a', name: 'A' }], {}, undefined, 'thesis')
    expect(bare).toEqual({ id: 'a', heading: 'A', refs: [], steps: 0 })
    expect(partsOnWire([bare!], [])).toEqual([{ id: 'a', heading: 'A', refs: [], picked: false }])
  })

  test('`readParts` is the row’s parts, for one epic', () => {
    const dir = thesis()
    expect(readParts(dir, 'thesis')).toEqual(partsIn(dir))
    expect(readParts(dir, 'nope')).toBeNull()
  })
})

describe('the record’s share is a fallback, per kind and per epic', () => {
  /** A part as the host holds it, without its name and step count. */
  const holds = (dir: string) => Object.fromEntries(partsIn(dir).map(({ id, refs, files, documents }) => [id, { refs, files, documents }]))
  const paperOf = (file: string) => `.kehikot/paper/thesis/${file}`

  test('nobody has published: every part is what the record says, exactly', () => {
    const dir = thesis()
    expect(asBefore(sent(dir))).toEqual(before())
    for (const [id, , chapter] of CHAPTERS) {
      expect(holds(dir)[id]).toEqual({ refs: id === 'methods' ? ['gh#12'] : [], files: [chapter], documents: [paperOf(chapter)] })
    }
  })

  test('documents published for the epic: the record’s files are not read, for a part the publisher left out too', () => {
    const dir = thesis()
    /* The Methods chapter, moved to Results by whoever keeps it; five parts are not mentioned. */
    writeHoldings(dir, 'somebody.elses', 'thesis', {
      results: { documents: [paperOf('chapters/4_results.tex'), paperOf('chapters/3_methods.tex')], refs: [] },
    }, { published: ['documents'] })
    const now = holds(dir)
    expect(now.results).toEqual({ refs: [], files: ['chapters/4_results.tex', 'chapters/3_methods.tex'], documents: [paperOf('chapters/4_results.tex'), paperOf('chapters/3_methods.tex')] })
    /* The part the chapter left has no document — and still its refs, a kind nobody published. */
    expect(now.methods).toEqual({ refs: ['gh#12'], files: undefined, documents: undefined })
    for (const id of IDS.filter((one) => one !== 'results' && one !== 'methods')) {
      expect(now[id]).toEqual({ refs: [], files: undefined, documents: undefined })
    }
    /* On the wire the keys are absent, not empty. */
    expect(sent(dir).find((part) => part.id === 'methods')).toEqual({ id: 'methods', heading: 'Methods', refs: ['gh#12'], picked: true })
    /* The list and the steps are untouched by it. */
    expect(partsIn(dir).map((part) => part.id)).toEqual(IDS)
    expect(partsIn(dir).map((part) => part.steps)).toEqual([1, 1, 1, 1, 1, 1, 0])
  })

  test('documents published only under an id the epic does not have: still published', () => {
    const dir = thesis()
    writeHoldings(dir, 'somebody.elses', 'thesis', { 'removed-part': { documents: [paperOf('chapters/3_methods.tex')], refs: [] } })
    expect(partsIn(dir).every((part) => part.documents === undefined && part.files === undefined)).toBe(true)
  })

  test('refs published for the epic: the record’s refs are not read, and its documents still are', () => {
    const dir = thesis()
    writeHoldings(dir, 'somebody.elses', 'thesis', { results: { documents: [], refs: ['gh#77'] } }, { published: ['refs'] })
    const now = holds(dir)
    expect(now.results!.refs).toEqual(['gh#77'])
    expect(now.methods!.refs).toEqual([])
    for (const [id, , chapter] of CHAPTERS) {
      expect(now[id]!.files).toEqual([chapter])
      expect(now[id]!.documents).toEqual([paperOf(chapter)])
    }
  })

  test('both kinds published, by different modules: neither is read off the record', () => {
    const dir = thesis()
    writeHoldings(dir, 'kehikot.sketches', 'thesis', { introduction: { documents: ['docs/intro.md'], refs: [] } })
    writeHoldings(dir, 'somebody.elses', 'thesis', { conclusion: { documents: [], refs: ['gh#9'] } })
    const now = holds(dir)
    expect(now.introduction).toEqual({ refs: [], files: undefined, documents: ['docs/intro.md'] })
    expect(now.conclusion).toEqual({ refs: ['gh#9'], files: undefined, documents: undefined })
    expect(now.methods).toEqual({ refs: [], files: undefined, documents: undefined })
  })

  test('the refs of a step under a part made in the host are the record’s too', () => {
    const steps = [{ title: 'S', refs: ['gh#7'], part: 'made-here' }]
    const list = [{ id: 'made-here', name: 'Made here' }]
    expect(partsHeld(list, { steps, groups: [] }, { other: { documents: ['a.md'], refs: [] } }, 'thesis')[0]!.refs).toEqual(['gh#7'])
    expect(partsHeld(list, { steps, groups: [] }, { other: { documents: [], refs: ['gh#1'] } }, 'thesis')[0]).toEqual({
      id: 'made-here',
      heading: 'Made here',
      refs: [],
      steps: 1,
    })
  })

  test('a module’s empty or absent file, or one for another epic, changes nothing', () => {
    const dir = thesis()
    const was = partsIn(dir)
    /* No file at all is `was`. An empty one: */
    writeHoldings(dir, 'kehikot.sketches', 'thesis', {}, { published: [] })
    expect(partsIn(dir)).toEqual(was)
    /* Parts listed with nothing in them, said to speak for no kind: */
    writeHoldings(dir, 'somebody.elses', 'thesis', { methods: { documents: [], refs: [] }, results: { documents: [], refs: [] } }, { published: [] })
    expect(partsIn(dir)).toEqual(was)
    /* Something that is not a holdings file: */
    const folder = join(dir, '.kehikot', 'junk')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'parts.json'), 'not json')
    expect(partsIn(dir)).toEqual(was)
    /* And another epic's holdings are another epic's. */
    writeHoldings(dir, 'kehikot.other', 'another-epic', { methods: { documents: ['docs/x.md'], refs: ['gh#3'] } })
    expect(partsIn(dir)).toEqual(was)
    /* Handed straight in: undefined and `{}` are the same answer. */
    expect(partsHeld(null, record, {}, 'thesis')).toEqual(partsHeld(null, record, undefined, 'thesis'))
  })

  test('spoken is not held: a module that published a kind and then emptied it has still spoken (1.4.0)', () => {
    const dir = thesis()
    const was = partsIn(dir)
    /* Paper publishes every chapter under a part. */
    writeHoldings(dir, 'kehikot.paper', 'thesis', {
      methods: { documents: [paperOf('chapters/3_methods.tex')] },
      results: { documents: [paperOf('chapters/4_results.tex')] },
    }, { published: ['documents'] })
    expect(holds(dir).methods!.documents).toEqual([paperOf('chapters/3_methods.tex')])
    /* The last chapter set to "no part": nothing held, as it is written. */
    writeHoldings(dir, 'kehikot.paper', 'thesis', {}, { published: ['documents'] })
    expect(readHoldings(dir)).toEqual({})
    const now = holds(dir)
    for (const id of IDS) {
      expect(now[id]!.documents).toBeUndefined()
      expect(now[id]!.files).toBeUndefined()
    }
    /* Its refs were never spoken for: the record's still read. */
    expect(now.methods!.refs).toEqual(['gh#12'])
    expect(holdingsSpoken(dir, 'thesis')).toEqual({ documents: true, refs: false })
    /* With nothing spoken at all, as it was: byte for byte. */
    const fresh = thesis()
    expect(partsIn(fresh)).toEqual(was)
    /* The same call without the option speaks for both kinds. */
    writeHoldings(dir, 'kehikot.paper', 'thesis', {})
    expect(holds(dir).methods!.refs).toEqual([])
    /* And an older reading that is handed what is held, and not what was spoken, is what it was. */
    expect(partsHeld(null, record, undefined, 'thesis')).toEqual(partsHeld(null, record, undefined, 'thesis', { documents: false, refs: false }))
  })

  test('the same after the list is adopted', () => {
    const dir = thesis()
    editParts(dir, 'thesis', { add: { name: 'Sketches' } })
    expect(holds(dir).methods).toEqual({ refs: ['gh#12'], files: ['chapters/3_methods.tex'], documents: [paperOf('chapters/3_methods.tex')] })
    writeHoldings(dir, 'somebody.elses', 'thesis', { sketches: { documents: [paperOf('chapters/3_methods.tex')], refs: [] } }, { published: ['documents'] })
    expect(holds(dir).methods).toEqual({ refs: ['gh#12'], files: undefined, documents: undefined })
    expect(holds(dir).sketches).toEqual({ refs: [], files: ['chapters/3_methods.tex'], documents: [paperOf('chapters/3_methods.tex')] })
  })
})

describe('an older module is still greeted on a long epic', () => {
  const forty: EpicPart[] = Array.from({ length: 40 }, (_, n) => ({ id: `p${n}`, heading: `Part ${n}`, refs: [], picked: n === 37 || n === 3 }))
  const context = toWireContext({ epic: 'thesis', project: null }, 'dark', [], null, null, [], [], undefined, [], forty)
  /* The schema a module built before 1.2.0 parses a context with: 32 and no more. */
  const older = contextSchema.extend({ parts: z.array(z.object({ id: z.string() }).passthrough()).max(PARTS_BEFORE_1_2) })

  test('the host composes all forty', () => {
    expect(context.epic).toBe('thesis')
    expect(context.parts).toHaveLength(40)
    expect(older.safeParse(context).success).toBe(false)
  })

  test('built on 1.1.1: thirty-two, every picked part among them, in the epic’s order', () => {
    const told = readableBy(context, '1.1.1')
    expect(older.safeParse(told).success).toBe(true)
    expect(told.parts).toHaveLength(32)
    expect(told.parts.filter((part) => part.picked).map((part) => part.id)).toEqual(['p3', 'p37'])
    expect(told.parts.map((part) => part.id)).toEqual([...Array.from({ length: 31 }, (_, n) => `p${n}`), 'p37'])
    expect(told.epic).toBe('thesis')
  })

  test('built on 1.2.0: the whole list, and the very same context object', () => {
    expect(readableBy(context, '1.2.0')).toBe(context)
    expect(readableBy(context, '1.3.0').parts).toHaveLength(40)
  })

  test('no build stamp at all is treated as an old one', () => {
    for (const build of [null, undefined, '', 'nonsense']) {
      const told = readableBy(context, build)
      expect(told.parts).toHaveLength(32)
      expect(older.safeParse(told).success).toBe(true)
    }
  })

  test('an epic of thirty-two or fewer is sent to everybody as it is', () => {
    const seven = { ...context, parts: forty.slice(0, 7) }
    expect(readableBy(seven, '1.1.1')).toBe(seven)
    expect(readableBy(seven, null)).toBe(seven)
  })
})

describe('`parts.set`, from a module', () => {
  const ME = 'kehikot.sketches'
  const known = (id: string) => id === ME || id === 'kehikot.ungranted'
  const told: { root: string; epic: string }[] = []
  const divide = (granted = [ME]): PartsDoor => ({
    may: (module, capability) => capability === METHODS['parts.set'] && granted.includes(module),
    edit: (root, epic, edit) => {
      const done = editParts(root, epic, edit)
      if (done.written) told.push({ root, epic })
      return done.result
    },
  })
  const ask = (module: string, root: string | null, params: unknown, door: PartsDoor | null = divide()) => {
    const given = answer(module, 'parts.set', params, known, () => {}, root, undefined, null, null, door)
    return given.ok ? partsSetResult.parse(given.data) : given
  }

  test('the host answers it, and from the half that can write a project’s file', () => {
    expect(unanswered()).toEqual([])
    expect(ANSWERED_BY_THE_SERVER as readonly string[]).toContain('parts.set')
  })

  test('add, rename, move, remove: each through the one writer, each answering the list', () => {
    const dir = thesis()
    told.length = 0
    const added = ask(ME, dir, { epic: 'thesis', add: { name: 'Sketches', after: 'introduction' } }) as PartsSetResult
    expect(added).toMatchObject({ outcome: 'changed', id: 'sketches' })
    expect(added.parts.map((part) => part.id)).toEqual(['introduction', 'sketches', ...IDS.slice(1)])
    expect(ask(ME, dir, { epic: 'thesis', rename: { id: 'sketches', name: 'Drawings' } })).toMatchObject({ outcome: 'changed', id: 'sketches' })
    expect(ask(ME, dir, { epic: 'thesis', rename: { id: 'sketches', name: 'Drawings' } })).toMatchObject({ outcome: 'unchanged' })
    expect((ask(ME, dir, { epic: 'thesis', move: { id: 'sketches' } }) as PartsSetResult).parts.at(-1)).toEqual({ id: 'sketches', name: 'Drawings' })
    expect(ask(ME, dir, { epic: 'thesis', move: { id: 'sketches', after: 'nope' } })).toMatchObject({ outcome: 'no-such-part' })
    expect(ask(ME, dir, { epic: 'thesis', remove: { id: 'nope' } })).toMatchObject({ outcome: 'no-such-part' })
    const removed = ask(ME, dir, { epic: 'thesis', remove: { id: 'sketches' } }) as PartsSetResult
    expect(removed.parts.map((part) => part.id)).toEqual(IDS)
    /* Told once for each write, and for nothing else. */
    expect(told).toHaveLength(4)
    expect(partsIn(dir).map((part) => part.id)).toEqual(IDS)
  })

  test('an epic that is not one of the open project’s is declined, and nothing is made', () => {
    const dir = thesis()
    const said = ask(ME, dir, { epic: 'another-epic', add: { name: 'A' } }) as PartsSetResult
    expect(said).toMatchObject({ outcome: 'declined', parts: [], id: null })
    expect(said.why).toContain('no such epic')
    expect(readdirSync(epicsDir(dir))).toEqual(['thesis.json'])
    expect((ask(ME, null, { epic: 'thesis', add: { name: 'A' } }) as PartsSetResult).outcome).toBe('declined')
  })

  test('the list is full: declined', () => {
    const full = { slug: 'thesis', parts: Array.from({ length: LIMITS.PARTS }, (_, n) => ({ id: `p${n}`, name: `P${n}` })) }
    const dir = thesis(JSON.stringify(full), false)
    const said = ask(ME, dir, { epic: 'thesis', add: { name: 'A' } }) as PartsSetResult
    expect(said.outcome).toBe('declined')
    expect(said.parts).toHaveLength(LIMITS.PARTS)
  })

  test('a module whose manifest did not ask for parts:set is declined, and nothing is written', () => {
    const dir = thesis()
    const said = ask('kehikot.ungranted', dir, { epic: 'thesis', add: { name: 'A' } }) as PartsSetResult
    expect(said.outcome).toBe('declined')
    expect(said.why).toContain('parts:set')
    expect(file(dir)).toBe(OWN)
    /* And a host given no door for it says so rather than pretending. */
    expect((ask(ME, dir, { epic: 'thesis', add: { name: 'A' } }, null) as PartsSetResult).outcome).toBe('declined')
    expect(file(dir)).toBe(OWN)
  })

  test('a call naming none of the four, or two, never reaches the writer', () => {
    const dir = thesis()
    for (const params of [{ epic: 'thesis' }, { epic: 'thesis', add: { name: 'A' }, remove: { id: 'methods' } }, { add: { name: 'A' } }, { epic: 'thesis', move: { id: 'a', after: 'a' } }]) {
      const given = answer(ME, 'parts.set', params, known, () => {}, dir, undefined, null, null, divide())
      expect(given.ok).toBe(false)
    }
    expect(file(dir)).toBe(OWN)
  })

  test('a module nobody registered is not answered at all', () => {
    const given = answer('kehikot.stranger', 'parts.set', { epic: 'thesis', add: { name: 'A' } }, known, () => {}, thesis(), undefined, null, null, divide())
    expect(given).toMatchObject({ ok: false, reason: 'unknown-module' })
  })
})

describe('`set_parts`, at the host’s door', () => {
  function standing(dir: string, epic: string | null = 'thesis') {
    const db = open(':memory:')
    const added = addProject(db, dir, 'Thesis')
    if (!added.ok) throw new Error(added.why)
    const canvas = createCanvas(db, 'writing', added.project.id)
    setSubject(db, added.project.id, { epic })
    setSubject(db, added.project.id, { parts: ['methods', 'long-gone'] })
    const written: string[] = []
    const openness = new Openness()
    const wakes = new Wakes()
    const door: Door = {
      db,
      which: () => openness.open(),
      wake: () => {},
      epicsChanged: (project) => wakes.epicsChanged(project),
      epicWritten: (_project, slug) => void written.push(slug),
      dispositionsChanged: () => {},
      seen: async () => [],
    }
    return { door, kehikko: canvas.id, written }
  }

  test('`read_canvas` prints every part with its id and its name, and which are picked', async () => {
    const { door, kehikko } = standing(thesis())
    const read = await call('read_canvas', { kehikko }, door)
    expect(read.failed).toBe(false)
    expect(read.text).toContain('parts of the epic (id — name): introduction — "Introduction"; literature-review — "Literature Review"; methods — "Methods" [picked];')
    expect(read.text).toContain('parts of the epic picked out: methods —')
    expect(read.text).toContain('no longer a part of the epic (narrows nothing): long-gone.')
  })

  test('add, rename, move and remove: one edit a call, the same writer, the list answered', async () => {
    const dir = thesis()
    const { door, kehikko, written } = standing(dir)
    const added = await call('set_parts', { kehikko, add: { name: 'Acknowledgements', after: null } }, door)
    expect(added.failed).toBe(false)
    expect(added.text).toStartWith('Added acknowledgements. The parts of thesis (id — name), in order: acknowledgements — "Acknowledgements"; introduction — "Introduction";')
    /* The id an agent gets is the id the picker or a module would have got. */
    expect(listedIn(JSON.parse(file(dir)))![0]).toEqual({ id: 'acknowledgements', name: 'Acknowledgements' })

    const renamed = await call('set_parts', { kehikko, epic: 'thesis', rename: { id: 'acknowledgements', name: 'Thanks' } }, door)
    expect(renamed.text).toStartWith('Renamed acknowledgements; its id did not change.')
    expect(renamed.text).toContain('acknowledgements — "Thanks"')

    const moved = await call('set_parts', { kehikko, move: { id: 'acknowledgements' } }, door)
    expect(moved.text).toStartWith('Moved acknowledgements.')
    expect(moved.text).toEndWith('appendices — "Appendices"; acknowledgements — "Thanks".')

    const again = await call('set_parts', { kehikko, move: { id: 'acknowledgements' } }, door)
    expect(again.failed).toBe(false)
    expect(again.text).toStartWith('It already was as asked, so nothing was written.')

    const removed = await call('set_parts', { kehikko, remove: { id: 'acknowledgements' } }, door)
    expect(removed.text).toStartWith('Removed acknowledgements from the list; what modules hold under that id was not touched.')
    expect(partsIn(dir).map((part) => part.id)).toEqual(IDS)
    /* Every container showing the epic is told once per write, and not for the one that wrote nothing. */
    expect(written).toEqual(['thesis', 'thesis', 'thesis', 'thesis'])
  })

  test('what it refuses, in a sentence, with nothing written', async () => {
    const dir = thesis()
    const { door, kehikko, written } = standing(dir)
    for (const args of [
      {},
      { add: { name: 'A' }, remove: { id: 'methods' } },
      { add: { name: '' } },
      { rename: { id: 'Not An Id', name: 'x' } },
      { add: { name: 'x'.repeat(LIMITS.TITLE + 1) } },
    ]) {
      const done = await call('set_parts', { kehikko, ...args }, door)
      expect(done.failed).toBe(true)
      expect(done.text).toStartWith('nothing was changed')
    }
    const missing = await call('set_parts', { kehikko, remove: { id: 'nope' } }, door)
    expect(missing).toMatchObject({ failed: true })
    expect(missing.text).toContain('names no part of thesis')
    const elsewhere = await call('set_parts', { kehikko, epic: 'another', add: { name: 'A' } }, door)
    expect(elsewhere.text).toContain('no such epic')
    expect(file(dir)).toBe(OWN)
    expect(written).toEqual([])
  })

  test('a project on no epic needs one named', async () => {
    const { door, kehikko } = standing(thesis(), null)
    const done = await call('set_parts', { kehikko, add: { name: 'A' } }, door)
    expect(done.failed).toBe(true)
    expect(done.text).toContain('set_parts needs epic')
    expect((await call('set_parts', { kehikko, epic: 'thesis', add: { name: 'A' } }, door)).failed).toBe(false)
  })

  test('it says what it is: not read-only, and — one hint for four edits — destructive', async () => {
    const { door } = standing(thesis())
    const reply = await mcp({ id: 1, method: 'tools/list' }, door, { name: 'kehikko', version: '0' })
    const tool = (reply.body as { result: { tools: { name: string; annotations?: Record<string, unknown> }[] } }).result.tools.find((one) => one.name === 'set_parts')!
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false })
    const hello = await mcp({ id: 2, method: 'initialize' }, door, { name: 'kehikko', version: '0' })
    expect((hello.body as { result: { instructions: string } }).result.instructions).toContain('edits the list of parts')
  })
})
