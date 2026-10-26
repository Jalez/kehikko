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
import { Wakes, type FoldNote } from '../server/wake.ts'
import { FOLDED_ROWS, SQUEEZED_ROWS, folded, granted, laid, pressed, redrawn, tops } from '../src/host/columns.ts'
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
let notes: (FoldNote | undefined)[]
let seen: Sighting[]
let folder: string

const door = (): Door => ({
  db,
  which: () => openness.open(),
  watched: () => openness.every(),
  wake: (kehikko, note) => {
    woken.push(kehikko)
    notes.push(note)
    if (note) wakes.folded(kehikko, note)
    else wakes.woke(kehikko)
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
  notes = []
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

/** A kehikko in a project folder, with the given containers on it, open on a page — or not. */
function aCanvas(placements: Given[], watched = true): number {
  const added = addProject(db, folder, 'a project')
  if (!added.ok) throw new Error(added.why)
  const made = createCanvas(db, 'the wire', added.project.id)
  editCanvas(db, made.id, { placements: placements as Placement[] })
  if (watched) openness.reported(`page-${made.id}`, made.id)
  return made.id
}

const placementsNow = (id: number) => listCanvases(db).find((c) => c.id === id)!.placements
const one = (id: number, module: string) => placementsNow(id).find((p) => p.i === module)!

/** One column: a.one over a.two, which wants forty rows and is squeezed to twenty. */
const squeezed = (): Given[] => [
  { i: 'a.one', x: 0, y: 0, w: 6, h: 36, wish: 36 },
  { i: 'a.two', x: 0, y: 36, w: 6, h: 20, wish: 40, prompt: 'read this', selected: true },
]

describe('folding a container', () => {
  test('it is folded to its header, its wish is kept, and the one under it is drawn back at its own', async () => {
    const id = aCanvas(squeezed())
    const before = placementsNow(id)
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    expect(done.failed).toBe(false)

    expect(one(id, 'a.one')).toEqual({ ...before[0]!, collapsed: true, h: FOLDED_ROWS })
    /* Drawn up against the header above it, which is where the grid puts it. */
    expect(one(id, 'a.two')).toEqual({ ...before[1]!, h: 40, y: FOLDED_ROWS })
    expect(done.text).toContain('folded a.one.')
    expect(done.text).toContain('a.one (One) — folded to its header')
  })

  test('it is the write the page’s own fold control makes, stored where the grid then draws it', async () => {
    const byThePage = aCanvas(squeezed())
    const byTheDoor = createCanvas(db, 'the other wire', listCanvases(db)[0]!.project).id
    editCanvas(db, byTheDoor, { placements: placementsNow(byThePage) })
    openness.reported('another-page', byTheDoor)
    const before = placementsNow(byThePage)
    const expected = [
      { ...before[0]!, collapsed: true, h: FOLDED_ROWS },
      { ...before[1]!, h: 40, y: FOLDED_ROWS },
    ]

    /* The page stores its press and then what the grid made of it; the door
       has no grid, and stores both at once. */
    expect(pressed(before, 'a.one', true)).toEqual([expected[0]!, { ...expected[1]!, y: 36 }])
    editCanvas(db, byThePage, { placements: laid(pressed(before, 'a.one', true)) })
    await call('fold_modules', { kehikko: byTheDoor, fold: ['a.one'] }, door())

    expect(placementsNow(byThePage)).toEqual(expected)
    expect(placementsNow(byTheDoor)).toEqual(expected)
  })

  test('what the person does while the modules are being looked at is not overwritten', async () => {
    const id = aCanvas([...squeezed(), { i: 'a.three', x: 6, y: 0, w: 6, h: 20, wish: 20 }])
    let looked!: (sightings: Sighting[]) => void
    const looking = new Promise<Sighting[]>((resolve) => {
      looked = resolve
    })
    let sweeps = 0
    const slow: Door = {
      ...door(),
      seen: () => {
        sweeps += 1
        return looking
      },
    }

    const answering = call('fold_modules', { kehikko: id, fold: ['a.one'] }, slow)
    /* The person, while the sweep is out: one container dragged and resized,
       another taken off. */
    editCanvas(db, id, {
      placements: placementsNow(id)
        .filter((p) => p.i !== 'a.three')
        .map((p) => (p.i === 'a.two' ? { ...p, x: 6, y: 0, w: 4, h: 24, wish: 24 } : p)),
    })
    const theirs = placementsNow(id)
    looked(seen)
    const done = await answering

    expect(done.failed).toBe(false)
    expect(sweeps).toBe(1)
    expect(placementsNow(id)).toEqual(theirs)
    expect(one(id, 'a.one').collapsed).toBe(true)
    expect(one(id, 'a.two')).toMatchObject({ x: 6, y: 0, w: 4, h: 24, wish: 24 })
    expect(placementsNow(id).some((p) => p.i === 'a.three')).toBe(false)
  })

  test('the answer says who did it and which call puts it back, and that call does', async () => {
    const id = aCanvas(squeezed())
    const before = placementsNow(id)
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    expect(done.text).toContain('agent (MCP)')
    expect(done.text).toContain('To put back what this call changed: fold_modules with unfold: ["a.one"].')
    expect(done.text).toContain('only if the person has not folded or unfolded those containers themselves since')

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
    const done = await call('fold_modules', { fold: ['a.two'] }, door())
    expect(done.text).toContain('a page of this host has open')
    expect(one(id, 'a.two').collapsed).toBe(true)
  })
})

describe('unfolding a container', () => {
  test('it comes back at the height its owner chose', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: FOLDED_ROWS, wish: 28, collapsed: true },
      { i: 'a.two', x: 6, y: 0, w: 6, h: 20, wish: 20 },
    ])
    const done = await call('fold_modules', { kehikko: id, unfold: ['a.one'] }, door())
    expect(done.failed).toBe(false)
    expect(one(id, 'a.one')).toMatchObject({ collapsed: false, h: 28, wish: 28 })
    expect(one(id, 'a.two')).toMatchObject({ h: 20, wish: 20 })
    expect(done.text).not.toContain('rows it asks for')
  })

  test('into a full column it comes back short, says so, and nobody’s wish is rewritten', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: 52, wish: 52 },
      { i: 'a.two', x: 0, y: 52, w: 6, h: FOLDED_ROWS, wish: 20, collapsed: true },
    ])
    const done = await call('fold_modules', { kehikko: id, unfold: ['a.two'] }, door())
    expect(done.failed).toBe(false)

    const now = placementsNow(id)
    expect(one(id, 'a.two')).toMatchObject({ collapsed: false, h: SQUEEZED_ROWS, wish: 20 })
    expect(one(id, 'a.one')).toMatchObject({ h: CANVAS_ROWS - SQUEEZED_ROWS, wish: 52, x: 0, y: 0, w: 6 })
    expect(done.text).toContain(`a.two is drawn at ${SQUEEZED_ROWS} of the 20 rows it asks for`)

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
      { i: 'a.one', x: 0, y: 0, w: 6, h: 54, wish: 54 },
      { i: 'a.two', x: 0, y: 54, w: 6, h: FOLDED_ROWS, wish: 40, collapsed: true },
    ])
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'], unfold: ['a.two'] }, door())
    expect(done.failed).toBe(false)
    expect(one(id, 'a.one')).toMatchObject({ collapsed: true, h: FOLDED_ROWS, wish: 54 })
    expect(one(id, 'a.two')).toMatchObject({ collapsed: false, h: 40, wish: 40 })
    expect(done.text).toContain('fold_modules with unfold: ["a.one"], fold: ["a.two"].')
    expect(woken).toEqual([id])
  })

  test('a container already as asked is left alone, and left out of the way back', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: FOLDED_ROWS, wish: 24, collapsed: true },
      { i: 'a.two', x: 6, y: 0, w: 6, h: 20, wish: 20 },
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

