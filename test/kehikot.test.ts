import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import {
  createCanvas,
  editCanvas,
  listCanvases,
  open as openDb,
  type Canvas,
  type Placement,
} from '../server/canvases.ts'
import {
  LOCAL_CANVAS_FIELDS,
  PORTABLE_CANVAS_FIELDS,
  PORTABLE_PLACEMENT_FIELDS,
  keep,
  kehikotFile,
  parse,
  refusal,
  serialize,
  syncEvery,
  syncProject,
} from '../server/kehikot.ts'
import { addProject, type Project } from '../server/projects.ts'

/*
 * A project's kehikot in the project's own folder — the copy that travels.
 *
 * Real directories and real files throughout, for the reason `sharing.test.ts`
 * gives: everything this does is read and write one file in somebody's
 * project, and every interesting case is a fact about that file. The "other
 * computer" is a second, empty database opened on the same folder, which is
 * exactly what a clone plus "add a project" is.
 */

/* Resolved, because `addProject` resolves the folder it is given and the file
   is under the project's path as the project knows it. */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-kehikot-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let made = 0
function folder(): string {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function db(): Database {
  return openDb(':memory:')
}

/** Add a folder as a project, with no kehikko of its own so a test can decide. */
function project(store: Database, dir: string): Project {
  const out = addProject(store, dir, undefined, false)
  if (!out.ok) throw new Error(out.why)
  return out.project
}

/**
 * A placement with EVERY field set to something other than its default.
 *
 * This is the placement the round trip below is measured against. A field
 * left at its default would pass the trip whether or not it travelled, which
 * is exactly the silent failure the test exists to catch.
 */
const everything: Placement = {
  i: 'roadmap.paper',
  x: 3,
  y: 7,
  w: 5,
  h: 21,
  grow: true,
  pinned: true,
  prompt: 'read chapter two and say what is missing',
  promptFor: 'roadmap.notes',
  collapsed: true,
  wish: 30,
  selected: true,
  filters: { scope: 'chapter', kind: 'todo' },
  refreshEvery: 15,
}

const another: Placement = {
  i: 'roadmap.notes',
  x: 0,
  y: 0,
  w: 3,
  h: 12,
  grow: false,
  pinned: false,
  prompt: '',
  promptFor: null,
  collapsed: false,
  wish: 12,
  selected: false,
  filters: {},
  refreshEvery: null,
}

/** What a canvas looks like with everything that is local to one machine taken off. */
function portable(canvas: Canvas) {
  const { id: _id, project: _project, ...rest } = canvas
  return rest
}

describe('every field is on one side of the line', () => {
  /*
   * The single most valuable assertion in this file. `Placement` gains a
   * column; the person adding it has to say whether it travels; if they do not,
   * this fails with the column's name in the diff. The type-level check in
   * `kehikot.ts` catches it at `tsc`; this catches it at `bun run test`, and
   * against the database rather than the type — a column read by
   * `listCanvases` but not on the list is caught here even if the type were
   * edited to match.
   */
  test('a placement out of the database has exactly the portable fields', () => {
    const store = db()
    const p = project(store, folder())
    const made = createCanvas(store, 'one', p.id)
    editCanvas(store, made.id, { placements: [everything] })
    const [read] = listCanvases(store)[0]!.placements
    expect(Object.keys(read!).sort()).toEqual([...PORTABLE_PLACEMENT_FIELDS].sort())
  })

  test('a canvas out of the database has exactly the portable fields, the local ones, and its placements', () => {
    const store = db()
    const p = project(store, folder())
    createCanvas(store, 'one', p.id)
    const [read] = listCanvases(store)
    expect(Object.keys(read!).sort()).toEqual(
      [...PORTABLE_CANVAS_FIELDS, ...LOCAL_CANVAS_FIELDS, 'placements'].sort(),
    )
  })
})

describe('the round trip: this computer, the file, another computer', () => {
  test('a kehikko written here is the same kehikko read from an empty database there, every field included', () => {
    const dir = folder()
    const here = db()
    const p = project(here, dir)
    const writing = createCanvas(here, 'writing', p.id)
    editCanvas(here, writing.id, {
      epic: 'modes-are-modules',
      selection: ['gh#105', '!44'],
      placements: [everything, another],
    })
    const review = createCanvas(here, 'review', p.id)
    editCanvas(here, review.id, { placements: [another] })

    /* Nothing on disk yet. The database is the only record, so it is written. */
    const file = kehikotFile(dir)!
    expect(existsSync(file)).toBe(false)
    expect(syncProject(here, p)).toEqual({ file, outcome: 'written' })
    expect(existsSync(file)).toBe(true)

    /* The other computer: an empty database, the same folder cloned. */
    const there = db()
    const q = project(there, dir)
    expect(there.query('select count(*) as n from canvases').get()).toEqual({ n: 0 })
    expect(syncProject(there, q)).toEqual({ file, outcome: 'read', changed: true })

    const before = listCanvases(here).map(portable)
    const after = listCanvases(there).map(portable)
    expect(after).toEqual(before)
    /* And the field that mattered most, spelled out, so a failure names it. */
    expect(after[0]!.placements.find((x) => x.i === 'roadmap.paper')).toEqual(everything)
    /* The keys are what matched them, and they are the same on both sides. */
    expect(after.map((c) => c.key)).toEqual(before.map((c) => c.key))
    /* The ids are not — they are this machine's row numbers and nothing more. */
    expect(listCanvases(there).map((c) => c.project)).toEqual([q.id, q.id])
  })

  test('the file is one a person can read, diff and merge', () => {
    const dir = folder()
    const store = db()
    const p = project(store, dir)
    const made = createCanvas(store, 'writing', p.id, 'writing')
    editCanvas(store, made.id, { epic: 'modes-are-modules', placements: [everything, another] })
    keep(store, p.id)

    const text = readFileSync(kehikotFile(dir)!, 'utf8')
    expect(text).toBe(`{
  "version": 1,
  "kehikot": [
    {
      "key": "writing",
      "name": "writing",
      "epic": "modes-are-modules",
      "selection": [],
      "containers": [
        {"module":"roadmap.notes","x":0,"y":0,"w":3,"h":12,"grow":false,"pinned":false,"prompt":"","promptFor":null,"collapsed":false,"wish":12,"selected":false,"filters":{},"refreshEvery":null},
        {"module":"roadmap.paper","x":3,"y":7,"w":5,"h":21,"grow":true,"pinned":true,"prompt":"read chapter two and say what is missing","promptFor":"roadmap.notes","collapsed":true,"wish":30,"selected":true,"filters":{"scope":"chapter","kind":"todo"},"refreshEvery":15}
      ]
    }
  ]
}
`)
    /* A move is one changed line, because a container is one line and the
       lines are in module order rather than in the order things were dragged. */
    editCanvas(store, made.id, { placements: [{ ...everything, x: 4 }, another] })
    keep(store, p.id)
    const moved = readFileSync(kehikotFile(dir)!, 'utf8')
    const differing = text.split('\n').filter((line, i) => moved.split('\n')[i] !== line)
    expect(differing).toHaveLength(1)
    expect(differing[0]).toContain('"module":"roadmap.paper","x":3')
  })

  test('the same kehikot serialise to the same bytes, whatever order the database answered in', () => {
    const [a, b] = listCanvasesOf(everything, another)
    expect(serialize([a!, b!])).toBe(serialize([a!, b!]))
    expect(serialize([a!])).not.toBe(serialize([b!]))
  })

  test('two kehikot with the same name in one project stay two kehikot on the other computer', () => {
    const dir = folder()
    const here = db()
    const p = project(here, dir)
    const first = createCanvas(here, 'writing', p.id)
    const second = createCanvas(here, 'writing', p.id)
    editCanvas(here, first.id, { placements: [everything] })
    editCanvas(here, second.id, { placements: [another] })
    expect(first.key).not.toBe(second.key)
    syncProject(here, p)

    const there = db()
    syncProject(there, project(there, dir))
    const arrived = listCanvases(there)
    expect(arrived.map((c) => c.name)).toEqual(['writing', 'writing'])
    expect(arrived.map((c) => c.placements.map((x) => x.i))).toEqual([['roadmap.paper'], ['roadmap.notes']])
  })

  test('the order of the kehikot is the order in the file', () => {
    const dir = folder()
    const here = db()
    const p = project(here, dir)
    createCanvas(here, 'first', p.id, 'first')
    createCanvas(here, 'second', p.id, 'second')
    createCanvas(here, 'third', p.id, 'third')
    syncProject(here, p)

    /* The other computer made them in another order — say, `third` was made
       there before the file arrived — and the file still says which order. */
    const there = db()
    const q = project(there, dir)
    createCanvas(there, 'third', q.id, 'third')
    syncProject(there, q)
    expect(listCanvases(there).map((c) => c.key)).toEqual(['first', 'second', 'third'])
  })
})

describe('a module this computer does not have', () => {
  test('its container survives the read, and survives being written back', () => {
    const dir = folder()
    const file = kehikotFile(dir)!
    mkdirSync(join(dir, '.kehikot', 'kehikko'), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        kehikot: [
          {
            key: 'writing',
            name: 'writing',
            epic: null,
            selection: [],
            containers: [
              { module: 'roadmap.paper', x: 0, y: 0, w: 6, h: 20 },
              { module: 'roadmap.notes', x: 6, y: 0, w: 6, h: 20 },
            ],
          },
        ],
      }),
    )

    /* This machine has never heard of roadmap.paper. Nothing here knows or
       asks what is registered, and that is the point: the file says what is
       on the kehikko, and the registry says what this computer can show. */
    const store = db()
    const p = project(store, dir)
    expect(syncProject(store, p).outcome).toBe('read')
    const [canvas] = listCanvases(store)
    expect(canvas!.placements.map((x) => x.i)).toEqual(['roadmap.notes', 'roadmap.paper'])

    /* A person moves the container they CAN see, and the page writes the
       arrangement back — with every container in it, because the page no
       longer takes off what it cannot show. The file must still name paper. */
    editCanvas(store, canvas!.id, {
      placements: canvas!.placements.map((x) => (x.i === 'roadmap.notes' ? { ...x, x: 3 } : x)),
    })
    keep(store, p.id)
    const written = parse(readFileSync(file, 'utf8'))
    expect(written.ok && written.kehikot[0]!.containers.map((c) => c.module)).toEqual([
      'roadmap.notes',
      'roadmap.paper',
    ])
  })
})

