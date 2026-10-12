import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, listCanvases, open, type Placement } from '../server/canvases.ts'
import { kehikotFile, serialize } from '../server/kehikot.ts'
import { call, type Door, type Sighting } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { Wakes } from '../server/wake.ts'
import { FOLDED_ROWS, SQUEEZED_ROWS, granted, redrawn, tops } from '../src/host/columns.ts'
import { CANVAS_ROWS } from '../src/host/fit.ts'

/*
 * `fold_modules`: an agent folding containers to their headers and unfolding
 * them.
 *
 * What is tested is what the essay in `mcp.ts` promises about it: that it is
 * the write the page's own fold control makes — a state set and the heights
 * redrawn from the wishes — that no wish, position, width or anything else a
 * person chose is touched, that the answer says how to put back exactly what
 * the call changed, and that everything it cannot do is refused with nothing
 * written.
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
    { id: 'a.three', name: 'Three', condition: 'ready' },
  ]
  folder = mkdtempSync(join(tmpdir(), 'kehikko-folding-'))
})
afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

type Given = Partial<Placement> & { i: string }

/** A kehikko in a project folder, with the given containers on it. */
function aCanvas(placements: Given[]): number {
  const added = addProject(db, folder, 'a project')
  if (!added.ok) throw new Error(added.why)
  const made = createCanvas(db, 'the wire', added.project.id)
  editCanvas(db, made.id, { placements: placements as Placement[] })
  return made.id
}

const placementsNow = (id: number) => listCanvases(db).find((c) => c.id === id)!.placements
const one = (id: number, module: string) => placementsNow(id).find((p) => p.i === module)!

/** One column: a.one over a.two, which wants twenty rows and is squeezed to ten. */
const squeezed = (): Given[] => [
  { i: 'a.one', x: 0, y: 0, w: 6, h: 18, wish: 18 },
  { i: 'a.two', x: 0, y: 18, w: 6, h: 10, wish: 20, prompt: 'read this', selected: true },
]

describe('folding a container', () => {
  test('it is folded to its header, its wish is kept, and the one under it is drawn back at its own', async () => {
    const id = aCanvas(squeezed())
    const before = placementsNow(id)
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    expect(done.failed).toBe(false)

    expect(one(id, 'a.one')).toEqual({ ...before[0]!, collapsed: true, h: FOLDED_ROWS })
    expect(one(id, 'a.two')).toEqual({ ...before[1]!, h: 20 })
    expect(done.text).toContain('folded a.one.')
    expect(done.text).toContain('a.one (One) — folded to its header')
  })

  test('it is the write the page’s own fold control makes', async () => {
    const id = aCanvas(squeezed())
    const pressed = redrawn(placementsNow(id).map((p) => (p.i === 'a.one' ? { ...p, collapsed: true } : p)))
    await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    expect(placementsNow(id)).toEqual(pressed)
  })

  test('the answer says who did it and which call puts it back, and that call does', async () => {
    const id = aCanvas(squeezed())
    const before = placementsNow(id)
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    expect(done.text).toContain('agent (MCP)')
    expect(done.text).toContain('To put back what this call changed: fold_modules with unfold: ["a.one"].')

    await call('fold_modules', { kehikko: id, unfold: ['a.one'] }, door())
    expect(placementsNow(id)).toEqual(before)
  })

  test('the page is woken after the write, and the project’s file says the same as the database', async () => {
    const id = aCanvas(squeezed())
    const heard: boolean[] = []
    wakes.listen((news) => {
      if ('kehikko' in news) heard.push(one(news.kehikko, 'a.one').collapsed)
    })
    await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    expect(heard).toEqual([true])
    expect(woken).toEqual([id])
    expect(readFileSync(kehikotFile(folder)!, 'utf8')).toBe(serialize(listCanvases(db)))
  })

  test('the kehikko a page has open is the one folded on when none is named', async () => {
    const id = aCanvas(squeezed())
    openness.reported('page-a', id)
    const done = await call('fold_modules', { fold: ['a.two'] }, door())
    expect(done.text).toContain('a page of this host has open')
    expect(one(id, 'a.two').collapsed).toBe(true)
  })
})