describe('a fold is seen and signed', () => {
  test('a kehikko no page has open is refused, naming the ones that are', async () => {
    const watched = aCanvas(squeezed())
    const unwatched = createCanvas(db, 'the back room', listCanvases(db)[0]!.project).id
    editCanvas(db, unwatched, { placements: placementsNow(watched) })

    const done = await call('fold_modules', { kehikko: unwatched, fold: ['a.one'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain(`kehikko ${unwatched} (the back room) is not open on any page of this host`)
    expect(done.text).toContain(`Open on a page right now: ${watched} (the wire).`)
    expect(placementsNow(unwatched).some((p) => p.collapsed)).toBe(false)
    expect(woken).toEqual([])
  })

  test('with no page open at all it says so, and nothing is written', async () => {
    const id = aCanvas(squeezed(), false)
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain('No page of this host has any kehikko open right now.')
    expect(one(id, 'a.one').collapsed).toBe(false)
  })

  test('a door that cannot list the open kehikot folds only on the one `which` names', async () => {
    const id = aCanvas(squeezed())
    const other = createCanvas(db, 'the back room', listCanvases(db)[0]!.project).id
    editCanvas(db, other, { placements: placementsNow(id) })
    const { watched: _, ...narrow } = door()
    expect((await call('fold_modules', { kehikko: other, fold: ['a.one'] }, narrow)).failed).toBe(true)
    expect((await call('fold_modules', { kehikko: id, fold: ['a.one'] }, narrow)).failed).toBe(false)
  })

  test('of two kehikot open on two pages, the one named is folded on', async () => {
    const first = aCanvas(squeezed())
    const second = createCanvas(db, 'the other wire', listCanvases(db)[0]!.project).id
    editCanvas(db, second, { placements: placementsNow(first) })
    openness.reported('another-page', second)

    expect((await call('fold_modules', { fold: ['a.one'] }, door())).failed).toBe(true)
    const done = await call('fold_modules', { kehikko: second, fold: ['a.one'] }, door())
    expect(done.failed).toBe(false)
    expect(one(second, 'a.one').collapsed).toBe(true)
    expect(one(first, 'a.one').collapsed).toBe(false)
  })

  test('the page is told who, and only about the containers the call changed', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: FOLDED_ROWS, wish: 24, collapsed: true },
      { i: 'a.two', x: 6, y: 0, w: 6, h: 20, wish: 20 },
      { i: 'a.three', x: 0, y: 24, w: 6, h: FOLDED_ROWS, wish: 16, collapsed: true },
    ])
    const heard: unknown[] = []
    wakes.listen((news) => heard.push(news))
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one', 'a.two'], unfold: ['a.three'] }, door())

    const note = { by: 'an agent', fold: ['a.two'], unfold: ['a.three'] }
    expect(notes).toEqual([note])
    expect(heard).toEqual([{ kehikko: id, folded: note }])
    expect(done.text).toContain('says "folded by an agent" until the person presses it')
  })

  test('the door’s write is `folded`, the one function a press and a module’s request go through', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: 54, wish: 54 },
      { i: 'a.two', x: 0, y: 54, w: 6, h: FOLDED_ROWS, wish: 40, collapsed: true },
    ])
    const expected = laid(folded(placementsNow(id), { fold: ['a.one'], unfold: ['a.two'] }))
    await call('fold_modules', { kehikko: id, fold: ['a.one'], unfold: ['a.two'] }, door())
    expect(placementsNow(id)).toEqual(expected)
    expect(one(id, 'a.two')).toMatchObject({ y: FOLDED_ROWS, x: 0, w: 6 })
    expect(pressed(placementsNow(id), 'a.one', false)).toEqual(folded(placementsNow(id), { unfold: ['a.one'] }))
  })
})

