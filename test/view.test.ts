import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { createCanvas, editCanvas, listCanvases, open as openDb, readSubject, setSubject, type Placement } from '../server/canvases.ts'
import { keep, kehikotFile, parse, serialize, syncProject } from '../server/kehikot.ts'
import { addProject, type Project } from '../server/projects.ts'
import { parseView, viewFile } from '../server/view.ts'
import { olderHostReads } from './fixtures/pre-split/reader.ts'

/*
 * The layout everybody shares (`kehikot.json`) and what one person is looking
 * at (`view.json`), split. Real folders, as in `kehikot.test.ts`: "another
 * computer" is a second empty database on the same folder.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-view-')))
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

const notes: Placement = {
  i: 'kehikot.notes',
  x: 0,
  y: 0,
  w: 6,
  h: 10,
  grow: false,
  pinned: false,
  prompt: '',
  promptFor: null,
  collapsed: false,
  wish: 10,
  selected: false,
  filters: {},
  refreshEvery: null,
  version: null,
}
const paper: Placement = { ...notes, i: 'kehikot.paper', y: 10, h: 12, wish: 12 }

/** A project with one kehikko holding notes over paper, written out. */
function arranged() {
  const dir = folder()
  const store = openDb(':memory:')
  const p = project(store, dir)
  const kehikko = createCanvas(store, 'writing', p.id, 'writing')
  editCanvas(store, kehikko.id, { placements: [notes, paper] })
  keep(store, p.id)
  return { dir, store, p, kehikko }
}

describe('what is shared and what is one person’s', () => {
  test('a fold, a tick, a filter and another epic change view.json and not a byte of kehikot.json', () => {
    const { dir, store, p, kehikko } = arranged()
    const shared = readFileSync(kehikotFile(dir)!, 'utf8')

    /* Notes folded as the page folds it: one row, and paper moves up under it. */
    editCanvas(store, kehikko.id, {
      placements: [
        { ...notes, collapsed: true, h: 1, selected: true },
        { ...paper, y: 1, filters: { scope: 'chapter' } },
      ],
    })
    setSubject(store, p.id, { epic: 'modes-are-modules', parts: ['a'], selection: ['gh#1'] })
    keep(store, p.id)

    expect(readFileSync(kehikotFile(dir)!, 'utf8')).toBe(shared)
    const view = JSON.parse(readFileSync(viewFile(dir)!, 'utf8'))
    expect(view).toEqual({
      version: 1,
      epic: 'modes-are-modules',
      parts: ['a'],
      selection: ['gh#1'],
      kehikot: {
        writing: {
          'kehikot.notes': { collapsed: true, selected: true },
          'kehikot.paper': { filters: { scope: 'chapter' } },
        },
      },
    })
  })

  test('the view is one line per kehikko and names only what is not at rest', () => {
    const { dir, store, p, kehikko } = arranged()
    editCanvas(store, kehikko.id, { placements: [{ ...notes, selected: true }, paper] })
    keep(store, p.id)
    const text = readFileSync(viewFile(dir)!, 'utf8')
    expect(text).toContain('    "writing": {"kehikot.notes":{"selected":true}}\n')
    expect(text).not.toContain('kehikot.paper')
  })

  test('another computer gets the layout, and its own view: nothing folded, no epic', () => {
    const { dir, store, p, kehikko } = arranged()
    editCanvas(store, kehikko.id, { placements: [{ ...notes, collapsed: true, h: 1 }, { ...paper, y: 1 }] })
    setSubject(store, p.id, { epic: 'mine' })
    keep(store, p.id)

    /* A clone carries kehikot.json and not view.json, which is ignored. */
    const clone = folder()
    mkdirSync(join(clone, '.kehikot', 'host'), { recursive: true })
    writeFileSync(kehikotFile(clone)!, readFileSync(kehikotFile(dir)!, 'utf8'))
    const there = openDb(':memory:')
    const q = project(there, clone)
    expect(syncProject(there, q)).toMatchObject({ outcome: 'read', changed: true })
    const [arrived] = listCanvases(there)
    /* Unfolded, at the heights the layout has: notes at its wish, paper under it. */
    expect(arrived!.placements.map((x) => [x.i, x.y, x.h, x.collapsed])).toEqual([
      ['kehikot.notes', 0, 10, false],
      ['kehikot.paper', 10, 12, false],
    ])
    expect(readSubject(there, q.id)).toEqual({ epic: null, parts: [], selection: [] })
    /* And that computer now keeps a view of its own. */
    expect(existsSync(viewFile(clone)!)).toBe(true)
  })

  test('the same computer reads its folds back through the layout', () => {
    const { dir, store, p, kehikko } = arranged()
    editCanvas(store, kehikko.id, { placements: [{ ...notes, collapsed: true, h: 1 }, { ...paper, y: 1 }] })
    keep(store, p.id)
    const there = openDb(':memory:')
    const q = project(there, dir)
    syncProject(there, q)
    expect(listCanvases(there)[0]!.placements.map((x) => [x.i, x.y, x.h, x.collapsed])).toEqual([
      ['kehikot.notes', 0, 1, true],
      ['kehikot.paper', 1, 12, false],
    ])
    /* And reading it again changes nothing. */
    expect(syncProject(there, q)).toMatchObject({ outcome: 'read', changed: false })
  })

  test('two people’s different views make the same kehikot.json — nothing to merge', () => {
    const { dir, store, p, kehikko } = arranged()
    const before = readFileSync(kehikotFile(dir)!, 'utf8')
    for (const look of [
      { placements: [{ ...notes, collapsed: true, h: 1 }, { ...paper, y: 1, selected: true }], epic: 'one' },
      { placements: [notes, { ...paper, filters: { kind: 'todo' } }], epic: 'two' },
    ]) {
      editCanvas(store, kehikko.id, { placements: look.placements })
      setSubject(store, p.id, { epic: look.epic })
      keep(store, p.id)
      expect(readFileSync(kehikotFile(dir)!, 'utf8')).toBe(before)
    }
  })
})

