import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
// @ts-expect-error -- the library's own arithmetic, untyped; used to hold the move to the pixel.
import { calcGridItemPosition } from 'react-grid-layout/build/calculateUtils.js'

import { createCanvas, editCanvas, finerColumns, listCanvases, open as openDb, type Placement } from '../server/canvases.ts'
import { keep, kehikotFile, parse, serialize, syncProject } from '../server/kehikot.ts'
import { projectLayoutsDir, readShelves, saveLayout } from '../server/layouts.ts'
import { addProject, type Project } from '../server/projects.ts'
import { arranged } from '../src/host/columns.ts'
import { GAP_MIN_W, NEW_W, place } from '../src/host/canvases.ts'
import { CANVAS_ROWS, COLUMNS, COLUMNS_BEFORE, MIN_W, wider } from '../src/host/fit.ts'
import { BUILT_IN_LAYOUTS, layoutFileSchema, LAYOUT_VERSION, layoutFromFile, readBuiltInLayouts } from '../src/host/layouts.ts'
import listed from '../modules.json'

/**
 * A canvas was twelve columns wide and is twenty-four (`COLUMNS` in `fit.ts`),
 * and every arrangement anybody made in the old columns has to draw where it
 * drew. The database, the project's `kehikot.json`, a layout file and the
 * published list's layouts each say which columns they count in, are moved
 * once by doubling `x` and `w`, and never twice.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-finer-cols-')))
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

const MARGIN: [number, number] = [8, 8]

describe('the finer columns', () => {
  test('are a whole multiple of the old ones, and the constants are the old ones in them', () => {
    expect(COLUMNS).toBe(24)
    expect(COLUMNS % COLUMNS_BEFORE).toBe(0)
    expect(wider(COLUMNS_BEFORE)).toBe(COLUMNS)
    expect(NEW_W).toBe(wider(6))
    expect(GAP_MIN_W).toBe(wider(4))
    expect(MIN_W).toBe(wider(1))
  })

  /* The grid's arithmetic (`calcGridColWidth`, `calcGridItemPosition` in react-grid-layout's
     calculateUtils): a doubled placement is the same pixels, before the grid rounds each edge. */
  test('draw a doubled placement exactly where the old one drew, at every width', () => {
    const [gap, pad] = [MARGIN[0], MARGIN[0]]
    for (let width = 320; width <= 2600; width += 7) {
      const column = (cols: number) => (width - gap * (cols - 1) - pad * 2) / cols
      const left = (cols: number, x: number) => (column(cols) + gap) * x + pad
      const across = (cols: number, w: number) => column(cols) * w + gap * (w - 1)
      for (const [x, w] of [[0, 12], [0, 1], [3, 5], [11, 1], [6, 6], [7, 5]] as const) {
        expect(Math.abs(left(COLUMNS, wider(x)) - left(COLUMNS_BEFORE, x))).toBeLessThan(1e-9)
        expect(Math.abs(across(COLUMNS, wider(w)) - across(COLUMNS_BEFORE, w))).toBeLessThan(1e-9)
        /* And as the grid itself draws it, rounded: the same pixel, or a tie rounded the other way. */
        const params = (cols: number) => ({ margin: MARGIN, containerPadding: MARGIN, containerWidth: width, cols, rowHeight: 10, maxRows: CANVAS_ROWS })
        const old = calcGridItemPosition(params(COLUMNS_BEFORE), x, 0, w, 4)
        const now = calcGridItemPosition(params(COLUMNS), wider(x), 0, wider(w), 4)
        expect(Math.abs(now.left - old.left)).toBeLessThanOrEqual(1)
        expect(Math.abs(now.width - old.width)).toBeLessThanOrEqual(1)
      }
    }
  })

  test('the narrowest a person can make a container is the narrowest one could be before', () => {
    const width = 360
    const old = calcGridItemPosition({ margin: MARGIN, containerPadding: MARGIN, containerWidth: width, cols: COLUMNS_BEFORE, rowHeight: 10, maxRows: 56 }, 0, 0, 1, 4)
    const now = calcGridItemPosition({ margin: MARGIN, containerPadding: MARGIN, containerWidth: width, cols: COLUMNS, rowHeight: 10, maxRows: 56 }, 0, 0, MIN_W, 4)
    expect(Math.abs(now.width - old.width)).toBeLessThanOrEqual(1)
    expect(now.width).toBeGreaterThan(0)
  })
})

