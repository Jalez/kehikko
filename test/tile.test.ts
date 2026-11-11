import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { footerItemsSchema } from 'kehikot-module-protocol'

import { createCanvas, editCanvas, listCanvases, open, type Placement } from '../server/canvases.ts'
import { shared } from '../server/kehikot.ts'
import { call, type Door, type Sighting } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { viewOf } from '../server/view.ts'
import { type FoldNote } from '../server/wake.ts'
import { APPEARANCE_DEFAULT, appearanceIn, appearancePatched } from '../src/host/appearance.ts'
import { fromGrid } from '../src/host/canvases.ts'
import { TILE_COLUMNS, TILE_ROWS, arranged, drawnWidth, folded, granted, tiledTo, type Wished } from '../src/host/columns.ts'
import { COLUMNS } from '../src/host/fit.ts'
import { asked, foldNoteIn, noted, signedBy, standing, tileHint } from '../src/host/folds.ts'
import { containersOf } from '../src/host/showing.ts'
import { foldsOnlyChanged } from '../src/host/switching.ts'
import { OWN_TILE_BOX, TILE_INBOX, drawsOwnTile, tileHidesPage, tileReadouts } from '../src/host/tile.ts'
import { expandAsked } from '../src/host/expand.ts'
import { TILE_BELOW } from 'kehikot-module-protocol'

/*
 * A container as a tile (`host/columns.ts`, `host/tile.ts`): a state like a fold, drawn as a small
 * square, restored to exactly the size and place it had; the host's tile for every module; an
 * agent's tile at the door, marked and put back with one press; and the Appearance setting.
 */

const box = (over: Partial<Wished> & { i: string }): Wished => ({ x: 0, y: 0, w: 8, h: 20, wish: 20, collapsed: false, ...over })

describe('a tile is a state, drawn as a small square', () => {
  test('made a tile: drawn at a tile’s width and height, its width and wish kept', () => {
    const [tile] = tiledTo([box({ i: 'a', w: 10, h: 30, wish: 30 })], { tile: ['a'] })
    expect(tile).toMatchObject({ i: 'a', tiled: true, collapsed: false, w: 10, wish: 30, h: TILE_ROWS })
    expect(drawnWidth(tile!)).toBe(TILE_COLUMNS)
    expect(drawnWidth({ w: 2, tiled: true })).toBe(2)
  })

  test('restore returns it to exactly the size and place it had', () => {
    const before = arranged([
      box({ i: 'a', x: 0, y: 0, w: 10, h: 30, wish: 30 }),
      box({ i: 'b', x: 10, y: 0, w: 14, h: 26, wish: 26 }),
      box({ i: 'c', x: 0, y: 30, w: 24, h: 20, wish: 20 }),
    ])
    const tiled = arranged(tiledTo(before, { tile: ['a'] }))
    expect(tiled.find((p) => p.i === 'a')).toMatchObject({ x: 0, y: 0, w: 10, h: TILE_ROWS, tiled: true })
    /* The full-width container under it moves up under the tallest thing above it. */
    expect(tiled.find((p) => p.i === 'c')!.y).toBe(26)
    const back = arranged(tiledTo(tiled, { untile: ['a'] }))
    expect(back).toEqual(before)
  })

  test('the room a tile leaves beside it is given to what is under it', () => {
    const placements = arranged(tiledTo([box({ i: 'a', x: 0, y: 0, w: 12, h: 30, wish: 30 }), box({ i: 'b', x: 6, y: 30, w: 6, h: 10, wish: 10 })], { tile: ['a'] }))
    /* Columns 6 to 11 are no longer under the tile: `b` is drawn at the top. */
    expect(placements.find((p) => p.i === 'b')!.y).toBe(0)
  })

  test('a folded container is unfolded into its tile; folding or unfolding a tile takes the tile away', () => {
    const [made] = tiledTo([box({ i: 'a', collapsed: true, h: 2 })], { tile: ['a'] })
    expect(made).toMatchObject({ tiled: true, collapsed: false })
    const [foldedTile] = folded([made!], { fold: ['a'] })
    expect(foldedTile!.tiled).toBeUndefined()
    expect(foldedTile!.collapsed).toBe(true)
    const [opened] = folded([made!], { unfold: ['a'] })
    expect(opened!.tiled).toBeUndefined()
    expect(opened).toMatchObject({ collapsed: false, h: 20, w: 8 })
  })

  test('a tile dragged near the right edge is moved in only as far as its own width needs, on restore', () => {
    const [back] = tiledTo([box({ i: 'a', x: COLUMNS - TILE_COLUMNS, w: 10, tiled: true })], { untile: ['a'] })
    expect(back).toMatchObject({ x: COLUMNS - 10, w: 10 })
  })

  test('every module can be tiled', () => {
    const list = JSON.parse(readFileSync(join(import.meta.dir, '..', 'modules.json'), 'utf8')) as { modules?: { id: string }[] } | { id: string }[]
    const ids = (Array.isArray(list) ? list : (list.modules ?? [])).map((one) => one.id)
    expect(ids.length).toBeGreaterThan(3)
    /* Eight across, as many rows as it takes: every tile fits the canvas's fifty-six rows. */
    const placements = ids.map((i, at) => box({ i, x: (at % 8) * 3, y: Math.floor(at / 8) * 20, w: 3 }))
    expect(Math.ceil(ids.length / 8) * TILE_ROWS).toBeLessThanOrEqual(56)
    const tiles = tiledTo(placements, { tile: ids })
    const heights = granted(tiles)
    for (const one of tiles) {
      expect(one.tiled).toBe(true)
      expect(heights.get(one.i)).toBe(TILE_ROWS)
    }
    expect(tiledTo(tiles, { untile: ids }).map(({ i, x, w, wish, tiled }) => ({ i, x, w, wish, tiled }))).toEqual(
      placements.map(({ i, x, w, wish }) => ({ i, x, w, wish, tiled: undefined })),
    )
  })

  test('what the grid reports for a tile keeps the width it is restored to', () => {
    const was = [{ ...box({ i: 'a', w: 10, tiled: true, h: TILE_ROWS }), grow: false, pinned: false, prompt: '', promptFor: null, selected: false, filters: {}, refreshEvery: null, version: null, scope: null }]
    const [next] = fromGrid(was, [{ i: 'a', x: 4, y: 0, w: TILE_COLUMNS, h: TILE_ROWS }], 'a', new Map())
    expect(next).toMatchObject({ i: 'a', x: 4, w: 10, wish: 20, tiled: true, collapsed: false })
  })

  test('a tile made or restored glides, and neighbours read it as out of view', () => {
    expect(foldsOnlyChanged([{ i: 'a' }], [{ i: 'a', tiled: true }])).toBe(true)
    expect(foldsOnlyChanged([{ i: 'a', tiled: true }], [{ i: 'a', tiled: true }])).toBe(false)
    const rows = containersOf({ placements: [{ i: 'a', x: 0, y: 0, selected: false, collapsed: false, tiled: true }], said: {}, pointed: {}, selectedBy: null, selection: [] } as never)
    expect(rows[0]!.folded).toBe(true)
  })
})