describe('unfolding a container', () => {
  test('it comes back at the height its owner chose', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: FOLDED_ROWS, wish: 14, collapsed: true },
      { i: 'a.two', x: 6, y: 0, w: 6, h: 10, wish: 10 },
    ])
    const done = await call('fold_modules', { kehikko: id, unfold: ['a.one'] }, door())
    expect(done.failed).toBe(false)
    expect(one(id, 'a.one')).toMatchObject({ collapsed: false, h: 14, wish: 14 })
    expect(one(id, 'a.two')).toMatchObject({ h: 10, wish: 10 })
    expect(done.text).not.toContain('rows it asks for')
  })

  test('into a full column it comes back short, says so, and nobody’s wish is rewritten', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: 26, wish: 26 },
      { i: 'a.two', x: 0, y: 26, w: 6, h: FOLDED_ROWS, wish: 10, collapsed: true },
    ])
    const done = await call('fold_modules', { kehikko: id, unfold: ['a.two'] }, door())
    expect(done.failed).toBe(false)

    const now = placementsNow(id)
    expect(one(id, 'a.two')).toMatchObject({ collapsed: false, h: SQUEEZED_ROWS, wish: 10 })
    expect(one(id, 'a.one')).toMatchObject({ h: CANVAS_ROWS - SQUEEZED_ROWS, wish: 26, x: 0, y: 0, w: 6 })
    expect(done.text).toContain(`a.two is drawn at ${SQUEEZED_ROWS} of the 10 rows it asks for`)

    const heights = granted(now)
    const above = tops(now)
    for (const p of now) {
      expect(p.h).toBe(heights.get(p.i)!)
      expect(above.get(p.i)! + p.h).toBeLessThanOrEqual(CANVAS_ROWS)
    }
  })
})

describe('folding and unfolding in one call', () => {
  test('room is made and the module wanted is brought into view', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: 27, wish: 27 },
      { i: 'a.two', x: 0, y: 27, w: 6, h: FOLDED_ROWS, wish: 20, collapsed: true },
    ])
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'], unfold: ['a.two'] }, door())
    expect(done.failed).toBe(false)
    expect(one(id, 'a.one')).toMatchObject({ collapsed: true, h: FOLDED_ROWS, wish: 27 })
    expect(one(id, 'a.two')).toMatchObject({ collapsed: false, h: 20, wish: 20 })
    expect(done.text).toContain('fold_modules with unfold: ["a.one"], fold: ["a.two"].')
    expect(woken).toEqual([id])
  })

  test('a container already as asked is left alone, and left out of the way back', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: FOLDED_ROWS, wish: 12, collapsed: true },
      { i: 'a.two', x: 6, y: 0, w: 6, h: 10, wish: 10 },
    ])
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one', 'a.two'] }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('a.one was already as asked and left alone.')
    /* Undoing the agent's fold must not unfold what a person folded. */
    expect(done.text).toContain('fold_modules with unfold: ["a.two"].')
  })

  test('when everything is already as asked nothing is written and nobody is woken', async () => {
    const id = aCanvas(squeezed())
    const before = placementsNow(id)
    const done = await call('fold_modules', { kehikko: id, unfold: ['a.one', 'a.two'] }, door())
    expect(done.failed).toBe(false)
    expect(done.text).toContain('Nothing was changed')
    expect(placementsNow(id)).toEqual(before)
    expect(woken).toEqual([])
  })
})

describe('what a fold is not', () => {
  test('a person’s own unfold afterwards stands: the door holds nothing that folds it again', async () => {
    const id = aCanvas(squeezed())
    await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    editCanvas(db, id, {
      placements: redrawn(placementsNow(id).map((p) => (p.i === 'a.one' ? { ...p, collapsed: false } : p))),
    })
    const read = await call('read_canvas', { kehikko: id }, door())
    expect(read.text).not.toContain('folded to its header')
    const again = await call('fold_modules', { kehikko: id, unfold: ['a.one'] }, door())
    expect(again.text).toContain('a.one was already as asked and left alone.')
    expect(one(id, 'a.one').collapsed).toBe(false)
  })

  test('a container that is not on the kehikko is refused whole', async () => {
    const id = aCanvas(squeezed())
    const before = placementsNow(id)
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'], unfold: ['a.three'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('a.three is not a container')
    expect(done.text).toContain('a.one, a.two')
    expect(placementsNow(id)).toEqual(before)
    expect(woken).toEqual([])
  })

  test('the same container in both lists is refused', async () => {
    const id = aCanvas(squeezed())
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'], unfold: ['a.one'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('in both fold and unfold')
    expect(one(id, 'a.one').collapsed).toBe(false)
  })

  test('the lists are bounded the way select_modules bounds its own', async () => {
    const id = aCanvas(squeezed())
    for (const bad of [{}, { fold: [] }, { fold: 'a.one' }, { unfold: [7] }, { fold: ['x'.repeat(65)] }, { fold: [''] }]) {
      const done = await call('fold_modules', { kehikko: id, ...bad }, door())
      expect(done.failed).toBe(true)
    }
    expect(placementsNow(id).some((p) => p.collapsed)).toBe(false)
    expect(woken).toEqual([])
  })

  test('a kehikko that does not exist is refused with the list', async () => {
    const id = aCanvas(squeezed())
    const done = await call('fold_modules', { kehikko: 9999, fold: ['a.one'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain(`  ${id}: the wire`)
  })
})
