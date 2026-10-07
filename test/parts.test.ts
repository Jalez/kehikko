import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { LIMITS, contextSchema, partsSchema, type EpicPart, type ModuleContext } from 'kehikot-module-protocol'

import {
  createCanvas,
  editCanvas,
  listCanvases,
  listSubjects,
  open as openDb,
  readSubject,
  setSubject,
} from '../server/canvases.ts'
import { epicsDir } from '../server/hostData.ts'
import { listEpics } from '../server/holdings.ts'
import { PORTABLE_CANVAS_FIELDS, PORTABLE_SUBJECT_FIELDS, keep, kehikotFile, parse, serialize, syncProject } from '../server/kehikot.ts'
import { addProject, type Project } from '../server/projects.ts'
import { toWireContext, whileFrozen } from '../src/host/context.ts'
import {
  focusSaid,
  partIdsIn,
  partsOf,
  partsOnWire,
  pickedIn,
  stepPart,
  toggled,
  type Part,
} from '../src/host/parts.ts'
import { edited, subjectsSchema, NOTHING } from '../src/host/subject.ts'

/**
 * The parts of an epic, and the ones a project is pointed at.
 *
 * The request was to "group things under an epic and focus the workspace on
 * one or several parts of it, while still being able to see all parts", and
 * four things had to be true for that to be safe:
 *
 *   - a part is one of the epic's existing `groups`, read rather than
 *     reinvented, so every epic on disk works with nothing migrated;
 *   - a step says which part it is in, and is never filed by its refs;
 *   - the focus is the PROJECT's, beside the epic and the selection, goes when
 *     the epic goes, and is never a kehikko's — "when I switch the kehikko it
 *     also switches the epic" was a bug once and must not come back as a focus;
 *   - every module is told every part, picked or not, so that one which
 *     narrows can say what it left out.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-parts-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let made = 0
function folder(): string {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
function project(store: Database, dir: string): Project {
  const out = addProject(store, dir, undefined, false)
  if (!out.ok) throw new Error(out.why)
  return out.project
}

/* The shape of the one real epic that has groups: headings and refs, no ids,
   and steps that name refs and say nothing about a part. */
const asOnDisk = {
  slug: 'the-roadmap-tracks-itself',
  title: 'The roadmap can be trusted about its own state',
  steps: [
    { title: 'The one path that writes in public has a gate on it', body: '', refs: ['gh#1'], notes: [] },
    { title: 'The claim ledger is safe to be wrong about', body: '', refs: ['gh#3'], notes: [] },
    { title: 'A filter that cannot match says so', body: '', refs: ['gh#9'], notes: [] },
  ],
  groups: [
    { heading: 'The posting seam', refs: ['gh#1', 'gh#3', 'gh#2'] },
    { heading: 'The agent seam', refs: ['gh#4', 'gh#5'] },
    { heading: 'What the page shows', refs: ['gh#8', 'gh#9'] },
  ],
}

