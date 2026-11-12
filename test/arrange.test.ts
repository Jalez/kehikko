import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneLayout, compact } from 'react-grid-layout/build/utils'

import { createCanvas, editCanvas, listCanvases, open, type Placement } from '../server/canvases.ts'
import { Arranging, arrangingRoute, ARRANGING_HOLD_MS } from '../server/arranging.ts'
import { ARRANGE_PER_MINUTE, call, TOOL_NAMES, type Door, type Sighting } from '../server/mcp.ts'
import type { Here } from '../server/doorPlaces.ts'
import { Openness } from '../server/open.ts'
import { addProject, type Project } from '../server/projects.ts'
import type { ArrangeNote } from '../server/wake.ts'
import {
  arrangeNoted,
  arrangeNoteIn,
  arrangeStands,
  arrangedAs,
  geometryOf,
  movedTo,
  resizedAs,
  undoneTo,
  type ArrangeMark,
} from '../src/host/arrange.ts'
import { fromGrid, type Placement as PagePlacement } from '../src/host/canvases.ts'
import { arranged, dragged, redrawn, wishing } from '../src/host/columns.ts'
import { COLUMNS } from '../src/host/fit.ts'

/*
 * `arrange_modules`: an agent resizing, moving and showing containers on its own kehikko, by the
 * rules a person's drag is made by, signed, undone with one press, never under the person's hand,
 * paced, and never removing anything.
 */

let db: Database
let openness: Openness
let woken: { kehikko: number; arranged?: ArrangeNote }[]
let folder: string
let project: Project
let busy: Set<number>
let arranges: Map<string, number[]>
let clock: number

const seen: Sighting[] = [
  { id: 'a.one', name: 'One', condition: 'ready' },
  { id: 'a.two', name: 'Two', condition: 'ready' },
  { id: 'a.three', name: 'Three', condition: 'ready' },
]

const canvasOf = (id: number) => listCanvases(db).find((c) => c.id === id)!
const placementsNow = (id: number) => canvasOf(id).placements
const one = (id: number, module: string) => placementsNow(id).find((p) => p.i === module)!

const hereOn = (kehikko: number | null): Here => ({
  token: null,
  via: 'session',
  module: null,
  conversation: 'c-1',
  project,
  epic: null,
  parts: [],
  key: kehikko === null ? null : (canvasOf(kehikko).key ?? null),
  canvas: kehikko === null ? null : canvasOf(kehikko),
})

const door = (own: number | null, more: Partial<Door> = {}): Door => ({
  db,
  which: () => openness.open(),
  watched: () => openness.every(),
  wake: (kehikko, _folded, arranged) => {
    woken.push({ kehikko, ...(arranged ? { arranged } : {}) })
  },
  epicsChanged: () => {},
  dispositionsChanged: () => {},
  seen: async () => seen,
  here: hereOn(own),
  session: 'session-one-0000000',
  arranging: (kehikko) => busy.has(kehikko),
  arranges,
  now: () => clock,
  ...more,
})

type Given = Partial<Placement> & { i: string }

function aCanvas(placements: Given[], name = 'the wire', watched = true): number {
  const made = createCanvas(db, name, project.id)
  editCanvas(db, made.id, { placements: placements as Placement[] })
  if (watched) openness.reported(`page-${made.id}`, made.id)
  return made.id
}

/** Two side by side, and one under the first. */
const three = (): Given[] => [
  { i: 'a.one', x: 0, y: 0, w: 12, h: 28, wish: 28 },
  { i: 'a.two', x: 12, y: 0, w: 12, h: 56, wish: 56 },
  { i: 'a.three', x: 0, y: 28, w: 12, h: 28, wish: 28 },
]