/** As a host before the finer columns writes: every column but `cols`. */
function columnlessDatabase(file: string): void {
  const old = openDb(file)
  old.exec('alter table placements drop column cols')
  old.close()
}

const box = (i: string, x: number, w: number, y = 0, h = 20) => ({ i, x, y, w, h, wish: h })

describe('the database', () => {
  test('a database from before is widened once, exactly, and opening it again moves nothing', () => {
    const file = join(folder(), 'frame.sqlite')
    columnlessDatabase(file)
    const old = new Database(file)
    old.run("insert into canvases (id, name, rank) values (1, 'old', 1)")
    /* As the host before this writes: `rows` named, `cols` not. Three across, in twelfths. */
    old.run(
      "insert into placements (canvas, module, x, y, w, h, wish, rows) values (1, 'a.left', 0, 0, 3, 20, 20, 56), (1, 'a.mid', 3, 0, 5, 36, 36, 56), (1, 'a.right', 8, 0, 4, 56, 56, 56)",
    )
    old.close()

    const first = openDb(file)
    const drawn = listCanvases(first)[0]!.placements.map((p) => [p.i, p.x, p.w, p.y, p.h, p.wish])
    expect(drawn).toEqual([
      ['a.left', 0, 6, 0, 20, 20],
      ['a.mid', 6, 10, 0, 36, 36],
      ['a.right', 16, 8, 0, 56, 56],
    ])
    first.close()

    const second = openDb(file)
    expect(listCanvases(second)[0]!.placements.map((p) => [p.i, p.x, p.w, p.y, p.h, p.wish])).toEqual(drawn)
    finerColumns(second)
    expect(listCanvases(second)[0]!.placements.map((p) => [p.i, p.x, p.w, p.y, p.h, p.wish])).toEqual(drawn)
    second.close()
  })

  test('what this host writes says so, and is never widened', () => {
    const store = openDb(':memory:')
    const canvas = createCanvas(store, 'new', null)
    editCanvas(store, canvas.id, { placements: [box('a.one', 7, 9)] })
    expect(store.query('select cols from placements').all()).toEqual([{ cols: COLUMNS }])
    finerColumns(store)
    expect(listCanvases(store).find((c) => c.id === canvas.id)!.placements[0]).toMatchObject({ x: 7, w: 9 })
  })

  test('a row an older host writes later is widened on the next open, and nothing else is', () => {
    const file = join(folder(), 'frame.sqlite')
    const store = openDb(file)
    const canvas = createCanvas(store, 'mixed', null)
    editCanvas(store, canvas.id, { placements: [box('a.mine', 0, 11)] })
    store.run(`insert into placements (canvas, module, x, y, w, h, wish, rows) values (${canvas.id}, 'a.older', 6, 0, 6, 14, 14, 56)`)
    store.close()

    const again = openDb(file)
    const placements = listCanvases(again).find((c) => c.id === canvas.id)!.placements
    expect(placements.find((p) => p.i === 'a.mine')).toMatchObject({ x: 0, w: 11 })
    expect(placements.find((p) => p.i === 'a.older')).toMatchObject({ x: 12, w: 12, h: 14 })
    again.close()
  })
})

/** A `kehikot.json` as the host before the finer columns wrote it: `rows`, and no `cols`. */
const twelfthsFile = `{
  "version": 2,
  "rows": 56,
  "kehikot": [
    {
      "key": "writing",
      "name": "writing",
      "containers": [
        {"module":"kehikot.claude","x":7,"y":0,"w":5,"h":56,"grow":false,"pinned":false,"prompt":"","promptFor":null,"wish":56,"refreshEvery":null},
        {"module":"kehikot.notes","x":0,"y":0,"w":7,"h":20,"grow":false,"pinned":false,"prompt":"","promptFor":null,"wish":20,"refreshEvery":null},
        {"module":"kehikot.paper","x":0,"y":20,"w":7,"h":36,"grow":false,"pinned":false,"prompt":"","promptFor":null,"wish":36,"refreshEvery":null}
      ]
    }
  ]
}
`