describe('a fold leaves the page nothing of its own to save', () => {
  /* The page stores what the grid makes of an arrangement it re-reads. If
     that differs from what the door stored, the page saves a whole arrangement
     a moment later, and the agent's NEXT call — made in that moment — is
     overwritten by it. So what the door stores is already where the grid puts
     it: every top edge is `tops`. */
  const settled = (id: number) => {
    const now = placementsNow(id)
    const above = tops(now)
    const heights = granted(now)
    for (const p of now) {
      expect(p.y).toBe(above.get(p.i)!)
      expect(p.h).toBe(heights.get(p.i)!)
    }
  }

  test('what is under a folded container is stored drawn up against it, and back down on unfold', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: 20, wish: 20 },
      { i: 'a.two', x: 6, y: 0, w: 6, h: 20, wish: 20 },
      { i: 'a.three', x: 0, y: 20, w: 6, h: 20, wish: 20 },
    ])
    const before = placementsNow(id)
    await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    settled(id)
    expect(one(id, 'a.three')).toMatchObject({ x: 0, y: FOLDED_ROWS, w: 6, h: 20, wish: 20 })
    expect(one(id, 'a.two')).toEqual(before.find((p) => p.i === 'a.two')!)

    await call('fold_modules', { kehikko: id, unfold: ['a.one'] }, door())
    settled(id)
    expect(placementsNow(id)).toEqual(before)
  })

  test('a selection made straight after a fold is still there once the page has caught up', async () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 6, h: 20, wish: 20 },
      { i: 'a.three', x: 0, y: 20, w: 6, h: 20, wish: 20 },
    ])
    await call('fold_modules', { kehikko: id, fold: ['a.one'] }, door())
    const read = placementsNow(id)
    await call('select_modules', { kehikko: id, modules: ['a.three'] }, door())
    /* The page, having re-read the fold: it saves only if the grid disagrees
       with what it read, and the grid's answer is `laid`. */
    if (JSON.stringify(laid(read)) !== JSON.stringify(read)) editCanvas(db, id, { placements: laid(read) })
    expect(one(id, 'a.three').selected).toBe(true)
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

  test('a refused entry names the list it was in', async () => {
    const id = aCanvas(squeezed())
    const done = await call('fold_modules', { kehikko: id, fold: ['a.one'], unfold: [7] }, door())
    expect(done.text).toContain('every entry in unfold has to be a module id')
    expect(done.text).not.toContain('modules')
  })

  test('a kehikko that does not exist is refused with the list', async () => {
    const id = aCanvas(squeezed())
    const done = await call('fold_modules', { kehikko: 9999, fold: ['a.one'] }, door())
    expect(done.failed).toBe(true)
    expect(done.text).toContain(`  ${id}: the wire`)
  })
})