beforeEach(() => {
  db = open(':memory:')
  openness = new Openness()
  woken = []
  busy = new Set()
  arranges = new Map()
  clock = 1_000_000
  folder = mkdtempSync(join(tmpdir(), 'kehikko-arrange-'))
  const added = addProject(db, folder, 'a project')
  if (!added.ok) throw new Error(added.why)
  project = added.project
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('resizing and moving on the conversation’s own kehikko', () => {
  test('a resize is applied, the column pays, and the page is woken with a signed note', async () => {
    const id = aCanvas(three())
    const done = await call('arrange_modules', { containers: [{ module: 'a.one', rows: 40 }] }, door(id))
    expect(done.failed).toBe(false)
    expect(one(id, 'a.one')).toMatchObject({ x: 0, y: 0, w: 12, h: 40, wish: 40 })
    /* The container under it gave up rows, and kept its own wish. */
    expect(one(id, 'a.three')).toMatchObject({ y: 40, h: 16, wish: 28 })
    expect(woken).toHaveLength(1)
    expect(woken[0]!.arranged!.by).toBe('an agent')
    expect(woken[0]!.arranged!.changed).toEqual(['a.one'])
    expect(done.text).toContain('a.one is at column 0, row 0, 12 wide and 40 tall.')
    expect(done.text).toContain('Undo')
  })

  test('a named size sets the width, and a move puts a container where it is asked', async () => {
    const id = aCanvas(three())
    const done = await call('arrange_modules', { containers: [{ module: 'a.three', size: 'full' }] }, door(id))
    expect(done.failed).toBe(false)
    /* Full width from column 0: what was beside it is pushed down, as under a hand. */
    expect(one(id, 'a.three').w).toBe(COLUMNS)
    const moved = await call('arrange_modules', { containers: [{ module: 'a.one', column: 12 }] }, door(id))
    expect(moved.failed).toBe(false)
    expect(one(id, 'a.one').x).toBe(12)
    /* Nothing was removed. */
    expect(placementsNow(id).map((p) => p.i).sort()).toEqual(['a.one', 'a.three', 'a.two'])
  })

  test('show unfolds a folded container and puts a tile back', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 12, h: 2, wish: 20, collapsed: true },
      { i: 'a.two', x: 12, y: 0, w: 12, h: 12, wish: 20, tiled: true },
    ])
    const done = await call('arrange_modules', { show: ['a.one', 'a.two'] }, door(id))
    expect(done.failed).toBe(false)
    expect(one(id, 'a.one')).toMatchObject({ collapsed: false, h: 20 })
    expect(one(id, 'a.two').tiled).toBeUndefined()
    expect(done.text).toContain('a.one is shown')
  })

  test('read_canvas says every container’s column, row, width and height', async () => {
    const id = aCanvas(three())
    const read = await call('read_canvas', {}, door(id))
    expect(read.text).toContain('at column 12, row 0; 12 wide and 56 tall, of 24 columns and 56 rows')
  })

  test('a tile is not resized unless it is shown first, as a person cannot pull a tile’s corner', async () => {
    const id = aCanvas([{ i: 'a.one', x: 0, y: 0, w: 12, h: 12, wish: 20, tiled: true }])
    const refused = await call('arrange_modules', { containers: [{ module: 'a.one', rows: 30 }] }, door(id))
    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('is a tile')
    const done = await call('arrange_modules', { show: ['a.one'], containers: [{ module: 'a.one', rows: 30 }] }, door(id))
    expect(done.failed).toBe(false)
    expect(one(id, 'a.one')).toMatchObject({ h: 30, wish: 30 })
  })
})

describe('only the conversation’s own kehikko', () => {
  test('another kehikko is refused, and nothing is written there', async () => {
    const own = aCanvas(three())
    const other = aCanvas(three(), 'another')
    const before = placementsNow(other)
    const done = await call('arrange_modules', { kehikko: other, containers: [{ module: 'a.one', rows: 40 }] }, door(own))
    expect(done.failed).toBe(true)
    expect(done.text).toContain('is not this conversation’s own')
    expect(placementsNow(other)).toEqual(before)
    expect(woken).toHaveLength(0)
  })

  test('a conversation with no kehikko of its own is refused', async () => {
    const id = aCanvas(three())
    const done = await call('arrange_modules', { kehikko: id, containers: [{ module: 'a.one', rows: 40 }] }, door(null))
    expect(done.failed).toBe(true)
    expect(done.text).toContain('set_my_place')
    const none = await call('arrange_modules', { kehikko: id, containers: [{ module: 'a.one', rows: 40 }] }, door(null, { here: null }))
    expect(none.failed).toBe(true)
  })

  test('a kehikko no page has open is refused', async () => {
    const id = aCanvas(three(), 'unseen', false)
    const done = await call('arrange_modules', { kehikko: id, containers: [{ module: 'a.one', rows: 40 }] }, door(id))
    expect(done.failed).toBe(true)
    expect(done.text).toContain('not open on any page')
  })
})