describe('what the host’s tile says', () => {
  const footer = footerItemsSchema.parse([
    { kind: 'text', id: 'later', text: 'optional words', optional: true },
    { kind: 'meter', id: 'usage', label: 'Usage', value: 0.4 },
    { kind: 'text', id: 'state', text: 'Synced' },
    { kind: 'run', id: 'retry', label: 'Retry' },
    { kind: 'text', id: 'alarm', text: '2 failed', level: 'critical' },
  ])

  test('the footer’s text readouts, the ones that matter first, at most two', () => {
    expect(tileReadouts(footer).map((one) => one.text)).toEqual(['2 failed', 'Synced'])
    expect(tileReadouts([])).toEqual([])
  })

  test('the Inbox state in words', () => {
    expect(TILE_INBOX.attention).toBe('Needs you')
    expect(TILE_INBOX.working).toBe('Working')
  })

  test('a module that asks to be shown large draws its own tile, and gets room under the protocol’s line for it', () => {
    expect(drawsOwnTile({ declares: { uses: ['view:expand', 'activity:report'] } })).toBe(true)
    expect(drawsOwnTile({ declares: { uses: ['activity:report'] } })).toBe(false)
    expect(drawsOwnTile(null)).toBe(false)
    expect(OWN_TILE_BOX.width).toBeLessThan(TILE_BELOW.width)
    expect(OWN_TILE_BOX.height).toBeLessThan(TILE_BELOW.height)
  })
})

describe('Expand on a tile', () => {
  test('the host’s tile hides the page until it is shown large; a module’s own tile shows it', () => {
    expect(tileHidesPage({ tiled: true }, false, false)).toBe(true)
    expect(tileHidesPage({ tiled: true }, false, true)).toBe(false)
    expect(tileHidesPage({ tiled: true }, true, false)).toBe(false)
    expect(tileHidesPage({}, false, false)).toBe(false)
  })

  test('a press on a module’s own tile is expanded: the tile is on the open kehikko and showing its page', () => {
    const onOpen = !tileHidesPage({ tiled: true }, true, false)
    expect(expandAsked(null, { from: 'example.agent', expand: true, pressed: true, kehikko: 3, onOpen }).result.outcome).toBe('expanded')
  })
})

describe('the collapse button’s setting', () => {
  test('folds by default; makes a tile when chosen; anything else is refused', () => {
    expect(APPEARANCE_DEFAULT.collapse).toBe('fold')
    expect(appearanceIn({ collapse: 'tile' }).collapse).toBe('tile')
    expect(appearanceIn({ collapse: 'cube' }).collapse).toBe('fold')
    expect(appearancePatched(APPEARANCE_DEFAULT, { collapse: 'tile' })).toEqual({ ...APPEARANCE_DEFAULT, collapse: 'tile' })
    expect(appearancePatched(APPEARANCE_DEFAULT, { collapse: 'cube' })).toBeNull()
  })
})