describe('a shared kehikot.json in twelfths', () => {
  function cloned(text = twelfthsFile) {
    const dir = folder()
    mkdirSync(join(dir, '.kehikot', 'host'), { recursive: true })
    writeFileSync(kehikotFile(dir)!, text)
    const store = openDb(':memory:')
    const p = project(store, dir)
    return { dir, store, p }
  }

  test('is read with every x and w doubled, and nothing else changed', () => {
    const { store, p } = cloned()
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: true })
    const placements = listCanvases(store)[0]!.placements
    expect(placements.map((x) => [x.i, x.x, x.w, x.y, x.h, x.wish])).toEqual([
      ['kehikot.claude', 14, 10, 0, 56, 56],
      ['kehikot.notes', 0, 14, 0, 20, 20],
      ['kehikot.paper', 0, 14, 20, 36, 36],
    ])
    expect(arranged(placements)).toEqual(placements)
  })

  test('opening it makes no diff in it, reading it again widens nothing, and the first change writes "cols": 24', () => {
    const { dir, store, p } = cloned()
    syncProject(store, p)
    expect(readFileSync(kehikotFile(dir)!, 'utf8')).toBe(twelfthsFile)
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: false })
    expect(listCanvases(store)[0]!.placements.find((x) => x.i === 'kehikot.claude')).toMatchObject({ x: 14, w: 10 })

    const canvas = listCanvases(store)[0]!
    /* A nuance twelve columns could not say: the notes one column narrower. */
    editCanvas(store, canvas.id, { placements: canvas.placements.map((x) => (x.i === 'kehikot.notes' ? { ...x, w: 13 } : x)) })
    keep(store, p.id)
    const text = readFileSync(kehikotFile(dir)!, 'utf8')
    expect(JSON.parse(text)).toMatchObject({ version: 2, rows: 56, cols: 24 })
    expect(text).toContain('{"module":"kehikot.notes","x":0,"y":0,"w":13,"h":20,')
    expect(text).toContain('{"module":"kehikot.claude","x":14,"y":0,"w":10,"h":56,')

    /* And read back, a file that says `cols` is taken as it is: never doubled twice. */
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: false })
    expect(listCanvases(store)[0]!.placements.find((x) => x.i === 'kehikot.notes')).toMatchObject({ x: 0, w: 13 })
  })

  test('a file that says "cols": 24 is not converted', () => {
    const text = twelfthsFile.replace('"rows": 56,', '"rows": 56,\n  "cols": 24,')
    const read = parse(text)
    expect(read.ok && read.kehikot[0]!.containers.map((c) => [c.module, c.x, c.w])).toEqual([
      ['kehikot.claude', 7, 5],
      ['kehikot.notes', 0, 7],
      ['kehikot.paper', 0, 7],
    ])
  })

  test('"cols": 12 is read as twelfths, the same as no cols', () => {
    const said = parse(twelfthsFile.replace('"rows": 56,', '"rows": 56,\n  "cols": 12,'))
    const absent = parse(twelfthsFile)
    expect(said.ok && said.kehikot).toEqual(absent.ok && absent.kehikot)
  })

  test('a file from before both is doubled down and across', () => {
    const coarse = twelfthsFile.replace('  "rows": 56,\n', '').replaceAll('"h":56', '"h":28').replaceAll('"wish":56', '"wish":28').replaceAll('"h":20', '"h":10').replaceAll('"wish":20', '"wish":10').replace('"y":20', '"y":10').replaceAll('"h":36', '"h":18').replaceAll('"wish":36', '"wish":18')
    const read = parse(coarse)
    expect(read.ok && read.kehikot[0]!.containers.map((c) => [c.module, c.x, c.w, c.y, c.h])).toEqual([
      ['kehikot.claude', 14, 10, 0, 56],
      ['kehikot.notes', 0, 14, 0, 20],
      ['kehikot.paper', 0, 14, 20, 36],
    ])
  })

  test('a file in more columns than this host has is refused in words, and never written over', () => {
    const future = twelfthsFile.replace('"rows": 56,', '"rows": 56,\n  "cols": 48,')
    const { dir, store, p } = cloned(future)
    const synced = syncProject(store, p)
    expect(synced).toMatchObject({ outcome: 'refused' })
    expect(synced.outcome === 'refused' && synced.why).toContain('48 columns, which a newer Kehikot writes')
    keep(store, p.id)
    expect(readFileSync(kehikotFile(dir)!, 'utf8')).toBe(future)
  })

  test('a count that is neither is refused', () => {
    const odd = parse(twelfthsFile.replace('"rows": 56,', '"rows": 56,\n  "cols": 16,'))
    expect(odd.ok).toBe(false)
    expect(!odd.ok && odd.why).toContain('is not 12 or 24')
  })

  test('what this host writes is in twenty-fourths and parses back unchanged', () => {
    const placements: Placement[] = [
      {
        i: 'kehikot.notes', x: 5, y: 0, w: 9, h: 20, grow: false, pinned: false, prompt: '', promptFor: null,
        collapsed: false, wish: 20, selected: false, filters: {}, refreshEvery: null, version: null, scope: null,
      },
    ]
    const text = serialize([{ id: 1, key: 'odd', name: 'odd', project: null, placements, connections: { off: [], only: [] } }])
    expect(text).toContain('"cols": 24,')
    const read = parse(text)
    expect(read.ok && read.kehikot[0]!.containers[0]).toMatchObject({ x: 5, w: 9 })
  })
})

