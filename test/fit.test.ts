import { describe, expect, test } from 'bun:test'

import { CANVAS_ROWS, finer, FLOOR_ROW, NOMINAL_ROW, roomBelow, ROWS_BEFORE, rowHeightFor, rowsHolding } from '../src/host/fit.ts'

/**
 * A canvas is twelve columns wide and fifty-six rows tall, and both of those
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
   * across the width. Capped rows left a band at the bottom of a tall screen
   * that no container could be dragged into, because nothing may exceed
   * `CANVAS_ROWS`; floored rows left one too, up to a pixel a row, at every
   * height that did not divide evenly — the owner's "empty space at the bottom
   * to which you can't expand to". Space a person can see and cannot use is a
   * bug, so the rows and their gaps are the room, exactly.
   */
  test('the rows and their gaps are exactly the room, at every height above the floor', () => {
    for (let room = 568; room <= 2400; room += 1) {
      const height = rowHeightFor({ room, gap })
      const drawn = CANVAS_ROWS * height + (CANVAS_ROWS + 1) * gap
      expect(Math.abs(drawn - room)).toBeLessThan(1e-9)
    }
  })

  /*
   * And what the grid then draws. react-grid-layout places a container at
   * `round((row + gap) * y + gap)` and draws it `round(row * h + gap * (h - 1))`
   * tall — rounding each container on its own, so nothing accumulates. The
   * bottom edge of a container that reaches the last row is then within a
   * pixel of the room less its gap below, and never past the room: no band,
   * and no scrollbar.
   */
  test('a container reaching the last row ends within a pixel of the bottom, and never past it', () => {
    for (let room = 568; room <= 2400; room += 1) {
      const row = rowHeightFor({ room, gap })
      for (const y of [0, 1, 7, 20, 41, CANVAS_ROWS - 2]) {
        const h = CANVAS_ROWS - y
        const top = Math.round((row + gap) * y + gap)
        const bottom = top + Math.round(row * h + gap * (h - 1))
        expect(Math.abs(room - gap - bottom)).toBeLessThanOrEqual(1)
        expect(bottom).toBeLessThanOrEqual(room)
      }
    }
  })

  /*
   * The gaps are the part a first attempt forgets. A canvas of N rows spends
   * N+1 of them on air — one above the first, one below the last, one between
   * each pair — and fitting only the rows leaves it exactly one gap too tall.
   */
  test('the fit counts the air as well as the rows', () => {
    const room = 904
    const height = rowHeightFor({ room, gap })
    expect(CANVAS_ROWS * height + (CANVAS_ROWS + 1) * gap).toBe(room)
    /* 904 is the canvas these arrangements were built on: twenty-eight rows at
       the old nominal 24 plus twenty-nine gaps, which is fifty-six rows at the
       nominal 8 plus fifty-seven. */
    expect(height).toBe(NOMINAL_ROW)
  })

  /*
   * Shrinking has an end, and below it the canvas scrolls — the only overflow
   * this design leaves. Past this point a container is too short to hold
   * anything a person can read, and scrolling a correct-sized canvas beats
   * seeing all of a useless one. A test that demanded a fit here would be
   * demanding the floor be abandoned.
   */
  test('a canvas too short for its rows to be readable stops at the floor', () => {
    expect(rowHeightFor({ room: 480, gap })).toBe(FLOOR_ROW)
    expect(rowHeightFor({ room: 120, gap })).toBe(FLOOR_ROW)
    expect(rowHeightFor({ room: 10, gap })).toBe(FLOOR_ROW)
  })

  /* Where that boundary is, stated so a change to it is deliberate: fifty-six
     rows at the floor, plus fifty-seven gaps, is 568 pixels — where twenty-eight
     rows at the old floor of 12 put it too. */
  test('and the boundary is where it says it is, where it always was', () => {
    expect(rowHeightFor({ room: 567, gap })).toBe(FLOOR_ROW)
    expect(rowHeightFor({ room: 568, gap })).toBe(FLOOR_ROW)
    expect(rowHeightFor({ room: 569, gap })).toBeGreaterThan(FLOOR_ROW)
  })
})

/**
 * Twenty-eight rows became fifty-six, and nothing a person built moved.
 *
 * A container `h` rows tall at row `y` of twenty-eight is, to the pixel, one
 * `2h` tall at row `2y` of fifty-six — the air between two half-rows is the
 * gap the old row spent inside itself. That is what lets every stored
 * placement be doubled once and draw where it drew.
 */
describe('the finer rows', () => {
  test('are a whole multiple of the old ones', () => {
    expect(CANVAS_ROWS % ROWS_BEFORE).toBe(0)
    expect(finer(ROWS_BEFORE)).toBe(CANVAS_ROWS)
    expect(finer(10)).toBe(20)
  })

  test('draw a doubled placement exactly where the old one drew, at every height', () => {
    for (let room = 568; room <= 1600; room += 3) {
      const old = rowHeightFor({ room, gap }, ROWS_BEFORE, 12, 24)
      const now = rowHeightFor({ room, gap })
      for (const [y, h] of [[0, 28], [0, 10], [10, 18], [27, 1], [14, 7]] as const) {
        const oldTop = (old + gap) * y + gap
        const oldHeight = old * h + gap * (h - 1)
        const newTop = (now + gap) * finer(y) + gap
        const newHeight = now * finer(h) + gap * (finer(h) - 1)
        expect(Math.abs(newTop - oldTop)).toBeLessThan(1e-9)
        expect(Math.abs(newHeight - oldHeight)).toBeLessThan(1e-9)
      }
    }
  })
})

/**
 * How many rows a module's request for pixels is — `kehikot.resize`.
 */
describe('the rows that hold a height', () => {
  test('the least that holds it, at a fractional row', () => {
    const row = rowHeightFor({ room: 823, gap })
    for (const h of [1, 2, 3, 10, 20, 41]) {
      const exactly = row * h + gap * (h - 1)
      /* Exactly a container's worth is that container, not one row more. */
      expect(rowsHolding(exactly, row, gap)).toBe(h)
      /* A pixel more needs the next row. */
      expect(rowsHolding(exactly + 1, row, gap)).toBe(h + 1)
    }
  })

  test('and never more than the canvas, nor less than a row', () => {
    expect(rowsHolding(100_000, 8, gap)).toBe(CANVAS_ROWS)
    expect(rowsHolding(0, 8, gap)).toBe(1)
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
    expect(roomBelow(36)).toBe(CANVAS_ROWS - 36)
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
