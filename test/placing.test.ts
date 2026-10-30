import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, listCanvases, open, type Placement } from '../server/canvases.ts'
import { kehikotFile, parse, serialize } from '../server/kehikot.ts'
import { call, type Door, type Sighting } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { Wakes } from '../server/wake.ts'
import { granted, SQUEEZED_ROWS, tops } from '../src/host/columns.ts'
import { CANVAS_ROWS, COLUMNS } from '../src/host/fit.ts'

/*
 * `place_modules`: an agent putting containers on a kehikko.
 *
 * What is tested is the half of the essay in `mcp.ts` that can be checked
 * without eyes: that a placed container lands where the page's own `+` would
 * put it, inside the budget and over nothing; that nobody else's rectangle
 * changes, drawn or stored; that the file in the project and the database say
 * the same thing afterwards; and that the three things the tool refuses or
 * declines — a module this computer has not registered, one that is already
 * on, and one there is no room for without squeezing somebody — are refused
 * or declined with a sentence and nothing written.
 */

let db: Database
let openness: Openness
let wakes: Wakes
let woken: number[]
let seen: Sighting[]
let folder: string

const door = (): Door => ({
  db,
  which: () => openness.open(),
  wake: (kehikko) => {
    woken.push(kehikko)
    wakes.woke(kehikko)
  },
  epicsChanged: () => {},
  dispositionsChanged: () => {},
  seen: async () => seen,
})

beforeEach(() => {
  db = open(':memory:')
  openness = new Openness()
  wakes = new Wakes()
  woken = []
  seen = [
    { id: 'a.one', name: 'One', condition: 'ready' },
    { id: 'a.two', name: 'Two', condition: 'ready' },
    { id: 'a.three', name: 'Three', condition: 'silent' },
    { id: 'a.four', name: 'Four', condition: 'ready' },
  ]
  folder = mkdtempSync(join(tmpdir(), 'kehikko-placing-'))
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

/** A box as the page's `place` would have stored it: drawn and wished alike. */
const box = (i: string, x: number, y: number, w: number, h: number): Partial<Placement> & { i: string } =>
  ({ i, x, y, w, h, wish: h }) as Partial<Placement> & { i: string }

/** A kehikko in a project folder, with the given containers on it. */
function aCanvas(placements: (Partial<Placement> & { i: string })[]): number {
  const added = addProject(db, folder, 'a project')
  if (!added.ok) throw new Error(added.why)
  const made = createCanvas(db, 'the wire', added.project.id)
  editCanvas(db, made.id, { placements: placements as Placement[] })
  return made.id
}

const canvasNow = (id: number) => listCanvases(db).find((c) => c.id === id)!

/** Whether two stored rectangles overlap. */
const overlaps = (a: Placement, b: Placement) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Every stored rectangle inside the budget and over nothing. */
function legal(placements: readonly Placement[]) {
  for (const p of placements) {
    expect(p.y + p.h).toBeLessThanOrEqual(CANVAS_ROWS)
    expect(p.x + p.w).toBeLessThanOrEqual(COLUMNS)
    for (const q of placements) if (p !== q) expect(overlaps(p, q)).toBe(false)
  }
  /* And drawn, which is what a person sees — `granted` and `tops` are what the
     page draws from. */
  const heights = granted(placements)
  const above = tops(placements)
  for (const p of placements) {
    expect(above.get(p.i)! + heights.get(p.i)!).toBeLessThanOrEqual(CANVAS_ROWS)
  }
}

/** The project's file and the database, read back, agree. */
function recordAgrees() {
  const file = kehikotFile(folder)!
  const read = parse(readFileSync(file, 'utf8'))
  if (!read.ok) throw new Error(read.why)
  expect(readFileSync(file, 'utf8')).toBe(serialize(listCanvases(db)))
  return read.kehikot
}

describe('what the person does meanwhile', () => {
  test('a change landed while the modules are being looked at is not overwritten', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20), box('a.two', 12, 0, 12, 20), box('a.three', 0, 20, 12, 16)])
    let looked!: (sightings: Sighting[]) => void
    const looking = new Promise<Sighting[]>((resolve) => {
      looked = resolve
    })
    const slow: Door = { ...door(), seen: () => looking }

    const answering = call('place_modules', { kehikko: id, modules: ['a.four'] }, slow)
    /* The person, while the sweep is out: one container dragged and resized,
       another taken off. */
    editCanvas(db, id, {
      placements: canvasNow(id)
        .placements.filter((p) => p.i !== 'a.three')
        .map((p) => (p.i === 'a.two' ? { ...p, x: 16, w: 8, h: 28, wish: 28 } : p)),
    })
    const theirs = canvasNow(id).placements
    looked(seen)
    const done = await answering

    expect(done.failed).toBe(false)
    const now = canvasNow(id).placements
    expect(now.filter((p) => p.i !== 'a.four')).toEqual(theirs)
    expect(now.some((p) => p.i === 'a.four')).toBe(true)
    legal(now)
  })
})