describe('layouts', () => {
  test('the published list keeps its layouts at version 2, in twelfths, so a released app still reads them', () => {
    const raw = listed as unknown as { layouts: { version: number; containers: { x: number; w: number }[] }[] }
    for (const layout of raw.layouts) {
      expect(layout.version).toBe(2)
      for (const c of layout.containers) expect(c.x + c.w).toBeLessThanOrEqual(COLUMNS_BEFORE)
    }
  })

  test('the built-in layouts are the published ones with x and w doubled, and only those', () => {
    const raw = listed as unknown as { layouts: { id: string; containers: { module: string; x: number; y: number; w: number; h: number }[] }[] }
    for (const layout of raw.layouts) {
      const ours = BUILT_IN_LAYOUTS.find((one) => one.id === layout.id)!
      expect(ours.containers.map((c) => [c.module, c.x, c.y, c.w, c.h])).toEqual(layout.containers.map((c) => [c.module, wider(c.x), c.y, wider(c.w), c.h]))
    }
    /* And each still fills the width: some row reaches the last column. */
    for (const layout of BUILT_IN_LAYOUTS) expect(Math.max(...layout.containers.map((c) => c.x + c.w))).toBe(COLUMNS)
  })

  test('a published layout of version 3 is taken in twenty-fourths as it is', () => {
    const read = readBuiltInLayouts({
      layouts: [{ id: 'fine', version: 3, name: 'Fine', summary: '', containers: [{ module: 'kehikot.notes', x: 0, y: 0, w: 9, h: 56 }, { module: 'kehikot.slides', x: 9, y: 0, w: 15, h: 56 }] }],
    })
    expect(read?.[0]!.containers.map((c) => [c.x, c.w])).toEqual([[0, 9], [9, 15]])
  })

  test('a layout of version 1 or 2 that reaches past column twelve is not a layout', () => {
    for (const version of [1, 2] as const) {
      const bad = layoutFileSchema.safeParse({ version, name: 'Wide', containers: [{ module: 'kehikot.notes', x: 10, y: 0, w: 6, h: 20 }] })
      expect(bad.success).toBe(false)
    }
    expect(layoutFileSchema.safeParse({ version: 3, name: 'Wide', containers: [{ module: 'kehikot.notes', x: 10, y: 0, w: 6, h: 20 }] }).success).toBe(true)
  })

  test('layoutFromFile: version 1 doubles both ways, version 2 across only, version 3 not at all', () => {
    const c = { module: 'a.b', x: 3, y: 5, w: 4, h: 7 }
    expect(layoutFromFile({ version: 1, name: 'n', summary: '', containers: [c] }).containers[0]).toMatchObject({ x: 6, w: 8, y: 10, h: 14 })
    expect(layoutFromFile({ version: 2, name: 'n', summary: '', containers: [c] }).containers[0]).toMatchObject({ x: 6, w: 8, y: 5, h: 7 })
    expect(layoutFromFile({ version: 3, name: 'n', summary: '', containers: [c] }).containers[0]).toMatchObject({ x: 3, w: 4, y: 5, h: 7 })
  })

  test('a layout file of version 2 on the shelf is read widened, and one saved now is version 3 and read back as it is', () => {
    const dir = folder()
    const shelf = projectLayoutsDir(dir)!
    mkdirSync(shelf, { recursive: true })
    writeFileSync(join(shelf, 'old.json'), JSON.stringify({ version: 2, name: 'Old', containers: [{ module: 'kehikot.notes', x: 3, y: 4, w: 6, h: 24 }] }))
    const shelves = readShelves(dir)
    expect(shelves.trouble).toEqual([])
    expect(shelves.project[0]!.containers[0]).toMatchObject({ x: 6, w: 12, y: 4, h: 24 })

    const store = openDb(':memory:')
    const p = project(store, dir)
    const canvas = createCanvas(store, 'save me', p.id)
    editCanvas(store, canvas.id, { placements: [{ ...place([], 'kehikot.notes')[0]!, x: 5, w: 9 }] })
    const saved = saveLayout(listCanvases(store).find((c) => c.id === canvas.id)!, dir, { name: 'Odd', where: 'project' })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    const written = JSON.parse(readFileSync(saved.file, 'utf8'))
    expect(LAYOUT_VERSION).toBe(3)
    expect(written.version).toBe(3)
    expect(written.containers[0]).toMatchObject({ x: 5, w: 9 })
    expect(readShelves(dir).project.find((one) => one.id === 'odd')!.containers[0]).toMatchObject({ x: 5, w: 9 })
  })
})

