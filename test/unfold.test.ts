import { describe, expect, test } from 'bun:test'

import { unfoldedByResize } from '../src/host/canvases.ts'

/**
 * Pulling the corner of a folded container.
 *
 * The bug this rule fixes was not that something threw — it was that the grid
 * and the container disagreed about what had happened, silently. The grid took
 * the new height; the container kept `collapsed` and drew its header into it;
 * a gap appeared, and the handle looked broken.
 *
 * The edges below are all about the same thing: `h` arrives for EVERY container on
 * every drag, so the rule has to tell a deliberate pull from the constant noise
 * of somebody moving a neighbour.
 */

const FOLDED = 1

describe('a folded container being dragged taller', () => {
  test('opens it', () => {
    expect(unfoldedByResize({ collapsed: true }, 6, FOLDED)).toBe(true)
  })

  test('one row taller is still a request', () => {
    /* Nobody drags precisely; the smallest movement that changes the height is
       as much a "let me see this" as a big one. */
    expect(unfoldedByResize({ collapsed: true }, FOLDED + 1, FOLDED)).toBe(true)
  })
})

describe('what must NOT open it', () => {
  test('a container that is not folded', () => {
    expect(unfoldedByResize({ collapsed: false }, 12, FOLDED)).toBe(false)
  })

  test('the same height arriving again', () => {
    /* This is the common case, not an edge: react-grid-layout reports the whole
       layout on every drag, so a folded container's unchanged height arrives
       dozens of times while somebody moves the container next to it. Treating that
       as a request would unfold containers nobody touched. */
    expect(unfoldedByResize({ collapsed: true }, FOLDED, FOLDED)).toBe(false)
  })

  test('a smaller height', () => {
    /* It cannot be a request to see more, and a folded container cannot usefully
       get shorter than one row. */
    expect(unfoldedByResize({ collapsed: true }, 0, FOLDED)).toBe(false)
  })

  test('a container the layout has never seen before', () => {
    /* A container added this render has nothing stored, and `undefined` must not
       read as folded. */
    expect(unfoldedByResize(undefined, 9, FOLDED)).toBe(false)
  })

  test('a stored container with no collapsed field at all', () => {
    /* Rows written before folding existed. */
    expect(unfoldedByResize({}, 9, FOLDED)).toBe(false)
  })
})