describe('a file that will not read', () => {
  test('is a sentence, and the database and the file are both left alone until it is fixed', () => {
    const dir = folder()
    const store = db()
    const p = project(store, dir)
    const made = createCanvas(store, 'writing', p.id, 'writing')
    editCanvas(store, made.id, { placements: [everything] })
    syncProject(store, p)
    const file = kehikotFile(dir)!
    const good = readFileSync(file, 'utf8')

    /* A merge conflict left in it, which is the most likely way this happens. */
    const broken = `<<<<<<< HEAD\n${good}=======\n${good}>>>>>>> theirs\n`
    writeFileSync(file, broken)

    const synced = syncProject(store, p)
    expect(synced.outcome).toBe('refused')
    expect(synced.outcome === 'refused' && synced.why).toMatch(/not JSON/)
    expect(refusal(dir)).toMatch(/not JSON/)
    /* The database still has the kehikko, untouched. */
    expect(listCanvases(store)[0]!.placements).toEqual([everything])

    /* A change is made meanwhile; the file is NOT written over. */
    editCanvas(store, made.id, { placements: [another] })
    keep(store, p.id)
    expect(readFileSync(file, 'utf8')).toBe(broken)

    /* And every load says so, in words that name the file and what to expect. */
    const trouble = syncEvery(store)
    expect(trouble).toHaveLength(1)
    expect(trouble[0]).toContain(file)
    expect(trouble[0]).toContain('the file wins')

    /* Fixed by hand: the file reads, the file wins, the change made meanwhile
       is gone — which is what the sentence said would happen. */
    writeFileSync(file, good)
    expect(syncProject(store, p)).toEqual({ file, outcome: 'read', changed: true })
    expect(refusal(dir)).toBeNull()
    expect(listCanvases(store)[0]!.placements).toEqual([everything])
  })

  test('each kind of fault is named in a sentence rather than thrown', () => {
    expect(parse('{')).toMatchObject({ ok: false })
    expect(parse('[]')).toMatchObject({ ok: false })
    expect(parse('{"version": 2, "kehikot": []}')).toMatchObject({ ok: false })
    const unknown = parse(
      JSON.stringify({ version: 1, kehikot: [{ key: 'a1', name: 'a', containers: [{ module: 'x.y', x: 0, y: 0, w: 1, h: 1, tint: 'red' }] }] }),
    )
    expect(unknown.ok).toBe(false)
    expect(!unknown.ok && unknown.why).toContain('tint')
    expect(!unknown.ok && unknown.why).toContain('newer')

    const badKey = parse(JSON.stringify({ version: 1, kehikot: [{ key: 'Not A Key', name: 'a' }] }))
    expect(!badKey.ok && badKey.why).toContain('kehikot.0.key')

    const twice = parse(
      JSON.stringify({ version: 1, kehikot: [{ key: 'same', name: 'a' }, { key: 'same', name: 'b' }] }),
    )
    expect(!twice.ok && twice.why).toContain('share the key "same"')

    const doubled = parse(
      JSON.stringify({
        version: 1,
        kehikot: [{ key: 'a', name: 'a', containers: [{ module: 'x.y', x: 0, y: 0, w: 1, h: 1 }, { module: 'x.y', x: 1, y: 0, w: 1, h: 1 }] }],
      }),
    )
    expect(!doubled.ok && doubled.why).toContain('two containers for x.y')
  })

  test('a hand-written kehikko needs only a key, a name, and rectangles', () => {
    const read = parse(
      JSON.stringify({
        version: 1,
        kehikot: [{ key: 'review', name: 'Review', containers: [{ module: 'roadmap.paper', x: 0, y: 0, w: 12, h: 30 }] }],
      }),
    )
    expect(read.ok).toBe(true)
    /* Every field this host knows, defaulted — the same defaults a page gives a
       container it has just placed. */
    expect(read.ok && read.kehikot[0]!.containers[0]).toEqual({
      module: 'roadmap.paper',
      x: 0,
      y: 0,
      w: 12,
      h: 30,
      grow: false,
      pinned: false,
      prompt: '',
      promptFor: null,
      collapsed: false,
      /* Not yet the height: a `null` here is "the height it has", and it is
         `cleaned` in `server/canvases.ts` that says so, once, on the way into
         the database — see `fromContainer`. */
      wish: null,
      selected: false,
      filters: {},
      refreshEvery: null,
    })
    expect(read.ok && read.kehikot[0]).toMatchObject({ epic: null, selection: [] })
  })

  /*
   * The files in the user's projects today were written by a host that said
   * `openH` — the height a folded container had — and no wish for an open one.
   * They have to read, and the arrangement in them has to come out the same:
   * the folded container wishing for what it remembered, the open one for
   * what it draws. A file this host writes says `wish`; `openH` is read and
   * never written again.
   */
  test('a file from before wishes reads, and its containers wish for what they had', () => {
    const dir = folder()
    const store = db()
    const p = project(store, dir)
    mkdirSync(join(dir, '.kehikot', 'kehikko'), { recursive: true })
    writeFileSync(
      kehikotFile(dir)!,
      `{
  "version": 1,
  "kehikot": [
    {
      "key": "old",
      "name": "old",
      "epic": null,
      "selection": [],
      "containers": [
        {"module":"roadmap.notes","x":0,"y":0,"w":6,"h":12,"grow":false,"pinned":false,"prompt":"","promptFor":null,"collapsed":false,"openH":null,"selected":false,"filters":{},"refreshEvery":null},
        {"module":"roadmap.paper","x":0,"y":12,"w":6,"h":1,"grow":false,"pinned":false,"prompt":"","promptFor":null,"collapsed":true,"openH":14,"selected":false,"filters":{},"refreshEvery":null}
      ]
    }
  ]
}
`,
    )
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read' })
    const placements = listCanvases(store)[0]!.placements
    expect(placements.find((x) => x.i === 'roadmap.notes')).toMatchObject({ h: 12, collapsed: false, wish: 12 })
    expect(placements.find((x) => x.i === 'roadmap.paper')).toMatchObject({ h: 1, collapsed: true, wish: 14 })

    /* And once written back, the file says `wish` and not `openH`. */
    keep(store, p.id)
    const text = readFileSync(kehikotFile(dir)!, 'utf8')
    expect(text).toContain('"wish":14')
    expect(text).not.toContain('openH')
  })
})

