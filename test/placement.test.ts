import { describe, expect, test } from 'bun:test'

import {
  chooseOpen,
  everyPlaced,
  OPEN_KEY,
  place,
  readOpen,
  unplace,
  writeOpen,
  type Canvas,
} from '@/host/canvases.ts'

/**
 * The page's half of the canvases: where a container lands, what comes off, and
 * which canvas opens.
 *
 * The arrangement itself is the server's to keep — see `canvases.test.ts`.
 * These are the rules the page applies before it sends anything, and they are
 * here because every one of them is a decision a person would notice.
 */

const canvas = (id: number, ...ids: string[]): Canvas => ({
  id,
  name: `canvas ${id}`,
  project: null,
  connections: { off: [], only: [] },
  placements: ids.reduce<Canvas['placements']>((acc, i) => place(acc, i), []),
})

describe('putting things on the canvas and taking them off', () => {
  test('the first module goes top left', () => {
    expect(place([], 'a.one')[0]).toMatchObject({ i: 'a.one', x: 0, y: 0 })
  })

  test('the next goes beside it while the row has room', () => {
    const placements = place(place([], 'a.one'), 'a.two')
    expect(placements[1]).toMatchObject({ i: 'a.two', x: placements[0]!.w, y: 0 })
  })

  test('and on a new row below when it does not', () => {
    const three = place(place(place([], 'a.one'), 'a.two'), 'a.three')
    expect(three[2]).toMatchObject({ i: 'a.three', x: 0, y: three[0]!.h })
  })

  test('placing the same module twice does not put two of it on the canvas', () => {
    const once = place([], 'a.one')
    expect(place(once, 'a.one')).toEqual(once)
  })

  test('removing takes it away and leaves everything else where it was', () => {
    const both = place(place([], 'a.one'), 'a.two')
    expect(unplace(both, 'a.one')).toEqual(both.filter((p) => p.i === 'a.two'))
  })
})

const at = (i: string, x: number, y: number, w: number, h: number, collapsed = false) => ({
  ...place([], i)[0]!,
  x,
  y,
  w,
  h,
  wish: h,
  collapsed,
})
const spot = (placements: ReturnType<typeof place>, id: string) => {
  const { x, y, w, h } = placements.find((p) => p.i === id)!
  return { x, y, w, h }
}

