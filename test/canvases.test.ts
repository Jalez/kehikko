import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'

import {
  canvasesHolding,
  createCanvas,
  databaseFile,
  deleteCanvas,
  editCanvas,
  ensureCanvases,
  listCanvases,
  open,
} from '../server/canvases.ts'

/**
 * The canvases survive everything: a reload, a restart, a cleared browser.
 *
 * That is the whole reason there is a database, and most of what is below is
 * about the second half of that sentence — the arrangement used to live in
 * `localStorage`, where clearing a browser destroyed work somebody named.
 */

let db: Database
beforeEach(() => {
  db = open(':memory:')
})
afterEach(() => {
  db.close()
})

describe('a canvas is a name and an arrangement', () => {
  test('what is written comes back', () => {
    const made = createCanvas(db, 'the wire')
    editCanvas(db, made.id, {
      epic: 'modes-are-modules',
      placements: [
        { i: 'roadmap.atlas', x: 0, y: 0, w: 5, h: 12 },
        { i: 'roadmap.references', x: 5, y: 0, w: 7, h: 20 },
      ],
    })

    const [canvas] = listCanvases(db)
    expect(canvas?.name).toBe('the wire')
    expect(canvas?.epic).toBe('modes-are-modules')
    expect(canvas?.placements).toEqual([
      { i: 'roadmap.atlas', x: 0, y: 0, w: 5, h: 12 },
      { i: 'roadmap.references', x: 5, y: 0, w: 7, h: 20 },
    ])
  })

  test('a rearrangement replaces the arrangement rather than adding to it', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    editCanvas(db, made.id, { placements: [{ i: 'a.two', x: 0, y: 0, w: 6, h: 10 }] })

    expect(listCanvases(db)[0]?.placements.map((p) => p.i)).toEqual(['a.two'])
  })

  test('an edit that names nothing changes nothing', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 1, y: 2, w: 6, h: 10 }] })
    editCanvas(db, made.id, {})

    const [canvas] = listCanvases(db)
    expect(canvas?.name).toBe('one')
    expect(canvas?.placements).toHaveLength(1)
  })

  test('the subject can be cleared, which is different from not mentioning it', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { epic: 'modes-are-modules' })
    editCanvas(db, made.id, { epic: null })
    expect(listCanvases(db)[0]?.epic).toBeNull()
  })

  test('editing a canvas that is not there says so instead of making one', () => {
    expect(editCanvas(db, 999, { name: 'ghost' })).toBeNull()
    expect(listCanvases(db)).toHaveLength(0)
  })
})

describe('a name that is only spaces is a slip of the hand, not a rename', () => {
  test('the previous name is kept', () => {
    const made = createCanvas(db, 'the wire')
    editCanvas(db, made.id, { name: '   ' })
    expect(listCanvases(db)[0]?.name).toBe('the wire')
  })

  test('a new canvas with no name given still has one', () => {
    expect(createCanvas(db).name).toBe('canvas')
    expect(createCanvas(db, '  ').name).toBe('canvas')
  })

  test('a name is trimmed and bounded, because it is shown in a switcher', () => {
    const made = createCanvas(db, `  ${'x'.repeat(200)}  `)
    expect(made.name.length).toBe(60)
  })
})

describe('what arrives over HTTP is not what is written', () => {
  test('a placement naming something that is not a module id is dropped', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [
        { i: 'Not An Id', x: 0, y: 0, w: 6, h: 10 },
        { i: 'a.fine', x: 0, y: 0, w: 6, h: 10 },
      ],
    })
    expect(listCanvases(db)[0]?.placements.map((p) => p.i)).toEqual(['a.fine'])
  })

  test('the same module twice is once, because a canvas cannot show two of it', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [
        { i: 'a.one', x: 0, y: 0, w: 6, h: 10 },
        { i: 'a.one', x: 6, y: 0, w: 6, h: 10 },
      ],
    })
    expect(listCanvases(db)[0]?.placements).toHaveLength(1)
  })

  test('a rectangle no host could lay out is brought back into range', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [{ i: 'a.one', x: -5, y: 0, w: 0, h: 1e9 } as never],
    })
    expect(listCanvases(db)[0]?.placements[0]).toEqual({ i: 'a.one', x: 0, y: 0, w: 1, h: 400 })
  })

  test('a number that is not one does not become NaN in the database', () => {
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [{ i: 'a.one', x: 'over there', y: null, w: undefined, h: 5 } as never],
    })
    expect(listCanvases(db)[0]?.placements[0]).toEqual({ i: 'a.one', x: 0, y: 0, w: 1, h: 5 })
  })
})

describe('removing a canvas', () => {
  test('its placements go with it, so nothing is left keyed to a canvas that is gone', () => {
    const one = createCanvas(db, 'one')
    const two = createCanvas(db, 'two')
    editCanvas(db, one.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    editCanvas(db, two.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })

    expect(deleteCanvas(db, one.id)).toBe('deleted')
    expect(canvasesHolding(db, 'a.one')).toEqual([two.id])
  })

  test('the only canvas is refused, because this host with no canvas has no state to be in', () => {
    const only = createCanvas(db, 'one')
    expect(deleteCanvas(db, only.id)).toBe('the-last-one')
    expect(listCanvases(db)).toHaveLength(1)
  })

  test('a canvas that is not there is said so rather than reported as removed', () => {
    createCanvas(db, 'one')
    createCanvas(db, 'two')
    expect(deleteCanvas(db, 999)).toBe('no-such-canvas')
  })
})

describe('a first run has a canvas without anybody making one', () => {
  test('an empty database gets exactly one', () => {
    expect(ensureCanvases(db)).toHaveLength(1)
    /* And asking twice does not make a second. */
    expect(ensureCanvases(db)).toHaveLength(1)
  })

  test('a database with canvases in it is left exactly as it is', () => {
    createCanvas(db, 'mine')
    expect(ensureCanvases(db).map((canvas) => canvas.name)).toEqual(['mine'])
  })
})

describe('which canvases hold a module, which is why placements are rows', () => {
  test('a module on two canvases is reported on both', () => {
    const one = createCanvas(db, 'one')
    const two = createCanvas(db, 'two')
    editCanvas(db, one.id, { placements: [{ i: 'a.shared', x: 0, y: 0, w: 6, h: 10 }] })
    editCanvas(db, two.id, { placements: [{ i: 'a.shared', x: 0, y: 0, w: 6, h: 10 }] })

    expect(canvasesHolding(db, 'a.shared')).toEqual([one.id, two.id])
    expect(canvasesHolding(db, 'a.elsewhere')).toEqual([])
  })
})

describe('canvases are shown in the order they were made', () => {
  test('a new one goes last, where a person looks for a thing they just made', () => {
    createCanvas(db, 'one')
    createCanvas(db, 'two')
    createCanvas(db, 'three')
    expect(listCanvases(db).map((canvas) => canvas.name)).toEqual(['one', 'two', 'three'])
  })
})

describe('where the file is', () => {
  test('the environment can move it, which is what makes this testable', () => {
    expect(databaseFile({ ROADMAP_FRAME_DB: '/tmp/somewhere.sqlite' })).toBe('/tmp/somewhere.sqlite')
    expect(databaseFile({})).toMatch(/\.roadmap\/frame\.sqlite$/)
  })
})