describe('where a placed container lands', () => {
  test('beside the last one when the bottom row has room, exactly where the page’s + would put it', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20)])
    const done = await call('place_modules', { kehikko: id, modules: ['a.two'] }, door())
    expect(done.failed).toBe(false)
    const after = canvasNow(id).placements
    expect(after.find((p) => p.i === 'a.two')).toMatchObject({ x: 12, y: 0, w: 12, h: 20, wish: 20 })
    legal(after)
    expect(done.text).toContain('a.two at column 12, row 0, 12 wide and 20 tall')
    /* In the units of now, said so: twenty-four columns. */
    expect(done.text).toContain(`of ${COLUMNS} columns and ${CANVAS_ROWS} rows`)
    expect(COLUMNS).toBe(24)
    expect(done.text).toContain('Nothing else was moved')
  })

  test('on a new row under everything when the bottom row is full', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20), box('a.two', 12, 0, 12, 20)])
    const done = await call('place_modules', { kehikko: id, modules: ['a.three'] }, door())
    expect(done.failed).toBe(false)
    const after = canvasNow(id).placements
    expect(after.find((p) => p.i === 'a.three')).toMatchObject({ x: 0, y: 20, w: 12, h: 20 })
    legal(after)
  })

  test('several at once, each landing after the one before, in the order given', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20)])
    const done = await call('place_modules', { kehikko: id, modules: ['a.two', 'a.three', 'a.four'] }, door())
    expect(done.failed).toBe(false)
    const after = canvasNow(id).placements
    expect(after.find((p) => p.i === 'a.two')).toMatchObject({ x: 12, y: 0 })
    expect(after.find((p) => p.i === 'a.three')).toMatchObject({ x: 0, y: 20 })
    expect(after.find((p) => p.i === 'a.four')).toMatchObject({ x: 12, y: 20 })
    legal(after)
  })

  test('nobody else’s rectangle changes — stored or drawn', async () => {
    const id = aCanvas([box('a.one', 0, 0, 24, 16), box('a.two', 0, 16, 8, 24)])
    const before = canvasNow(id).placements
    const drawnBefore = granted(before)
    const done = await call('place_modules', { kehikko: id, modules: ['a.three'] }, door())
    expect(done.failed).toBe(false)
    const after = canvasNow(id).placements
    for (const p of before) expect(after.find((q) => q.i === p.i)).toEqual(p)
    const drawnAfter = granted(after)
    for (const p of before) expect(drawnAfter.get(p.i)).toBe(drawnBefore.get(p.i))
    legal(after)
  })

  test('its height is cut to what the column grants when the wish would not fit whole', async () => {
    /* A full-width container forty rows tall; the new one goes under it, in
       the sixteen rows left: a shaped gap, so it asks for sixteen (its wish is the
       gap's height, not the twenty it would have had, because a wish over the gap
       would push whatever is under the gap down). */
    const id = aCanvas([box('a.one', 0, 0, 24, 40)])
    const done = await call('place_modules', { kehikko: id, modules: ['a.two'] }, door())
    expect(done.failed).toBe(false)
    const it = canvasNow(id).placements.find((p) => p.i === 'a.two')!
    expect(it).toMatchObject({ x: 0, y: 40, h: 16, wish: 16 })
    legal(canvasNow(id).placements)
  })

  test('the first container on an empty kehikko goes top left', async () => {
    const id = aCanvas([])
    const done = await call('place_modules', { kehikko: id, modules: ['a.one'] }, door())
    expect(done.failed).toBe(false)
    expect(canvasNow(id).placements[0]).toMatchObject({ i: 'a.one', x: 0, y: 0, w: 12, h: 20 })
  })
})

describe('the record', () => {
  test('the file in the project and the database agree, and the page is woken', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20)])
    const done = await call('place_modules', { kehikko: id, modules: ['a.two'] }, door())
    expect(done.failed).toBe(false)
    /* By name: `addProject` gives a project an empty kehikko of its own on the
       way in, so this one is not the file's first. */
    const mine = recordAgrees().find((k) => k.name === 'the wire')
    expect(mine?.containers.map((c) => c.module)).toEqual(['a.one', 'a.two'])
    expect(mine?.containers.find((c) => c.module === 'a.two')).toMatchObject({ x: 12, y: 0, w: 12, h: 20, wish: 20 })
    /* Written first, woken after — see `select_modules`. */
    expect(woken).toEqual([id])
  })

  test('a placed container is not selected, pinned, grown, folded or on a clock', async () => {
    const id = aCanvas([])
    await call('place_modules', { kehikko: id, modules: ['a.one'] }, door())
    expect(canvasNow(id).placements[0]).toMatchObject({
      selected: false,
      pinned: false,
      grow: false,
      collapsed: false,
      prompt: '',
      promptFor: null,
      filters: {},
      refreshEvery: null,
    })
  })
})

