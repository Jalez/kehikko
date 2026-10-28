import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { createCanvas, editCanvas, finerRows, listCanvases, open as openDb, type Placement } from '../server/canvases.ts'
import { keep, kehikotFile, parse, serialize, syncProject } from '../server/kehikot.ts'
import { projectLayoutsDir, readShelves, saveLayout } from '../server/layouts.ts'
import { addProject, type Project } from '../server/projects.ts'
import { FOLDED_ROWS, SQUEEZED_ROWS, arranged } from '../src/host/columns.ts'
import { GAP_MIN_H, NEW_H, place } from '../src/host/canvases.ts'
import { CANVAS_ROWS, finer, ROWS_BEFORE } from '../src/host/fit.ts'
import { BUILT_IN_LAYOUTS, LAYOUT_VERSION, layoutFromFile } from '../src/host/layouts.ts'

/**
 * A canvas was twenty-eight rows tall and is fifty-six (`fit.ts`), and every
 * arrangement anybody made in the old rows has to draw where it drew. Three
 * places hold one: this machine's database, the project's `kehikot.json`, and
 * a layout file. Each is moved once, by doubling `y`, `h` and `wish`, and
 * never twice.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-finer-')))
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

/** A database as a host from before the finer rows left it: every column but `rows`. */
function oldDatabase(file: string): void {
  const old = openDb(file)
  old.exec('alter table placements drop column rows')
  old.close()
}

const at = (i: string, y: number, h: number, wish = h, collapsed = false) =>
  ({ i, x: 0, y, w: 6, h, wish, collapsed })

describe('the database', () => {
  test('a database from before is doubled once, and opening it again moves nothing', () => {
    const file = join(folder(), 'frame.sqlite')
    oldDatabase(file)
    const old = new Database(file)
    old.run("insert into canvases (id, name, rank) values (1, 'old', 1)")
    /* As an older host writes: no `rows` column at all. Notes over a folded paper. */
    old.run(
      "insert into placements (canvas, module, x, y, w, h, wish, collapsed) values (1, 'a.notes', 0, 0, 6, 18, 18, 0), (1, 'a.paper', 0, 18, 6, 1, 10, 1)",
    )
    old.close()

    const first = openDb(file)
    const drawn = listCanvases(first)[0]!.placements.map((p) => [p.i, p.y, p.h, p.wish, p.collapsed])
    expect(drawn).toEqual([
      ['a.notes', 0, 36, 36, false],
      ['a.paper', 36, FOLDED_ROWS, 20, true],
    ])
    first.close()

    const second = openDb(file)
    expect(listCanvases(second)[0]!.placements.map((p) => [p.i, p.y, p.h, p.wish, p.collapsed])).toEqual(drawn)
    /* And running the step itself again is a no-op. */
    finerRows(second)
    expect(listCanvases(second)[0]!.placements.map((p) => [p.i, p.y, p.h, p.wish, p.collapsed])).toEqual(drawn)
    second.close()
  })

  test('what this host writes says so, and is never doubled', () => {
    const store = openDb(':memory:')
    const canvas = createCanvas(store, 'new', null)
    editCanvas(store, canvas.id, { placements: [at('a.one', 0, 20)] })
    expect(store.query('select rows from placements').all()).toEqual([{ rows: CANVAS_ROWS }])
    finerRows(store)
    expect(listCanvases(store).find((c) => c.id === canvas.id)!.placements[0]).toMatchObject({ y: 0, h: 20, wish: 20 })
  })

  /* The app downgraded for an afternoon: the older host writes into the
     migrated database without naming `rows`, gets its default, and only what
     it wrote is moved on the next open. */
  test('a row an older host writes later is doubled on the next open, and nothing else is', () => {
    const file = join(folder(), 'frame.sqlite')
    const store = openDb(file)
    const canvas = createCanvas(store, 'mixed', null)
    editCanvas(store, canvas.id, { placements: [at('a.mine', 0, 20)] })
    store.run(`insert into placements (canvas, module, x, y, w, h, wish) values (${canvas.id}, 'a.older', 6, 0, 6, 14, 14)`)
    store.close()

    const again = openDb(file)
    const placements = listCanvases(again).find((c) => c.id === canvas.id)!.placements
    expect(placements.find((p) => p.i === 'a.mine')).toMatchObject({ y: 0, h: 20, wish: 20 })
    expect(placements.find((p) => p.i === 'a.older')).toMatchObject({ y: 0, h: 28, wish: 28 })
    again.close()
  })
})