describe('a part is one of the epic’s groups', () => {
  test('an epic as it is on disk today has parts, with ids nobody had to write', () => {
    expect(partsOf(asOnDisk)).toEqual([
      { id: 'the-posting-seam', heading: 'The posting seam', refs: ['gh#1', 'gh#3', 'gh#2'], steps: 0 },
      { id: 'the-agent-seam', heading: 'The agent seam', refs: ['gh#4', 'gh#5'], steps: 0 },
      { id: 'what-the-page-shows', heading: 'What the page shows', refs: ['gh#8', 'gh#9'], steps: 0 },
    ])
  })

  test('an epic with no groups has none, and so does anything that is not an epic', () => {
    for (const none of [{ slug: 'x', groups: [] }, { slug: 'x' }, { groups: 'nope' }, null, 'text', 7, []]) {
      expect(partsOf(none)).toEqual([])
    }
  })

  test('an id written beside the heading wins, so the heading can be reworded', () => {
    const before = partsOf({ groups: [{ id: 'posting', heading: 'The posting seam', refs: ['gh#1'] }] })
    const after = partsOf({ groups: [{ id: 'posting', heading: 'Everything that posts', refs: ['gh#1'] }] })
    expect(before[0]?.id).toBe('posting')
    expect(after[0]).toEqual({ id: 'posting', heading: 'Everything that posts', refs: ['gh#1'], steps: 0 })
    /* An id that is not one is not trusted; the heading's is used. */
    expect(partsOf({ groups: [{ id: '../etc', heading: 'A part' }] })[0]?.id).toBe('a-part')
  })

  test('two groups with one name are told apart rather than one of them vanishing', () => {
    const parts = partsOf({
      groups: [{ heading: 'Tests' }, { heading: 'tests!' }, { heading: 'TESTS' }, { heading: '!!!' }, { refs: ['gh#1'] }],
    })
    expect(parts.map((part) => part.id)).toEqual(['tests', 'tests-2', 'tests-3', 'part-4', 'part-5'])
    /* The heading is prose and is kept as written; one with no heading at all
       still has something to be called. */
    expect(parts[3]?.heading).toBe('!!!')
    expect(parts[4]?.heading).toBe('part-5')
  })

  test('junk in the file costs that entry and nothing else', () => {
    const parts = partsOf({
      groups: [null, 'a string', { heading: 'Kept', refs: ['gh#1', '', '  ', 42, 'gh#1', 'x'.repeat(500), ' gh#2 '] }, 17],
    })
    expect(parts).toEqual([{ id: 'kept', heading: 'Kept', refs: ['gh#1', 'gh#2'], steps: 0 }])
  })

  test('both lists are bounded, at the protocol’s numbers', () => {
    const many = { groups: Array.from({ length: LIMITS.PARTS + 5 }, (_, i) => ({ heading: `Part ${i}` })) }
    expect(partsOf(many)).toHaveLength(LIMITS.PARTS)
    const wide = { groups: [{ heading: 'Wide', refs: Array.from({ length: LIMITS.PART_REFS + 9 }, (_, i) => `gh#${i}`) }] }
    expect(partsOf(wide)[0]?.refs).toHaveLength(LIMITS.PART_REFS)
    /* And what leaves is what the protocol's own schema takes. */
    expect(partsSchema.safeParse(partsOnWire(partsOf(many), [])).success).toBe(true)
    expect(partsSchema.safeParse(partsOnWire(partsOf(wide), [])).success).toBe(true)
  })
})

describe('a step says which part it is in', () => {
  test('a step with no part is in none, whatever refs it names', () => {
    /* gh#9 is listed under "What the page shows" and a step names gh#9. That
       does not put the step there: the count stays zero. */
    expect(partsOf(asOnDisk).map((part) => part.steps)).toEqual([0, 0, 0])
    expect(stepPart(asOnDisk.steps[0])).toBeNull()
  })

  test('an assigned step is counted, and brings its refs into the part', () => {
    const epic = {
      ...asOnDisk,
      steps: [
        { title: 'a', refs: ['gh#1'], part: 'the-posting-seam' },
        { title: 'b', refs: ['gh#77', 'gh#4'], part: 'the-agent-seam' },
        { title: 'c', refs: ['gh#78'] },
      ],
    }
    const parts = partsOf(epic)
    expect(parts.map((part) => part.steps)).toEqual([1, 1, 0])
    /* Folded in once: gh#1 and gh#4 were already listed. */
    expect(parts[0]?.refs).toEqual(['gh#1', 'gh#3', 'gh#2'])
    expect(parts[1]?.refs).toEqual(['gh#4', 'gh#5', 'gh#77'])
    /* The unassigned step's ref is in no part. */
    expect(parts.some((part) => part.refs.includes('gh#78'))).toBe(false)
  })

  test('a part that is not there is not an assignment', () => {
    const parts = partsOf({ ...asOnDisk, steps: [{ title: 'a', refs: ['gh#50'], part: 'a-part-that-was-deleted' }] })
    expect(parts.map((part) => part.steps)).toEqual([0, 0, 0])
    expect(parts.some((part) => part.refs.includes('gh#50'))).toBe(false)
  })

  test('anything that is not an id is no assignment', () => {
    for (const part of [undefined, null, '', 'The posting seam', 3, ['the-posting-seam'], '../x']) {
      expect(stepPart({ title: 'a', part })).toBeNull()
    }
    expect(stepPart({ part: 'the-posting-seam' })).toBe('the-posting-seam')
    expect(stepPart(null)).toBeNull()
  })
})