describe('what is refused, and what is merely declined', () => {
  test('a module not registered on this computer is refused, whole, naming what could be placed', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20)])
    const before = canvasNow(id).placements
    const done = await call('place_modules', { kehikko: id, modules: ['a.two', 'nobody.home'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('nobody.home is not a module registered on this computer')
    expect(done.text).toContain('drawn as missing')
    expect(done.text).toContain('a.two, a.three, a.four')
    /* Nothing placed — not even a.two, which was fine. */
    expect(canvasNow(id).placements).toEqual(before)
    expect(woken).toEqual([])
  })

  test('a module already on the kehikko is left alone, with a sentence, and nothing is written', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20)])
    const before = canvasNow(id).placements
    const done = await call('place_modules', { kehikko: id, modules: ['a.one'] }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('a.one is already on kehikko')
    expect(done.text).toContain('Nothing was changed')
    expect(canvasNow(id).placements).toEqual(before)
    expect(woken).toEqual([])
  })

  test('one already there and one new: the new one is placed, the other is named as left alone', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20)])
    const done = await call('place_modules', { kehikko: id, modules: ['a.one', 'a.two'] }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('a.one was already there and left alone')
    expect(canvasNow(id).placements.map((p) => p.i)).toEqual(['a.one', 'a.two'])
  })

  test('no room without squeezing somebody: refused, and nothing is placed', async () => {
    /* One container the whole height of the canvas. The page's `+` would put
       the new one under it and `granted` would take rows from the top one to
       draw it — which is the taking-away this door does not do. */
    const id = aCanvas([box('a.one', 0, 0, 24, CANVAS_ROWS)])
    const before = canvasNow(id).placements
    const done = await call('place_modules', { kehikko: id, modules: ['a.two'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('no room on kehikko')
    expect(done.text).toContain('taking rows from a container somebody arranged')
    expect(canvasNow(id).placements).toEqual(before)
    expect(woken).toEqual([])
  })

  test('room for the floor and no more is still room; one row short of it is not', async () => {
    const enough = aCanvas([box('a.one', 0, 0, 24, CANVAS_ROWS - SQUEEZED_ROWS)])
    const yes = await call('place_modules', { kehikko: enough, modules: ['a.two'] }, door())
    expect(yes.failed).toBe(false)
    expect(canvasNow(enough).placements.find((p) => p.i === 'a.two')).toMatchObject({ h: SQUEEZED_ROWS })
    legal(canvasNow(enough).placements)

    rmSync(folder, { recursive: true, force: true })
    folder = mkdtempSync(join(tmpdir(), 'kehikko-placing-'))
    const short = aCanvas([box('a.three', 0, 0, 24, CANVAS_ROWS - SQUEEZED_ROWS + 1)])
    const no = await call('place_modules', { kehikko: short, modules: ['a.four'] }, door())
    expect(no.failed).toBe(true)
  })

  test('several where the last has no room: refused whole, saying which would have fitted', async () => {
    const id = aCanvas([box('a.one', 0, 0, 24, CANVAS_ROWS - 20)])
    const before = canvasNow(id).placements
    /* a.two fits under (twenty rows); a.three would go beside it — also fits;
       a.four would need a new row and there is none. */
    const done = await call('place_modules', { kehikko: id, modules: ['a.two', 'a.three', 'a.four'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('a.two, a.three would have fitted')
    expect(canvasNow(id).placements).toEqual(before)
  })

  test('the list is bounded the way select_modules bounds it', async () => {
    const id = aCanvas([])
    expect((await call('place_modules', { kehikko: id }, door())).failed).toBe(true)
    expect((await call('place_modules', { kehikko: id, modules: [] }, door())).failed).toBe(true)
    expect((await call('place_modules', { kehikko: id, modules: [7] }, door())).failed).toBe(true)
    expect((await call('place_modules', { kehikko: id, modules: ['x'.repeat(65)] }, door())).failed).toBe(true)
    expect(canvasNow(id).placements).toEqual([])
  })

  test('read_canvas says which registered modules are not on the kehikko, for exactly this tool', async () => {
    const id = aCanvas([box('a.one', 0, 0, 12, 20)])
    const read = await call('read_canvas', { kehikko: id }, door())
    expect(read.text).toContain('registered on this computer and not on this kehikko (what place_modules can add): a.two (Two), a.three (Three), a.four (Four)')
  })
})

describe('what a placed module is for', () => {
  test('a placed module is described by its summary and bounded guidance; one with neither is not', async () => {
    seen = [
      { id: 'a.one', name: 'One', condition: 'ready', summary: 'Runs sessions.', guidance: 'g'.repeat(900) },
      { id: 'a.two', name: 'Two', condition: 'ready' },
      { id: 'a.four', name: 'Four', condition: 'ready', summary: 'Other.' },
    ]
    const id = aCanvas([box('a.four', 0, 0, 12, 20)])
    const done = await call('place_modules', { kehikko: id, modules: ['a.one', 'a.two'] }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('for: "Runs sessions."')
    expect(done.text).toContain(`guidance: "${'g'.repeat(399)}…"`)
    expect(done.text).not.toContain('g'.repeat(400))
    /* Not asked for, so not said: a.four was already there. */
    expect(done.text).not.toContain('"Other."')
    const read = await call('read_canvas', { kehikko: id }, door())
    expect(read.text).toContain('"Other."')
  })
})
