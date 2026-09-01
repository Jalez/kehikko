import { describe, expect, test } from 'bun:test'
import { REFRESH_EVERY_MAX, REFRESH_EVERY_MIN } from 'roadmap-module-protocol'

import { Presses } from '../src/host/presses.ts'
import { createCanvas, editCanvas, listCanvases, open } from '../server/canvases.ts'

/**
 * The host's half of the refresh contract, which is two things and neither is
 * the reading.
 *
 * A module says it can be read again and when it last was — its own fact about
 * its own data, which this host never checks and never infers. The host owns
 * the control, the press, and the interval, and the interval is the part that
 * has to survive quitting the app.
 *
 * What is worth testing without a browser is the seam: that a press reaches a
 * frame or reaches nothing, and that an interval is stored, bounded, and
 * defaulted to off.
 */

describe('a press, and the frame that is standing when it happens', () => {
  test('a refresh reaches the frame that joined', () => {
    const presses = new Presses()
    let asked = 0
    presses.join('a.one', { clear: () => {}, refresh: () => (asked += 1) })
    expect(presses.refresh('a.one')).toBe(true)
    expect(asked).toBe(1)
  })

  /*
   * The whole reason this is a registry rather than a prop. A container removed
   * between a person's press and the frame's teardown — or an interval that
   * fires a second after somebody took the container off the canvas — must be
   * silence, not a message posted into a window that has gone.
   */
  test('and a refresh at a frame that has left reaches nothing at all', () => {
    const presses = new Presses()
    presses.join('a.one', { clear: () => {}, refresh: () => {} })
    presses.leave('a.one')
    expect(presses.refresh('a.one')).toBe(false)
  })

  /*
   * Two methods rather than one taking a verb, and this is the reason: one of
   * these destroys somebody's records and the other spends a subprocess. A
   * single `press(id, what)` would be one place where a wrong string does the
   * wrong one of those, and no compiler could say so.
   */
  test('refreshing is not clearing', () => {
    const presses = new Presses()
    const done: string[] = []
    presses.join('a.one', { clear: () => done.push('clear'), refresh: () => done.push('refresh') })
    presses.refresh('a.one')
    presses.press('a.one')
    expect(done).toEqual(['refresh', 'clear'])
  })

  test('a module nobody has ever heard of is silence in both directions', () => {
    const presses = new Presses()
    expect(presses.refresh('a.nobody')).toBe(false)
    expect(presses.press('a.nobody')).toBe(false)
  })
})

describe('how often a container reads, which is the placement’s and not the module’s', () => {
  const fresh = () => open(':memory:')

  test('a container arrives on no clock at all', () => {
    /* Not on a clock is the ordinary state and the honest default: a container
       that arrived refreshing itself every five minutes would be spending
       somebody's rate limit on a decision they never made. */
    const db = fresh()
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    expect(listCanvases(db)[0]?.placements[0]?.refreshEvery).toBeNull()
  })

  test('an interval survives being written and read back', () => {
    const db = fresh()
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10, refreshEvery: 15 }] })
    expect(listCanvases(db)[0]?.placements[0]?.refreshEvery).toBe(15)
  })

  test('and reopening the database is what it is for', () => {
    /* The requirement that rules out every other place this could have lived:
       the module is not always running, and `localStorage` is per browser. */
    const db = fresh()
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10, refreshEvery: 5 }] })
    const rows = listCanvases(db)
    expect(rows[0]?.placements[0]?.refreshEvery).toBe(5)
  })

  /*
   * Bounded on the way in, because the thing on the other end of this number
   * spends a subprocess or somebody's rate limit every time it fires. A person
   * who typed 5000 meant "rarely", and a day is this protocol's word for that.
   */
  test('an interval nothing could sensibly act on is brought into range', () => {
    const db = fresh()
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [
        { i: 'a.fast', x: 0, y: 0, w: 6, h: 10, refreshEvery: 0.2 },
        { i: 'a.slow', x: 0, y: 10, w: 6, h: 10, refreshEvery: 100000 },
      ],
    })
    const placed = listCanvases(db)[0]?.placements ?? []
    expect(placed.find((p) => p.i === 'a.fast')?.refreshEvery).toBe(REFRESH_EVERY_MIN)
    expect(placed.find((p) => p.i === 'a.slow')?.refreshEvery).toBe(REFRESH_EVERY_MAX)
  })

  /*
   * Zero is not an interval, it is the absence of one, and it must not become
   * `REFRESH_EVERY_MIN` by clamping — somebody who sent 0 was saying "off", and
   * turning that into "every minute" is the loudest possible misreading.
   */
  test('zero and rubbish are off rather than clamped to the fastest setting', () => {
    const db = fresh()
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, {
      placements: [
        { i: 'a.zero', x: 0, y: 0, w: 6, h: 10, refreshEvery: 0 },
        { i: 'a.words', x: 0, y: 10, w: 6, h: 10, refreshEvery: 'often' as never },
        { i: 'a.minus', x: 0, y: 20, w: 6, h: 10, refreshEvery: -30 },
      ],
    })
    for (const placement of listCanvases(db)[0]?.placements ?? []) {
      expect(placement.refreshEvery).toBeNull()
    }
  })

  test('an arrangement written before this existed reads as off', () => {
    /* Every canvas on somebody's machine today. A missing column is not an
       error; it is what those containers have been doing all along. */
    const db = fresh()
    const made = createCanvas(db, 'one')
    editCanvas(db, made.id, { placements: [{ i: 'a.one', x: 0, y: 0, w: 6, h: 10 }] })
    db.query('update placements set refresh_every = null').run()
    expect(listCanvases(db)[0]?.placements[0]?.refreshEvery).toBeNull()
  })
})