describe('the picker’s arithmetic', () => {
  const parts: Part[] = partsOf(asOnDisk)

  test('nothing picked is the whole epic, and says so', () => {
    expect(pickedIn(parts, [])).toEqual([])
    expect(focusSaid(parts, [])).toMatchObject({ narrowed: false, label: 'all parts' })
  })

  test('a press adds, a second press removes, and the order is the epic’s', () => {
    const one = toggled(parts, [], 'what-the-page-shows')
    expect(one).toEqual(['what-the-page-shows'])
    const two = toggled(parts, one, 'the-posting-seam')
    expect(two).toEqual(['the-posting-seam', 'what-the-page-shows'])
    expect(toggled(parts, two, 'what-the-page-shows')).toEqual(['the-posting-seam'])
    expect(toggled(parts, ['the-posting-seam'], 'the-posting-seam')).toEqual([])
  })

  test('a stored id that names no part does not apply, and never hides everything', () => {
    /* The part was renamed in the file while it was picked. */
    expect(pickedIn(parts, ['a-part-that-was-renamed'])).toEqual([])
    expect(focusSaid(parts, ['a-part-that-was-renamed']).narrowed).toBe(false)
    expect(partsOnWire(parts, ['a-part-that-was-renamed']).some((part) => part.picked)).toBe(false)
    /* And the next press writes a list the picker could have drawn. */
    expect(toggled(parts, ['a-part-that-was-renamed'], 'the-agent-seam')).toEqual(['the-agent-seam'])
  })

  test('when it is narrowed the bar names what it is narrowed to', () => {
    expect(focusSaid(parts, ['the-agent-seam'])).toMatchObject({ narrowed: true, label: 'The agent seam' })
    const two = focusSaid(parts, ['the-agent-seam', 'the-posting-seam'])
    expect(two.label).toBe('2 of 3 parts')
    expect(two.hint).toContain('The posting seam, The agent seam')
    expect(two.hint).toContain('The other 1')
  })

  test('ids are bounded before they are stored', () => {
    expect(partIdsIn(['a', 'a', '', 'Not An Id', 7, null, 'b'])).toEqual(['a', 'b'])
    expect(partIdsIn('a')).toEqual([])
    expect(partIdsIn(Array.from({ length: 99 }, (_, i) => `p${i}`))).toHaveLength(LIMITS.PARTS)
  })
})

