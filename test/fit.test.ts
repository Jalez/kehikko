import { describe, expect, test } from 'bun:test'

import { FLOOR_ROW, NOMINAL_ROW, rowHeightFor } from '../src/host/fit.ts'

/**
 * The canvas fitted its width and never its height, because columns are a
 * proportion of the room and rows were a fixed 24 pixels. An arrangement built
 * on a large screen therefore overflowed a small one downward, forever.
 */

const gap = 8

describe('the row height a canvas draws with', () => {
  test('nothing measured yet changes nothing', () => {
    expect(rowHeightFor({ room: null, extent: 20, gap })).toBe(NOMINAL_ROW)
  })

  test('an empty canvas changes nothing', () => {
    expect(rowHeightFor({ room: 800, extent: 0, gap })).toBe(NOMINAL_ROW)
  })

  /* Shrink to fit, do not grow to fill. A wide container holds more words per
     line; a tall one mostly holds more empty space, so two small containers
     inflating to a third of a monitor each would be a worse drawing of the
     same arrangement. */
  test('an arrangement with room to spare is left alone', () => {
    expect(rowHeightFor({ room: 2000, extent: 10, gap })).toBe(NOMINAL_ROW)
  })

  test('an arrangement taller than the room is squeezed to fit', () => {
    /* 20 rows at 24 plus 21 gaps is 648; in 600px it has to shrink, and there
       is room to shrink into before the floor. */
    const height = rowHeightFor({ room: 600, extent: 20, gap })
    expect(height).toBeLessThan(NOMINAL_ROW)
    expect(height).toBeGreaterThan(FLOOR_ROW)
    expect(20 * height + 21 * gap).toBeLessThanOrEqual(600)
  })

  /*
   * Below the floor it deliberately does NOT fit, and saying so is the point.
   * Thirty rows in 600px works out at eleven, under the floor, so the answer is
   * the floor and the canvas overflows — fitting has stopped being a service to
   * anybody by then, and scrolling a correct-sized canvas beats seeing all of a
   * useless one. A test that demanded a fit here would be demanding the floor
   * be abandoned.
   */
  test('an arrangement that cannot fit is left overflowing at the floor', () => {
    const height = rowHeightFor({ room: 600, extent: 30, gap })
    expect(height).toBe(FLOOR_ROW)
    expect(30 * height + 31 * gap).toBeGreaterThan(600)
  })

  /*
   * The gaps are the part a first attempt forgets. A canvas of N rows spends
   * N+1 of them on air — one above the first, one below the last, one between
   * each pair — and fitting only the rows leaves it exactly one gap too tall.
   */
  test('the fit counts the air as well as the rows', () => {
    for (const extent of [2, 7, 19, 40]) {
      const height = rowHeightFor({ room: 500, extent, gap })
      /* Only where a fit was possible at all. At the floor there is no fit to
         count the air into — see the test above. */
      if (height > FLOOR_ROW) {
        expect(extent * height + (extent + 1) * gap).toBeLessThanOrEqual(500)
      }
    }
  })

  /* Floored, not rounded: half a pixel too tall times forty rows is twenty
     pixels of overflow, which is the original complaint by the back door. */
  test('a fit is never rounded up into an overflow', () => {
    for (let room = 300; room <= 900; room += 7) {
      const height = rowHeightFor({ room, extent: 17, gap })
      if (height > FLOOR_ROW) expect(17 * height + 18 * gap).toBeLessThanOrEqual(room)
    }
  })

  /* Shrinking has an end. Past it a container is too short to hold anything
     readable, and scrolling a correct-sized canvas beats seeing all of a
     useless one. */
  test('it stops at the floor rather than vanishing', () => {
    expect(rowHeightFor({ room: 120, extent: 40, gap })).toBe(FLOOR_ROW)
    expect(rowHeightFor({ room: 10, extent: 40, gap })).toBe(FLOOR_ROW)
  })

  test('and a room of nothing is treated as no measurement', () => {
    expect(rowHeightFor({ room: 0, extent: 12, gap })).toBe(NOMINAL_ROW)
  })
})