describe('view.json is kept out of git', () => {
  test('the host folder’s .gitignore names it, and an existing one is appended to, not rewritten', () => {
    const dir = folder()
    mkdirSync(join(dir, '.kehikot', 'host'), { recursive: true })
    const ignore = join(dir, '.kehikot', 'host', '.gitignore')
    writeFileSync(ignore, '# tracker\ntracker-reading.json\n')
    const store = openDb(':memory:')
    const p = project(store, dir)
    createCanvas(store, 'writing', p.id, 'writing')
    keep(store, p.id)
    const text = readFileSync(ignore, 'utf8')
    expect(text.startsWith('# tracker\ntracker-reading.json\n')).toBe(true)
    expect(text.split('\n')).toContain('view.json')
    /* Once. */
    setSubject(store, p.id, { epic: 'x' })
    keep(store, p.id)
    expect(readFileSync(ignore, 'utf8')).toBe(text)
  })
})

describe('a file written before the split', () => {
  const preSplit = `{
  "version": 2,
  "epic": "every-epic-aims-at-a-paper",
  "parts": ["a"],
  "selection": ["gh#4"],
  "kehikot": [
    {
      "key": "ec29f1c0",
      "name": "kehikko",
      "containers": [
        {"module":"kehikot.claude","x":0,"y":1,"w":12,"h":27,"grow":false,"pinned":false,"prompt":"","promptFor":null,"collapsed":false,"wish":27,"selected":true,"filters":{"kind":"todo"},"refreshEvery":null},
        {"module":"kehikot.journeys","x":0,"y":0,"w":12,"h":1,"grow":false,"pinned":false,"prompt":"","promptFor":null,"collapsed":true,"wish":10,"selected":false,"filters":{},"refreshEvery":null}
      ]
    }
  ]
}
`
  function old() {
    const dir = folder()
    mkdirSync(join(dir, '.kehikot', 'host'), { recursive: true })
    writeFileSync(kehikotFile(dir)!, preSplit)
    const store = openDb(':memory:')
    const p = project(store, dir)
    return { dir, store, p }
  }

  test('its personal fields move to view.json on the first read, and the shared file is untouched until a write', () => {
    const { dir, store, p } = old()
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: true })
    expect(readSubject(store, p.id)).toEqual({ epic: 'every-epic-aims-at-a-paper', parts: ['a'], selection: ['gh#4'] })
    const placements = listCanvases(store)[0]!.placements
    expect(placements.find((x) => x.i === 'kehikot.journeys')).toMatchObject({ collapsed: true, h: 1, wish: 10 })
    expect(placements.find((x) => x.i === 'kehikot.claude')).toMatchObject({ selected: true, filters: { kind: 'todo' } })

    /* The view has them now. */
    const view = parseView(readFileSync(viewFile(dir)!, 'utf8'))!
    expect(view.subject.epic).toBe('every-epic-aims-at-a-paper')
    expect(view.kehikot.get('ec29f1c0')?.get('kehikot.journeys')?.collapsed).toBe(true)
    /* Opening a project makes no diff in it. */
    expect(readFileSync(kehikotFile(dir)!, 'utf8')).toBe(preSplit)

    /* The first write takes them out of the shared file. */
    keep(store, p.id)
    const shared = readFileSync(kehikotFile(dir)!, 'utf8')
    expect(shared).toBe(serialize(listCanvases(store)))
    for (const word of ['"epic"', '"parts"', '"selection"', '"collapsed"', '"selected"', '"filters"']) {
      expect(shared).not.toContain(word)
    }
  })

  test('with a view.json, the legacy fields an older host writes are ignored', () => {
    const { dir, store, p } = old()
    syncProject(store, p)
    setSubject(store, p.id, { epic: 'mine-now' })
    keep(store, p.id)
    /* A teammate on an older host commits the old shape again; this computer pulls it. */
    writeFileSync(kehikotFile(dir)!, preSplit)
    syncProject(store, p)
    expect(readSubject(store, p.id)?.epic).toBe('mine-now')
  })

  test('a view.json that will not read is as good as none: written again from this computer', () => {
    const { dir, store, p } = old()
    syncProject(store, p)
    setSubject(store, p.id, { epic: 'kept' })
    keep(store, p.id)
    writeFileSync(viewFile(dir)!, '{ not json')
    keep(store, p.id)
    expect(parseView(readFileSync(viewFile(dir)!, 'utf8'))?.subject.epic).toBe('kept')
  })
})