describe('the focus is the project’s, beside the epic and the selection', () => {
  test('it is stored, and comes back', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    setSubject(store, p.id, { epic: 'one' })
    expect(readSubject(store, p.id)).toEqual({ epic: 'one', parts: [], selection: [] })
    expect(setSubject(store, p.id, { parts: ['the-agent-seam', 'the-posting-seam'] })).toEqual({
      epic: 'one',
      parts: ['the-agent-seam', 'the-posting-seam'],
      selection: [],
    })
    expect(listSubjects(store).find((row) => row.project === p.id)?.parts).toEqual(['the-agent-seam', 'the-posting-seam'])
    /* And cleared, which is the whole epic again. */
    setSubject(store, p.id, { parts: [] })
    expect(readSubject(store, p.id)?.parts).toEqual([])
  })

  test('a different epic clears it, on the line that clears the selection; the same epic keeps it', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    setSubject(store, p.id, { epic: 'one', parts: ['a'], selection: ['gh#1'] })
    setSubject(store, p.id, { epic: 'one' })
    expect(readSubject(store, p.id)).toEqual({ epic: 'one', parts: ['a'], selection: ['gh#1'] })
    setSubject(store, p.id, { epic: 'two' })
    expect(readSubject(store, p.id)).toEqual({ epic: 'two', parts: [], selection: [] })
    /* Unless the same edit says what they are to be. */
    setSubject(store, p.id, { epic: 'three', parts: ['b'] })
    expect(readSubject(store, p.id)?.parts).toEqual(['b'])
    /* No epic has no parts, whatever was asked. */
    expect(setSubject(store, p.id, { epic: null, parts: ['b'] })?.parts).toEqual([])
  })

  test('picking refs leaves the parts alone, and picking parts leaves the refs alone', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    setSubject(store, p.id, { epic: 'one', parts: ['a'] })
    setSubject(store, p.id, { selection: ['gh#1'] })
    expect(readSubject(store, p.id)).toEqual({ epic: 'one', parts: ['a'], selection: ['gh#1'] })
    setSubject(store, p.id, { parts: ['a', 'b'] })
    expect(readSubject(store, p.id)?.selection).toEqual(['gh#1'])
  })

  test('the page applies the same rule before the server answers', () => {
    const was = { epic: 'one', parts: ['a'], selection: ['gh#1'] }
    expect(edited(was, { epic: 'one' })).toEqual(was)
    expect(edited(was, { epic: 'two' })).toEqual({ epic: 'two', parts: [], selection: [] })
    expect(edited(was, { parts: [] })).toEqual({ epic: 'one', parts: [], selection: ['gh#1'] })
    expect(edited(was, { epic: null, parts: ['a'] }).parts).toEqual([])
    expect(NOTHING.parts).toEqual([])
    /* A server from before parts answers with none, which is the whole epic. */
    expect(subjectsSchema.parse([{ project: 1, epic: 'one', selection: [] }])[1]?.parts).toEqual([])
  })

  test('a database from before parts reads as every project on the whole of its epic', () => {
    const file = join(folder(), 'frame.sqlite')
    const first = openDb(file)
    const p = project(first, folder())
    setSubject(first, p.id, { epic: 'one', selection: ['gh#1'] })
    /* Take the column away, as it was. */
    first.exec('alter table projects drop column parts')
    first.close()
    const again = openDb(file)
    expect(readSubject(again, p.id)).toEqual({ epic: 'one', parts: [], selection: ['gh#1'] })
    again.close()
  })

  test('a column somebody edited by hand is no focus, never a broken project', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    setSubject(store, p.id, { epic: 'one' })
    for (const junk of ['{ not json', '"a"', '{"a":1}', '17', '[1, "Not An Id", "ok"]']) {
      store.query('update projects set parts = ? where id = ?').run(junk, p.id)
      expect(readSubject(store, p.id)?.parts).toEqual(junk.includes('ok') ? ['ok'] : [])
    }
  })
})

