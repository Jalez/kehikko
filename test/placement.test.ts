import { describe, expect, test } from 'bun:test'

import {
  chooseOpen,
  everyPlaced,
  OPEN_KEY,
  place,
  readOpen,
  reconcile,
  unplace,
  writeOpen,
  type Canvas,
} from '@/host/canvases.ts'

/**
 * The page's half of the canvases: where a pane lands, what comes off, and
 * which canvas opens.
 *
 * The arrangement itself is the server's to keep — see `canvases.test.ts`.
 * These are the rules the page applies before it sends anything, and they are
 * here because every one of them is a decision a person would notice.
 */

const canvas = (id: number, ...ids: string[]): Canvas => ({
  id,
  name: `canvas ${id}`,
  epic: null,
  project: null,
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

describe('reconciling with what is actually registered', () => {
  test('a module whose registration is gone comes off: it is not silent, it is not here', () => {
    const both = place(place([], 'a.one'), 'a.two')
    expect(reconcile(both, ['a.two']).map((p) => p.i)).toEqual(['a.two'])
  })

  test("a new registration does not rearrange somebody's canvas underneath them", () => {
    const one = place([], 'a.one')
    expect(reconcile(one, ['a.one', 'a.new']).map((p) => p.i)).toEqual(['a.one'])
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