describe('a new module, in the finer columns', () => {
  const at = (i: string, x: number, y: number, w: number, h: number) => ({ ...place([], i)[0]!, x, y, w, h, wish: h })
  const spot = (placements: readonly Placement[], id: string) => {
    const p = placements.find((one) => one.i === id)!
    return { x: p.x, y: p.y, w: p.w, h: p.h }
  }

  test('an empty canvas: top left, half the width', () => {
    expect(spot(place([], 'n'), 'n')).toEqual({ x: 0, y: 0, w: COLUMNS / 2, h: 20 })
  })

  test('a gap only twenty-four columns can say is used at its own width', () => {
    /* Columns 7..16 free for rows 0..56: nine wide, an odd column on each side.
       Twelve columns had no such gap; this one is shaped to it, not rounded. */
    const board = [at('a', 0, 0, 7, 56), at('b', 16, 0, 8, 56)]
    expect(spot(place(board, 'n'), 'n')).toEqual({ x: 7, y: 0, w: 9, h: 20 })
  })

  test('a gap narrower than the least, seven of twenty-four, is not used', () => {
    const board = [at('a', 0, 0, 9, 56), at('b', 16, 0, 8, 56)]
    expect(spot(place(board, 'n'), 'n')).toEqual({ x: 0, y: 56, w: COLUMNS / 2, h: 20 })
  })

  test('beside one at an odd column: the full half-width fits in what is left', () => {
    const board = [at('a', 0, 0, 11, 20)]
    expect(spot(place(board, 'n'), 'n')).toEqual({ x: 11, y: 0, w: 12, h: 20 })
  })
})