describe('an older host reads the new file', () => {
  test('the reader of every host before the split parses what this host writes, layout intact', () => {
    const { dir, store, p, kehikko } = arranged()
    editCanvas(store, kehikko.id, {
      placements: [{ ...notes, collapsed: true, h: 1, selected: true, filters: { a: 'b' }, version: 'v1.2.0' }, { ...paper, y: 1 }],
    })
    setSubject(store, p.id, { epic: 'one', parts: ['a'], selection: ['gh#1'] })
    keep(store, p.id)
    const text = readFileSync(kehikotFile(dir)!, 'utf8')

    const older = olderHostReads(text)
    expect(older.success).toBe(true)
    if (!older.success) return
    /* Version 2, as it always was: the version is not what the split changed. */
    expect(older.data.version).toBe(2)
    /* What it makes of the personal fields it no longer finds: the whole epic, nothing folded. */
    expect(older.data.epic).toBeNull()
    expect(older.data.selection).toEqual([])
    const read = older.data.kehikot[0]!.containers
    expect(read.map((c) => [c.module, c.x, c.y, c.w, c.h, c.wish, c.collapsed, c.version ?? null])).toEqual([
      ['kehikot.notes', 0, 0, 6, 10, 10, false, 'v1.2.0'],
      ['kehikot.paper', 0, 10, 6, 12, 12, false, null],
    ])
  })

  test('and this host reads what an older host writes', () => {
    const read = parse(serialize([]).replace('"version": 2,', '"version": 2,\n  "epic": "x",\n  "selection": [],'))
    expect(read.ok && read.legacy?.subject.epic).toBe('x')
  })
})