/** A `kehikot.json` as a host before the finer rows wrote it: in module order, as every host writes. */
const coarseFile = `{
  "version": 2,
  "kehikot": [
    {
      "key": "writing",
      "name": "writing",
      "containers": [
        {"module":"kehikot.claude","x":6,"y":0,"w":6,"h":28,"grow":false,"pinned":false,"prompt":"","promptFor":null,"wish":28,"refreshEvery":null},
        {"module":"kehikot.notes","x":0,"y":0,"w":6,"h":10,"grow":false,"pinned":false,"prompt":"","promptFor":null,"wish":10,"refreshEvery":null},
        {"module":"kehikot.paper","x":0,"y":10,"w":6,"h":18,"grow":false,"pinned":false,"prompt":"","promptFor":null,"wish":18,"refreshEvery":null}
      ]
    }
  ]
}
`

describe('a shared kehikot.json from an older project', () => {
  function cloned() {
    const dir = folder()
    mkdirSync(join(dir, '.kehikot', 'host'), { recursive: true })
    writeFileSync(kehikotFile(dir)!, coarseFile)
    const store = openDb(':memory:')
    const p = project(store, dir)
    return { dir, store, p }
  }

  test('is read in the finer rows: every container where it drew, the canvas exactly full', () => {
    const { store, p } = cloned()
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: true })
    const placements = listCanvases(store)[0]!.placements
    expect(placements.map((x) => [x.i, x.y, x.h, x.wish])).toEqual([
      ['kehikot.claude', 0, 56, 56],
      ['kehikot.notes', 0, 20, 20],
      ['kehikot.paper', 20, 36, 36],
    ])
    /* And the column rule agrees: nothing is squeezed, nothing moves. */
    expect(arranged(placements)).toEqual(placements)
  })

  test('opening it makes no diff in it, reading it again changes nothing, and the first change writes it in fifty-sixths', () => {
    const { dir, store, p } = cloned()
    syncProject(store, p)
    expect(readFileSync(kehikotFile(dir)!, 'utf8')).toBe(coarseFile)
    /* Read again — the database already in the finer rows, the file still in
       the old ones — and nothing is doubled twice. */
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: false })
    expect(listCanvases(store)[0]!.placements.find((x) => x.i === 'kehikot.paper')).toMatchObject({ y: 20, h: 36 })

    /* A change: written in fifty-sixths, saying so. */
    const canvas = listCanvases(store)[0]!
    editCanvas(store, canvas.id, {
      placements: canvas.placements.map((x) => (x.i === 'kehikot.notes' ? { ...x, h: 21, wish: 21 } : x)),
    })
    keep(store, p.id)
    const text = readFileSync(kehikotFile(dir)!, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ version: 2, rows: 56 })
    expect(text).toContain('{"module":"kehikot.notes","x":0,"y":0,"w":6,"h":21,')
    expect(text).toContain('{"module":"kehikot.claude","x":6,"y":0,"w":6,"h":56,')

    /* And read back, a file in fifty-sixths is taken as it is. */
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: false })
    expect(listCanvases(store)[0]!.placements.find((x) => x.i === 'kehikot.notes')).toMatchObject({ h: 21, wish: 21 })
  })

  test('a database from before and a file from before agree once both are moved', () => {
    const dir = folder()
    mkdirSync(join(dir, '.kehikot', 'host'), { recursive: true })
    writeFileSync(kehikotFile(dir)!, coarseFile)
    const file = join(dir, 'frame.sqlite')
    const store = openDb(file)
    const p = project(store, dir)
    syncProject(store, p)
    /* Now pretend this database was the old host's all along: back to
       twenty-eighths, unmarked. */
    store.run('update placements set y = y / 2, h = h / 2, wish = wish / 2')
    store.exec('alter table placements drop column rows')
    store.close()

    const now = openDb(file)
    const before = listCanvases(now)[0]!.placements.map((x) => [x.i, x.y, x.h])
    expect(syncProject(now, { id: p.id, path: dir })).toMatchObject({ outcome: 'read', changed: false })
    expect(listCanvases(now)[0]!.placements.map((x) => [x.i, x.y, x.h])).toEqual(before)
    expect(before).toContainEqual(['kehikot.paper', 20, 36])
    now.close()
  })

  test('a file from a newer host is refused in words, and never written over', () => {
    const dir = folder()
    mkdirSync(join(dir, '.kehikot', 'host'), { recursive: true })
    const future = coarseFile.replace('"version": 2,', '"version": 2,\n  "rows": 112,')
    writeFileSync(kehikotFile(dir)!, future)
    const store = openDb(':memory:')
    const p = project(store, dir)
    const synced = syncProject(store, p)
    expect(synced).toMatchObject({ outcome: 'refused' })
    expect(synced.outcome === 'refused' && synced.why).toContain('newer Kehikot')
    keep(store, p.id)
    expect(readFileSync(kehikotFile(dir)!, 'utf8')).toBe(future)
  })

  test('what this host writes is in fifty-sixths and parses back unchanged', () => {
    const placements: Placement[] = [
      {
        i: 'kehikot.notes', x: 0, y: 3, w: 6, h: 33, grow: false, pinned: false, prompt: '', promptFor: null,
        collapsed: false, wish: 33, selected: false, filters: {}, refreshEvery: null, version: null, scope: null,
      },
    ]
    const text = serialize([{ id: 1, key: 'odd', name: 'odd', project: null, placements, connections: { off: [], only: [] } }])
    const read = parse(text)
    expect(read.ok && read.kehikot[0]!.containers[0]).toMatchObject({ y: 3, h: 33, wish: 33 })
  })
})