describe('Undo', () => {
  test('restores the exact arrangement before, every container’s place, size, wish and fold', async () => {
    const id = aCanvas(three())
    const before = placementsNow(id)
    await call('arrange_modules', { containers: [{ module: 'a.three', size: 'full', rows: 20 }, { module: 'a.one', column: 12 }] }, door(id))
    const note = arrangeNoteIn(JSON.parse(JSON.stringify(woken[0]!.arranged)))!
    expect(note).not.toBeNull()
    const mark = arrangeNoted(null, id, note)
    const after = placementsNow(id)
    expect(arrangeStands(mark, id, after)).toBe(true)
    const undone = undoneTo(mark, id, after)!
    expect(undone.map(geometryOf)).toEqual(before.map(geometryOf))
    /* Everything else about each container is left as it is now. */
    expect(undone.map((p) => p.i)).toEqual(after.map((p) => p.i))
  })

  test('two agent changes in a row go back to before the first; a person’s own change takes the mark away', async () => {
    const id = aCanvas(three())
    const before = placementsNow(id)
    await call('arrange_modules', { containers: [{ module: 'a.one', rows: 40 }] }, door(id))
    await call('arrange_modules', { containers: [{ module: 'a.two', size: 'half', column: 0 }] }, door(id))
    const mark = woken.reduce<ArrangeMark | null>((was, w) => arrangeNoted(was, id, w.arranged!), null)!
    expect(mark.changed).toEqual(['a.one', 'a.two'])
    expect(undoneTo(mark, id, placementsNow(id))!.map(geometryOf)).toEqual(before.map(geometryOf))

    const theirs = placementsNow(id).map((p) => (p.i === 'a.one' ? { ...p, wish: 10 } : p))
    expect(arrangeStands(mark, id, theirs)).toBe(false)
    expect(undoneTo(mark, id, theirs)).toBeNull()
  })
})

describe('never under the person’s hand', () => {
  test('refused while the person is dragging or resizing on that kehikko', async () => {
    const id = aCanvas(three())
    const before = placementsNow(id)
    busy.add(id)
    const done = await call('arrange_modules', { containers: [{ module: 'a.one', rows: 40 }] }, door(id))
    expect(done.failed).toBe(true)
    expect(done.text).toContain('the person is arranging this kehikko')
    expect(placementsNow(id)).toEqual(before)
    expect(woken).toHaveLength(0)
    busy.delete(id)
    expect((await call('arrange_modules', { containers: [{ module: 'a.one', rows: 40 }] }, door(id))).failed).toBe(false)
  })

  test('the page’s word holds until it says it ended, or for a while at most', async () => {
    const held = new Arranging()
    held.report('page-1', 3, true, 0)
    expect(held.busy(3, 1)).toBe(true)
    expect(held.busy(4, 1)).toBe(false)
    held.report('page-1', 3, false, 2)
    expect(held.busy(3, 3)).toBe(false)
    held.report('page-1', 3, true, 10)
    expect(held.busy(3, 10 + ARRANGING_HOLD_MS)).toBe(false)
    held.report('page-2', 3, true, 0)
    held.forget('page-2')
    expect(held.busy(3, 1)).toBe(false)
  })

  test('the route takes the page’s word and refuses anything else', async () => {
    const held = new Arranging()
    const post = (body: unknown) =>
      arrangingRoute(new Request('http://x/host/arranging', { method: 'POST', body: JSON.stringify(body) }), new URL('http://x/host/arranging'), held)
    expect((await post({ page: 'p', kehikko: 2, arranging: true }))!.status).toBe(200)
    expect(held.busy(2)).toBe(true)
    expect((await post({ page: 'p', kehikko: 'two', arranging: true }))!.status).toBe(400)
    expect((await post({ kehikko: 2, arranging: true }))!.status).toBe(400)
  })
})