describe('a new module takes the first free space that fits, in reading order', () => {
  test('an empty canvas: top left, twelve by twenty', () => {
    expect(spot(place([], 'n'), 'n')).toEqual({ x: 0, y: 0, w: 12, h: 20 })
  })

  test('a hole beside the first container is taken before the bottom row', () => {
    const holed = [at('a', 0, 0, 12, 20), at('c', 0, 20, 24, 12), at('e', 12, 32, 12, 24)]
    expect(spot(place(holed, 'n'), 'n')).toEqual({ x: 12, y: 0, w: 12, h: 20 })
  })

  test('a hole in the middle, first in reading order', () => {
    const board = [at('a', 0, 0, 24, 8), at('b', 0, 8, 6, 48), at('c', 18, 8, 6, 48), at('d', 0, 28, 24, 28)]
    /* Between b and c, rows 8..28, twelve columns of twenty: exactly one fit, x 6. */
    const placed = place(board, 'n')
    expect(spot(placed, 'n')).toEqual({ x: 6, y: 8, w: 12, h: 20 })
  })

  test('a hole too small for the usual size is shaped to the gap, capped at the usual size', () => {
    const board = [at('a', 0, 0, 24, 8), at('b', 0, 8, 8, 36), at('c', 18, 8, 6, 36), at('d', 0, 44, 24, 12)]
    /* Gap is x 8..18 (ten wide), rows 8..44 (thirty-six): ten by twenty. */
    const shaped = place(board, 'n')
    expect(spot(shaped, 'n')).toEqual({ x: 8, y: 8, w: 10, h: 20 })
    expect(shaped.find((p) => p.i === 'n')!.wish).toBe(20)
  })

  test('a gap shorter than the least is not used', () => {
    /* Columns 8..15 are free for rows 20..30 only: eight wide, but ten tall. */
    const board = [at('e', 0, 0, 8, 56), at('c', 8, 0, 8, 20), at('f', 16, 0, 8, 30), at('d', 8, 30, 16, 26)]
    expect(spot(place(board, 'n'), 'n')).toEqual({ x: 0, y: 56, w: 12, h: 20 })
  })

  test('a gap the grid would collapse is not a gap', () => {
    /* b is stored at row 30 but drawn at row 20, so there is no hole from 20 to 30. */
    const board = [at('a', 0, 0, 24, 20), at('b', 0, 30, 24, 20)]
    const placed = place(board, 'n')
    expect(spot(placed, 'n')).toEqual({ x: 0, y: 40, w: 12, h: 16 })
  })

  test('a folded container is its header, and the space under it is free', () => {
    const board = [at('a', 0, 0, 24, 20, true), at('b', 0, 2, 12, 20)]
    expect(spot(place(board, 'n'), 'n')).toEqual({ x: 12, y: 2, w: 12, h: 20 })
  })

  test('nothing fits: the old rule, beside the last or a new row', () => {
    const full = [at('a', 0, 0, 24, 28), at('b', 0, 28, 24, 28)]
    const placed = place(full, 'n')
    expect(spot(placed, 'n').x).toBe(0)
    expect(spot(placed, 'n').y).toBe(56)
    const nearly = [at('a', 0, 0, 24, 28), at('b', 0, 28, 20, 28)]
    expect(spot(place(nearly, 'n'), 'n')).toEqual({ x: 0, y: 56, w: 12, h: 20 })
  })

  test('several in a row each take the next gap', () => {
    const board = [at('a', 0, 0, 24, 8), at('b', 0, 8, 6, 48), at('c', 18, 8, 6, 48)]
    const one = place(board, 'n1')
    expect(spot(one, 'n1')).toEqual({ x: 6, y: 8, w: 12, h: 20 })
    const two = place(one, 'n2')
    expect(spot(two, 'n2')).toEqual({ x: 6, y: 28, w: 12, h: 20 })
    const three = place(two, 'n3')
    /* The gap is used up (eight rows are left under them), so the old rule: a new row. */
    expect(spot(three, 'n3')).toEqual({ x: 0, y: 56, w: 12, h: 20 })
    /* None of them overlaps another. */
    for (const p of three) {
      for (const q of three) {
        if (p.i >= q.i) continue
        const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y
        expect(apart).toBe(true)
      }
    }
  })

  test('an id already placed is left where it is', () => {
    const board = [at('a', 0, 0, 12, 20)]
    expect(place(board, 'a')).toEqual(board)
  })

  test('the existing containers are returned untouched', () => {
    const board = [at('a', 0, 0, 24, 20), at('b', 0, 30, 24, 20)]
    const placed = place(board, 'n')
    expect(placed.slice(0, 2)).toEqual(board)
  })
})

describe('which canvas opens', () => {
  test('the one this browser had open last', () => {
    const all = [canvas(1), canvas(2), canvas(3)]
    expect(chooseOpen(all, 2)).toBe(2)
  })

  test('the first one, when nothing was remembered', () => {
    expect(chooseOpen([canvas(7), canvas(8)], null)).toBe(7)
  })

  test('the first one, when the remembered canvas was deleted in another window', () => {
    expect(chooseOpen([canvas(7), canvas(8)], 99)).toBe(7)
  })

  test('nothing, when there is nothing — which the server does not allow, but this does not assume', () => {
    expect(chooseOpen([], 3)).toBeNull()
  })
})

describe('remembering the open canvas, which is the one thing kept per browser', () => {
  test('what is written is read back', () => {
    const store = new Map<string, string>()
    const slot = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    writeOpen(slot, 12)
    expect(store.get(OPEN_KEY)).toBe('12')
    expect(readOpen(slot)).toBe(12)
  })

  test('a value that is not a canvas id is nothing remembered, not a crash', () => {
    for (const raw of ['', 'seven', '-1', '1.5', 'NaN', '0']) {
      expect(readOpen({ getItem: () => raw })).toBeNull()
    }
  })

  test('storage that refuses is nothing remembered, and writing does not throw out of a click', () => {
    const refuses = {
      getItem() {
        throw new Error('storage is disabled')
      },
      setItem() {
        throw new Error('storage is disabled')
      },
    }
    expect(readOpen(refuses)).toBeNull()
    expect(() => writeOpen(refuses, 3)).not.toThrow()
  })
})

describe('every module placed anywhere', () => {
  /* The canvas layer loads a module's page once and shows it wherever it was
     put, so it asks about every canvas rather than the open one. */
  test('the union across canvases, without duplicates', () => {
    const all = [canvas(1, 'a.one', 'a.two'), canvas(2, 'a.two', 'a.three')]
    expect(everyPlaced(all)).toEqual(['a.one', 'a.three', 'a.two'])
  })

  test('no canvases is nothing placed', () => {
    expect(everyPlaced([])).toEqual([])
  })
})