describe('a layout file', () => {
  test('of version 1 is read in the finer rows, and one saved now is version 2', () => {
    const dir = folder()
    const shelf = projectLayoutsDir(dir)!
    mkdirSync(shelf, { recursive: true })
    writeFileSync(
      join(shelf, 'old.json'),
      JSON.stringify({ version: 1, name: 'Old', containers: [{ module: 'kehikot.notes', x: 0, y: 4, w: 6, h: 24 }] }),
    )
    const shelves = readShelves(dir)
    expect(shelves.trouble).toEqual([])
    expect(shelves.project[0]!.containers[0]).toMatchObject({ y: 8, h: 48 })

    const store = openDb(':memory:')
    const p = project(store, dir)
    const canvas = createCanvas(store, 'save me', p.id)
    editCanvas(store, canvas.id, { placements: [{ ...place([], 'kehikot.notes')[0]!, y: 0, h: 33, wish: 33 }] })
    const saved = saveLayout(listCanvases(store).find((c) => c.id === canvas.id)!, dir, { name: 'Odd', where: 'project' })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const written = JSON.parse(readFileSync(saved.file, 'utf8'))
    expect(written.version).toBe(LAYOUT_VERSION)
    expect(written.containers[0]).toMatchObject({ y: 0, h: 33 })
    /* And read back, not doubled. */
    expect(readShelves(dir).project.find((one) => one.id === 'odd')!.containers[0]).toMatchObject({ y: 0, h: 33 })
  })

  test('layoutFromFile leaves a current file alone', () => {
    const file = { version: LAYOUT_VERSION, name: 'n', summary: '', containers: [{ module: 'a.b', x: 0, y: 1, w: 1, h: 3 }] } as const
    expect(layoutFromFile({ ...file, containers: [...file.containers] })).toEqual({ ...file, containers: [...file.containers] })
  })
})

describe('what is counted in rows doubled with them', () => {
  test('the constants are the old ones, in the finer rows', () => {
    expect(CANVAS_ROWS).toBe(finer(ROWS_BEFORE))
    expect(FOLDED_ROWS).toBe(finer(1))
    expect(SQUEEZED_ROWS).toBe(finer(3))
    expect(NEW_H).toBe(finer(10))
    expect(GAP_MIN_H).toBe(finer(6))
  })

  test('a new container on an empty kehikko is half the width and twenty of the rows', () => {
    expect(place([], 'a.one')[0]).toMatchObject({ x: 0, y: 0, w: 6, h: NEW_H, wish: NEW_H })
  })

  /* Every built-in layout fills the canvas to the bottom in at least one
     column, and none passes it — the shape they had in twenty-eighths. */
  test('every built-in layout reaches the bottom and stops there', () => {
    for (const layout of BUILT_IN_LAYOUTS) {
      const bottom = Math.max(...layout.containers.map((c) => c.y + c.h))
      expect(bottom).toBe(CANVAS_ROWS)
    }
  })
})
