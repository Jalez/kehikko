import { describe, expect, test } from 'bun:test'

import { CANVAS_ROWS, FLOOR_ROW, NOMINAL_ROW, roomBelow, rowHeightFor } from '../src/host/fit.ts'

/**
 * A canvas is twelve columns wide and twenty-eight rows tall, and both of those
 * are COUNTS rather than pixel sizes.
 *
 * That is the third answer to one complaint. The canvas fitted its width and
 * never its height, so an arrangement built on a large screen overflowed a
 * small one forever. Fitting the CONTENT into the window fixed that and made
 * growing one container shrink every other container on the canvas. Holding the
 * fit steady while somebody worked fixed that and brought the overflow back.
 *
 * What makes the width axis work is neither of those: it is that there are
 * twelve columns and nothing can be thirteen wide. So the tests here are about
 * the two properties that follow from a fixed row count, and the first of them
 * is the one that is easiest to lose.
 */

const gap = 8

describe('the row height a canvas draws with', () => {
  /*
   * The property the two earlier versions did not have. Nothing about the
   * arrangement is an argument to this function, so nothing about the
   * arrangement can change its answer — which is what "growing one container
   * cannot shrink another" means when it is written down as code.
   *
   * A test that can only be broken by changing the signature is exactly the
   * test this deserves: the regression was a parameter.
   */
  test('depends on the room and on nothing else', () => {
    const room = 700
    expect(rowHeightFor({ room, gap })).toBe(rowHeightFor({ room, gap }))
    /* And the signature says so. `rowHeightFor` takes a room, a gap, and the
       three constants; there is no extent, no container count, and no height
       anybody asked for. */
    expect(rowHeightFor.length).toBeLessThanOrEqual(4)
  })

  test('nothing measured yet draws at the nominal row', () => {
    expect(rowHeightFor({ room: null, gap })).toBe(NOMINAL_ROW)
  })

  test('and a room of nothing is treated as no measurement', () => {
    expect(rowHeightFor({ room: 0, gap })).toBe(NOMINAL_ROW)
  })

  /*
   * The whole canvas, filled, on any screen — which is what twelve columns do
   * across the width. The old version capped the rows at a nominal 24 and would
   * have left a band at the bottom of a tall screen that no container could be
   * dragged into, because nothing may exceed `CANVAS_ROWS`. Space a person can
   * see and cannot use is a bug.
   */
  test('the rows fill the height they are given, on any screen', () => {
    for (const room of [600, 720, 904, 1200, 1600]) {
      const height = rowHeightFor({ room, gap })
      const drawn = CANVAS_ROWS * height + (CANVAS_ROWS + 1) * gap
      expect(drawn).toBeLessThanOrEqual(room)
      /* And within one row of filling it. What is left over is the remainder of
         an integer division, never a policy. */
      expect(room - drawn).toBeLessThan(CANVAS_ROWS + gap)
    }
  })

  /* Floored, not rounded: half a pixel too tall, times twenty-eight rows, is
     fourteen pixels of overflow — the original complaint by the back door. */
  test('a fit is never rounded up into an overflow', () => {
    for (let room = 600; room <= 1400; room += 7) {
      const height = rowHeightFor({ room, gap })
      if (height > FLOOR_ROW) {
        expect(CANVAS_ROWS * height + (CANVAS_ROWS + 1) * gap).toBeLessThanOrEqual(room)
      }
    }
  })

  /*
   * The gaps are the part a first attempt forgets. A canvas of N rows spends
   * N+1 of them on air — one above the first, one below the last, one between
   * each pair — and fitting only the rows leaves it exactly one gap too tall.
   * At twenty-eight rows that is 232 pixels of air, which is why the floor is
   * reached as early as it is.
   */
  test('the fit counts the air as well as the rows', () => {
    const room = 904
    const height = rowHeightFor({ room, gap })
    expect(CANVAS_ROWS * height + (CANVAS_ROWS + 1) * gap).toBeLessThanOrEqual(room)
    /* 904 is the canvas these arrangements were built on: 28 rows at the old
       nominal 24, plus 29 gaps. It should come back out at exactly 24, which is
       the evidence that 28 is the count this workspace has been using all
       along without writing it down. */
    expect(height).toBe(NOMINAL_ROW)
  })

  /*
   * Shrinking has an end, and below it the canvas scrolls — the only overflow
   * this design leaves. Past this point a container is too short to hold
   * anything a person can read, and scrolling a correct-sized canvas beats
   * seeing all of a useless one. A test that demanded a fit here would be
   * demanding the floor be abandoned.
   */
  test('a canvas too short for twenty-eight readable rows stops at the floor', () => {
    expect(rowHeightFor({ room: 480, gap })).toBe(FLOOR_ROW)
    expect(rowHeightFor({ room: 120, gap })).toBe(FLOOR_ROW)
    expect(rowHeightFor({ room: 10, gap })).toBe(FLOOR_ROW)
  })

  /* Where that boundary is, stated so a change to it is deliberate. Twenty-eight
     rows at the floor, plus twenty-nine gaps, is 568 pixels — but a row of
     thirteen needs 596, so a canvas between the two is at the floor and
     overflows by the remainder. Below 596 pixels of canvas, this scrolls. */
  test('and the boundary is where it says it is', () => {
    expect(rowHeightFor({ room: 592, gap })).toBe(FLOOR_ROW)
    expect(rowHeightFor({ room: 596, gap })).toBeGreaterThan(FLOOR_ROW)
  })
})

/**
 * How tall a container may be, given where its top is.
 *
 * `maxRows` clamps a drag and a resize inside the library, but not the
 * compaction that runs when the HOST writes a placement — and a module asking
 * to grow is the host writing a placement. This is the vertical twin of "a
 * container six wide starting at column eight is clipped to four".
 */
describe('the room left below a container', () => {
  test('a container at the top may fill the canvas', () => {
    expect(roomBelow(0)).toBe(CANVAS_ROWS)
  })

  test('and one further down may not', () => {
    expect(roomBelow(18)).toBe(CANVAS_ROWS - 18)
    expect(roomBelow(CANVAS_ROWS - 1)).toBe(1)
  })

  /* Never zero and never negative. A container is at least one row tall
     whatever the arithmetic says, because a container of no rows is a container
     that has been deleted by a rounding error. */
  test('a container already at or past the bottom still gets one row', () => {
    expect(roomBelow(CANVAS_ROWS)).toBe(1)
    expect(roomBelow(CANVAS_ROWS + 12)).toBe(1)
    expect(roomBelow(-4)).toBe(CANVAS_ROWS)
  })
})