describe('marks: a tile made by somebody else', () => {
  test('a note with tiles is read, signed, and stands while the tile does', () => {
    const note = foldNoteIn({ by: 'an agent', fold: [], unfold: [], tile: ['a'] })!
    expect(note).toEqual({ by: 'an agent', fold: [], unfold: [], tile: ['a'] })
    expect(foldNoteIn({ by: 'an agent', fold: [], unfold: [] })).toEqual({ by: 'an agent', fold: [], unfold: [] })
    const marks = noted({}, note)
    expect(marks).toEqual({ a: { by: 'an agent', collapsed: false, tiled: true } })
    expect(signedBy(marks, { i: 'a', collapsed: false, tiled: true })).toBe('an agent')
    expect(signedBy(marks, { i: 'a', collapsed: false })).toBeNull()
    expect(standing(marks, [{ i: 'a', collapsed: false }])).toEqual({})
    expect(standing(marks, [{ i: 'a', collapsed: false, tiled: true }])).toBe(marks)
    /* Put back by the same hand: the mark goes. */
    expect(noted(marks, { by: 'an agent', fold: [], unfold: ['a'] })).toEqual({})
  })

  test('the restore control says who and what a press does', () => {
    expect(tileHint(true, null)).toContain('Press to put it back at the size and place it had')
    expect(tileHint(true, 'an agent')).toStartWith('made a tile by an agent')
    expect(tileHint(false, null)).toStartWith('make a tile of it')
  })

  test('a module’s view.fold unfold puts a tile back', () => {
    const placements = [box({ i: 'me' }), box({ i: 'a', x: 8, tiled: true, h: TILE_ROWS })]
    const out = asked(placements, 'me', { fold: [], unfold: ['a'] }, null)
    expect(out.outcome).toBe('changed')
    expect(out.unfolded).toEqual(['a'])
    expect(out.placements.find((p) => p.i === 'a')!.tiled).toBeUndefined()
  })
})

describe('kept like a fold', () => {
  let db: Database
  let folder: string
  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-tile-'))
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  function aCanvas(placements: (Partial<Placement> & { i: string })[]): number {
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    const made = createCanvas(db, 'the wire', added.project.id)
    editCanvas(db, made.id, { placements: placements as Placement[] })
    return made.id
  }
  const now = (id: number) => listCanvases(db).find((c) => c.id === id)!

  test('stored per placement, never with a fold, read back; personal, and written to the shared file untiled', () => {
    const id = aCanvas([
      { i: 'a.one', x: 0, y: 0, w: 10, h: TILE_ROWS, wish: 30, tiled: true },
      { i: 'a.two', x: 10, y: 0, w: 6, h: 2, wish: 20, collapsed: true, tiled: true },
    ])
    const [one, two] = now(id).placements
    expect(one).toMatchObject({ i: 'a.one', tiled: true, w: 10, wish: 30 })
    expect(two!.tiled).toBeUndefined()
    expect(two!.collapsed).toBe(true)
    const layout = shared(now(id).placements)
    expect(layout[0]).toMatchObject({ i: 'a.one', w: 10, h: 30, collapsed: false })
    expect(layout[0]!.tiled).toBeUndefined()
    const view = viewOf([now(id)], { epic: null, parts: [], selection: [] })
    expect([...view.kehikot.values()][0]!.get('a.one')).toMatchObject({ tiled: true })
  })

  test('an agent makes a tile at the door, marked, and unfold puts it back', async () => {
    const openness = new Openness()
    const notes: (FoldNote | undefined)[] = []
    const seen: Sighting[] = [{ id: 'a.one', name: 'One', condition: 'ready' }]
    const id = aCanvas([{ i: 'a.one', x: 0, y: 0, w: 10, h: 30, wish: 30 }])
    openness.reported(`page-${id}`, id)
    const door: Door = {
      db,
      which: () => openness.open(),
      watched: () => openness.every(),
      wake: (_kehikko, note) => void notes.push(note),
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      seen: async () => seen,
    }
    const made = await call('fold_modules', { kehikko: id, tile: ['a.one'] }, door)
    expect(made.failed).toBe(false)
    expect(made.text).toContain('made a.one a tile.')
    expect(made.text).toContain('fold_modules with unfold: ["a.one"]')
    expect(made.text).toContain('a.one (One) — a tile')
    expect(notes).toEqual([{ by: 'an agent', fold: [], unfold: [], tile: ['a.one'] }])
    expect(now(id).placements[0]).toMatchObject({ tiled: true, w: 10, wish: 30, h: TILE_ROWS })
    const back = await call('fold_modules', { kehikko: id, unfold: ['a.one'] }, door)
    expect(back.failed).toBe(false)
    expect(back.text).toContain('fold_modules with tile: ["a.one"]')
    expect(now(id).placements[0]).toMatchObject({ x: 0, w: 10, h: 30, wish: 30 })
    expect(now(id).placements[0]!.tiled).toBeUndefined()
  })
})