describe('a kehikko is a layout, and carries no focus', () => {
  test('no kehikko has a field for it, in memory or in the file', () => {
    const dir = folder()
    const store = openDb(':memory:')
    const p = project(store, dir)
    createCanvas(store, 'writing', p.id, 'writing')
    createCanvas(store, 'review', p.id, 'review')
    setSubject(store, p.id, { epic: 'one', parts: ['a', 'b'] })
    keep(store, p.id)
    for (const canvas of listCanvases(store)) {
      expect(Object.keys(canvas)).not.toContain('parts')
      expect(Object.keys(canvas)).not.toContain('epic')
    }
    expect(PORTABLE_CANVAS_FIELDS as readonly string[]).not.toContain('parts')
    expect(PORTABLE_SUBJECT_FIELDS).toEqual(['epic', 'parts', 'selection'])
    const raw = JSON.parse(readFileSync(kehikotFile(dir)!, 'utf8'))
    expect(raw.parts).toEqual(['a', 'b'])
    for (const kehikko of raw.kehikot) expect(Object.keys(kehikko).sort()).toEqual(['containers', 'key', 'name'])
    /* And the canvases table has no column for it. */
    const columns = store.query<{ name: string }, []>('pragma table_info(canvases)').all().map((c) => c.name)
    expect(columns).not.toContain('parts')
  })

  test('rearranging, renaming, adding or removing a kehikko leaves the focus where it was', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    const one = createCanvas(store, 'one', p.id)
    setSubject(store, p.id, { epic: 'one', parts: ['a'] })
    editCanvas(store, one.id, { name: 'renamed', placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    createCanvas(store, 'two', p.id)
    expect(readSubject(store, p.id)?.parts).toEqual(['a'])
  })

  test('changing the focus leaves every kehikko exactly as it was', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    const one = createCanvas(store, 'one', p.id)
    editCanvas(store, one.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    createCanvas(store, 'two', p.id)
    const before = listCanvases(store)
    setSubject(store, p.id, { epic: 'one', parts: ['a'] })
    setSubject(store, p.id, { parts: [] })
    expect(listCanvases(store)).toEqual(before)
  })
})

describe('the focus travels in the project’s kehikot.json', () => {
  test('a project nobody has focused keeps the bytes it had: the key is written only when some are picked', () => {
    const whole = serialize([], { epic: 'one', parts: [], selection: ['gh#1'] })
    expect(whole).toBe('{\n  "version": 2,\n  "epic": "one",\n  "selection": ["gh#1"],\n  "kehikot": [\n  ]\n}\n')
    const narrowed = serialize([], { epic: 'one', parts: ['a', 'b'], selection: ['gh#1'] })
    expect(narrowed).toContain('  "epic": "one",\n  "parts": ["a","b"],\n  "selection": ["gh#1"],')
  })

  test('a file with no parts reads as the whole epic, and one with them reads them', () => {
    const none = parse(serialize([], { epic: 'one', parts: [], selection: [] }))
    expect(none.ok && none.subject).toEqual({ epic: 'one', parts: [], selection: [] })
    const some = parse(serialize([], { epic: 'one', parts: ['a', 'b'], selection: [] }))
    expect(some.ok && some.subject.parts).toEqual(['a', 'b'])
  })

  test('parts with no epic are parts of nothing, and a part id is held to its shape', () => {
    const orphan = parse('{"version":2,"epic":null,"parts":["a"],"selection":[],"kehikot":[]}')
    expect(orphan.ok && orphan.subject.parts).toEqual([])
    expect(parse('{"version":2,"epic":"one","parts":["Not An Id"],"selection":[],"kehikot":[]}').ok).toBe(false)
  })

  test('it goes to the other computer with the epic', () => {
    const dir = folder()
    const here = openDb(':memory:')
    const p = project(here, dir)
    createCanvas(here, 'writing', p.id, 'writing')
    setSubject(here, p.id, { epic: 'one', parts: ['a'], selection: ['gh#9'] })
    keep(here, p.id)
    const there = openDb(':memory:')
    const q = project(there, dir)
    syncProject(there, q)
    expect(readSubject(there, q.id)).toEqual({ epic: 'one', parts: ['a'], selection: ['gh#9'] })
  })

  test('the file wins for the focus as it does for the epic', () => {
    const dir = folder()
    const store = openDb(':memory:')
    const p = project(store, dir)
    createCanvas(store, 'writing', p.id, 'writing')
    setSubject(store, p.id, { epic: 'one', parts: ['a'] })
    keep(store, p.id)
    const file = kehikotFile(dir)!
    writeFileSync(file, readFileSync(file, 'utf8').replace('"parts": ["a"]', '"parts": ["b","c"]'))
    syncProject(store, p)
    expect(readSubject(store, p.id)?.parts).toEqual(['b', 'c'])
  })
})

describe('the list of epics says which have parts', () => {
  test('an epic with groups carries them; one without is exactly as it was', () => {
    const dir = folder()
    mkdirSync(epicsDir(dir), { recursive: true })
    writeFileSync(join(epicsDir(dir), 'the-roadmap-tracks-itself.json'), JSON.stringify(asOnDisk))
    writeFileSync(join(epicsDir(dir), 'plain.json'), JSON.stringify({ slug: 'plain', title: 'Plain', groups: [] }))
    const epics = listEpics(dir)
    const plain = epics.find((epic) => epic.slug === 'plain')
    expect(plain).toEqual({ slug: 'plain', title: 'Plain' })
    const divided = epics.find((epic) => epic.slug === 'the-roadmap-tracks-itself')
    expect(divided?.parts?.map((part) => part.id)).toEqual(['the-posting-seam', 'the-agent-seam', 'what-the-page-shows'])
  })
})

describe('every module is told every part', () => {
  const parts = partsOf(asOnDisk)
  const subject = { epic: 'the-roadmap-tracks-itself', project: null }
  const wire = (picked: string[], epic: string | null = subject.epic) =>
    toWireContext({ ...subject, epic }, 'light', [], null, null, [], [], { at: null, refreshing: false }, [], partsOnWire(parts, picked))

  test('picked or not, each with its refs — which is what "N outside" is counted from', () => {
    const context = wire(['the-agent-seam'])
    expect(context.parts.map((part) => [part.id, part.picked])).toEqual([
      ['the-posting-seam', false],
      ['the-agent-seam', true],
      ['what-the-page-shows', false],
    ])
    expect(context.parts[0]?.refs).toEqual(['gh#1', 'gh#3', 'gh#2'])
  })

  test('nothing picked sends every part unpicked, and a context always has the field', () => {
    expect(wire([]).parts.every((part) => !part.picked)).toBe(true)
    const bare = toWireContext({ epic: 'x', project: null }, 'light')
    expect(bare.parts).toEqual([])
  })

  test('a module built against a protocol from before parts reads the same context it always did', () => {
    /* Such a module's own parse drops the one field it has never heard of and
       keeps the rest. So: take the field away, and a focused context and an
       unfocused one are the same context. */
    const older = (context: ModuleContext) => {
      const { parts: _unheardOf, ...rest } = context
      return rest
    }
    expect(older(wire(['the-agent-seam']))).toEqual(older(wire([])))
    expect(older(wire(['the-agent-seam'])).epic).toBe('the-roadmap-tracks-itself')
  })

  test('the context that leaves is one the protocol’s own schema takes whole, parts and all', () => {
    const sent = wire(['the-agent-seam'])
    expect(contextSchema.parse(sent)).toEqual(sent)
  })

  test('an epic the context cannot name takes its parts with it', () => {
    const context = wire(['the-agent-seam'], 'Not A Slug')
    expect(context.epic).toBeNull()
    expect(context.parts).toEqual([])
  })

  test('a list that will not parse is no parts, not a context that could not go out', () => {
    const sent = (list: EpicPart[]) =>
      toWireContext({ epic: 'x', project: null }, 'light', [], null, null, [], [], { at: null, refreshing: false }, [], list)
    const refused = sent([{ id: 'Not An Id', heading: '', refs: [], picked: true }])
    expect(refused.parts).toEqual([])
    /* And it cost the context nothing else: the epic is still named. */
    expect(refused.epic).toBe('x')
    expect(sent(partsOnWire(parts, ['the-agent-seam'])).parts).toHaveLength(3)
  })

  test('a pinned container keeps the parts it was pinned with', () => {
    const held = wire(['the-agent-seam'])
    /* The bar is cleared; nothing else moved. A pin holds what the container
       is about, and the focus is part of that. */
    expect(whileFrozen(held, wire([]))).toBeNull()
    /* When something that does pass a pin moves, the held parts ride along. */
    const relit = whileFrozen(held, { ...wire([]), theme: 'dark' })
    expect((relit as typeof held).parts.find((part) => part.picked)?.id).toBe('the-agent-seam')
  })
})