describe('the file is the record', () => {
  test('a kehikko the file does not list stops being one here', () => {
    const dir = folder()
    const here = db()
    const p = project(here, dir)
    createCanvas(here, 'kept', p.id, 'kept')
    syncProject(here, p)

    /* On the other machine there is one more, made before the file arrived —
       or made after, and then deleted on the first machine and pulled. */
    const there = db()
    const q = project(there, dir)
    createCanvas(there, 'stale', q.id, 'stale')
    expect(syncProject(there, q)).toMatchObject({ outcome: 'read', changed: true })
    expect(listCanvases(there).map((c) => c.key)).toEqual(['kept'])
  })

  test('a deleted file is written again from the database, because the cache is then the only record', () => {
    const dir = folder()
    const store = db()
    const p = project(store, dir)
    createCanvas(store, 'writing', p.id, 'writing')
    syncProject(store, p)
    const file = kehikotFile(dir)!
    rmSync(file)
    expect(syncProject(store, p)).toEqual({ file, outcome: 'written' })
    expect(parse(readFileSync(file, 'utf8'))).toMatchObject({ ok: true, kehikot: [{ key: 'writing' }] })
  })

  test('reading a file that already agrees changes nothing', () => {
    const dir = folder()
    const store = db()
    const p = project(store, dir)
    const made = createCanvas(store, 'writing', p.id)
    editCanvas(store, made.id, { placements: [everything, another] })
    syncProject(store, p)
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: false })
  })

  test('a project with nothing on either side is left with nothing, for ensureCanvases to fill', () => {
    const dir = folder()
    const store = db()
    const p = project(store, dir)
    expect(syncProject(store, p)).toEqual({ file: kehikotFile(dir)!, outcome: 'nothing' })
    expect(existsSync(kehikotFile(dir)!)).toBe(false)
  })

  test('a value the database bounds is bounded on the way in, as it would be from a page', () => {
    const dir = folder()
    mkdirSync(join(dir, '.kehikot', 'kehikko'), { recursive: true })
    writeFileSync(
      kehikotFile(dir)!,
      JSON.stringify({
        version: 1,
        kehikot: [{ key: 'wide', name: 'wide', containers: [{ module: 'x.y', x: 0, y: 0, w: 1, h: 9000, refreshEvery: 0 }] }],
      }),
    )
    const store = db()
    syncProject(store, project(store, dir))
    expect(listCanvases(store)[0]!.placements[0]).toMatchObject({ h: 400, refreshEvery: null })
  })
})

/** Two canvases in a throwaway database, for the serialiser. */
function listCanvasesOf(...placements: Placement[]): Canvas[] {
  const store = db()
  const p = project(store, folder())
  for (const placement of placements) {
    const made = createCanvas(store, placement.i, p.id, placement.i.replace(/[^a-z0-9]/g, '-'))
    editCanvas(store, made.id, { placements: [placement] })
  }
  return listCanvases(store)
}