describe('the pace', () => {
  test(`at most ${ARRANGE_PER_MINUTE} changes a minute for one conversation`, async () => {
    const id = aCanvas(three())
    for (let n = 0; n < ARRANGE_PER_MINUTE; n++) {
      clock += 100
      const done = await call('arrange_modules', { containers: [{ module: 'a.one', rows: n % 2 ? 30 : 40 }] }, door(id))
      expect(done.failed).toBe(false)
    }
    clock += 100
    const refused = await call('arrange_modules', { containers: [{ module: 'a.one', rows: 20 }] }, door(id))
    expect(refused.failed).toBe(true)
    expect(refused.text).toContain('in the last minute')
    clock += 60_000
    expect((await call('arrange_modules', { containers: [{ module: 'a.one', rows: 20 }] }, door(id))).failed).toBe(false)
  })

  test('a call that changes nothing is not counted', async () => {
    const id = aCanvas(three())
    for (let n = 0; n < ARRANGE_PER_MINUTE + 2; n++) {
      const done = await call('arrange_modules', { containers: [{ module: 'a.one', rows: 28 }] }, door(id))
      expect(done.failed).toBe(false)
      expect(done.text).toContain('already as asked')
    }
  })
})

describe('removing stays the person’s', () => {
  test('remove is refused by name, no tool removes a container, and every container in is one out', async () => {
    const id = aCanvas(three())
    const done = await call('arrange_modules', { remove: ['a.one'] }, door(id))
    expect(done.failed).toBe(true)
    expect(done.text).toContain('does not remove containers')
    expect(placementsNow(id)).toHaveLength(3)
    const names: readonly string[] = TOOL_NAMES
    expect(names.some((name) => /remove|unplace|delete/.test(name))).toBe(false)

    const start = arranged(three().map((p) => ({ grow: false, pinned: false, prompt: '', promptFor: null, selected: false, ...p })) as Placement[])
    for (const w of [2, 8, 24])
      for (const x of [0, 7, 23])
        expect(arrangedAs(start, [{ i: 'a.two', w, h: 30, x, y: 40 }]).map((p) => p.i).sort()).toEqual(['a.one', 'a.three', 'a.two'])
  })
})

describe('the same rules as a person’s drag', () => {
  /** What the page does for a person's south-east corner pulled to w by h: `onResize`, the grid's compaction, `onLayoutChange`. */
  function byHand(stored: PagePlacement[], id: string, w: number, h: number): PagePlacement[] {
    const shown = arranged(stored)
    const layout = cloneLayout(shown.map((p) => ({ i: p.i, x: p.x, y: p.y, w: p.w, h: p.h })))
    const l = layout.find((one) => one.i === id)!
    l.w = w
    l.h = h
    const before = shown.find((p) => p.i === id)!
    const heights = wishing(shown, id, dragged(before, h))
    for (const one of layout) one.h = heights.get(one.i) ?? one.h
    const next = compact(layout, 'vertical', COLUMNS)
    return arranged(redrawn(fromGrid(shown, next, id, new Map())))
  }

  const page = (given: Given[]): PagePlacement[] =>
    given.map((p) => ({
      grow: false, pinned: false, prompt: '', promptFor: null, collapsed: false, selected: false,
      filters: {}, refreshEvery: null, version: null, scope: null, ...p,
    }) as PagePlacement)

  const byPlace = <T extends { i: string }>(list: readonly T[]) => [...list].sort((a, b) => a.i.localeCompare(b.i)).map((p) => geometryOf(p as never))

  for (const [w, h] of [[12, 40], [24, 20], [6, 10], [18, 56]] as const) {
    test(`a resize of a.one to ${w} by ${h} lands where the person’s corner would`, () => {
      const stored = page(three())
      expect(byPlace(resizedAs(stored, 'a.one', { w, h }))).toEqual(byPlace(byHand(stored, 'a.one', w, h)))
    })
  }

  test('a move pushes what is in the way and compacts upward, as a drop does', () => {
    const stored = page(three())
    /* a.three dragged up to the top: it takes a.one's place and a.one goes under it. */
    const moved = movedTo(stored, 'a.three', { y: 0 })
    expect(moved.find((p) => p.i === 'a.three')).toMatchObject({ x: 0, y: 0 })
    expect(moved.find((p) => p.i === 'a.one')).toMatchObject({ x: 0, y: 28 })
    /* Asked below empty space, it rises to meet what is above it. */
    const alone = movedTo(page([{ i: 'a.one', x: 0, y: 0, w: 12, h: 10, wish: 10 }]), 'a.one', { x: 4, y: 30 })
    expect(alone[0]).toMatchObject({ x: 4, y: 0 })
  })
})
