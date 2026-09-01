import { CANVAS_ROWS } from './fit.ts'

/**
 * A column is a fixed height budget, and growing a container spends it.
 *
 * ## What the owner asked for, and why it is the right shape
 *
 * "What I want to see happen is that if a user expands another module's
 * container height wise, it should take that height from other elements sharing
 * that column."
 *
 * That is the true mirror of the width axis, and it is worth saying why rather
 * than merely doing it. Twelve columns are a fixed budget: a container that
 * takes more width takes it from what is beside it, nothing overflows, and a
 * container in a different row is not consulted. Height should work the same
 * way, with the canvas height as the budget — which `fit.ts` has now made a
 * fixed twenty-eight rows, so there IS a budget to spend.
 *
 * Two earlier answers to the same complaint were wrong and are recorded in
 * `fit.ts`: shrinking every row on the canvas when any container grew (which
 * resized containers with no relationship to the one that moved), and holding
 * the row height steady and letting the canvas scroll (which brought back the
 * overflow the whole exercise started from). Both were about the SCALE. This is
 * about the arrangement, which is where it belongs.
 *
 * ## Why the arithmetic is here and not in the grid
 *
 * `react-grid-layout`'s answer to a collision is to PUSH. Growing a container
 * shoves its column-mate down, and — since compaction does not consult
 * `maxRows` — off the bottom of the canvas. There is no configuration for
 * "take the space from the thing below instead", so the rule has to be written
 * out, and it may as well be written somewhere it can be tested without a
 * browser, a pointer, or a grid.
 *
 * Everything here is pure and takes boxes rather than placements, so a test
 * says `{ i: 'a', x: 0, y: 0, w: 6, h: 10 }` and not a canvas.
 */

/** A container's place on the grid, which is all this file needs to know. */
export interface Box {
  i: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * The least a container may be squeezed to by somebody else's growth.
 *
 * Three rows, and the number is a judgement about what a container still IS.
 * One row is the FOLDED height — a header and nothing under it — and folding is
 * a state a person chooses for a container they want out of the way. Inflicting
 * it on a neighbour because somebody dragged something else would be the host
 * folding a module nobody asked to fold, and it would look like the container
 * had crashed rather than been squeezed.
 *
 * Three rows is a header and something under it at every row height this canvas
 * uses: 88 pixels on the screen these arrangements were built for, and 52 at
 * the floor, against a header of 32. It is deliberately not generous. A
 * neighbour that will not shrink is a growth that stops, and stopping is worse
 * for the person doing the growing than a short container is for the person who
 * is not currently looking at it.
 *
 * A container ALREADY below this — a folded one — is not pushed further and is
 * not expanded either. It simply has nothing to give.
 */
export const SQUEEZED_ROWS = 3

/**
 * Do these two containers share a column?
 *
 * They overlap in x, which is a broader question than "are they in the same
 * column" and deliberately so. Containers are placed by `x` and `w` over twelve
 * columns and nothing partitions those columns into lanes: a container six wide
 * at x=0 shares columns with a container three wide at x=0, with one three wide
 * at x=3, and with a full-width one at x=0 w=12. On the canvases in this
 * workspace right now, one kehikko has a twelve-wide container underneath a
 * five-wide and a seven-wide, and any rule that assumed lanes would have said
 * those three were unrelated.
 *
 * Note what follows: sharing is NOT transitive. A overlapping B and B
 * overlapping C does not make A and C column-mates, and there is no equivalence
 * class of "this column" to compute. Every question here is therefore asked
 * about ONE container's own mates, which is also the honest scope — a person
 * growing a container is looking at what is directly under it, not at a graph.
 */
export function shares(a: Box, b: Box): boolean {
  return a.i !== b.i && a.x < b.x + b.w && b.x < a.x + a.w
}

/**
 * Everything sharing a column with `box`, that sits BELOW it, nearest first.
 *
 * Below rather than around, because growth goes downward: the resize handle is
 * the south-east corner, and a container above is not moved by the one under it
 * getting taller. Taking rows from something above would mean moving the
 * container being grown, which is not what anybody asked for when they pulled
 * its bottom edge down.
 *
 * Nearest first, because the nearest is the one a person can SEE moving. A rule
 * that took rows from the furthest container would be correct arithmetic and
 * would read as an unrelated thing changing size somewhere else on the canvas,
 * which is the complaint this whole area started with.
 *
 * Two boxes that overlap in x cannot overlap in y — the grid does not allow it
 * — so "below" is unambiguous and needs no tie-breaking.
 */
export function below(boxes: readonly Box[], box: Box): Box[] {
  return boxes
    .filter((other) => shares(box, other) && other.y >= box.y + box.h)
    .sort((one, two) => one.y - two.y)
}

/**
 * How far down this container's column is already spoken for.
 *
 * The bottom edge of the lowest thing in it, itself included. What is left
 * between that and the bottom of the canvas is free, and free rows are spent
 * before anybody is asked to give any up — which is both obviously right and
 * the common case: a kehikko in this workspace has a column with twenty-two
 * rows used out of twenty-eight, so the first six rows of growth there cost
 * nobody anything.
 */
export function reach(boxes: readonly Box[], box: Box): number {
  return boxes.reduce(
    (lowest, other) => (shares(box, other) || other.i === box.i ? Math.max(lowest, other.y + other.h) : lowest),
    0,
  )
}

/**
 * What the heights become when one container grows to `wanted`.
 *
 * Returns id → new height, for every container whose height changes, INCLUDING
 * the one that grew — whose new height is what the column could actually pay
 * for, which is not always what was asked.
 *
 * ## The order it spends in
 *
 *   1. The free rows at the bottom of the column, because they belong to
 *      nobody.
 *   2. The nearest container below, down to `SQUEEZED_ROWS`.
 *   3. The next one, and so on.
 *   4. Then it stops, and the rest of the growth does not happen.
 *
 * ## Stopping is the answer, not overflowing and not folding somebody
 *
 * When nobody can pay, the container simply does not get any bigger. That is
 * the same answer as dragging a container past column twelve, and it should
 * feel the same — which is why `App.tsx` also puts this number in each item's
 * `maxH`, so the resize handle refuses to travel rather than travelling and
 * then snapping back. The edge is felt, not discovered afterwards.
 *
 * ## Only growth
 *
 * A container getting SHORTER gives its rows back to the column as free space
 * and does not inflate its neighbours to fill them. Auto-growing a container
 * somebody did not touch is the same surprise as auto-shrinking one, in the
 * other direction, and the space is right there for whoever wants it.
 */
export function pay(
  boxes: readonly Box[],
  id: string,
  wanted: number,
  rows = CANVAS_ROWS,
  floor = SQUEEZED_ROWS,
): Map<string, number> {
  const changed = new Map<string, number>()
  const box = boxes.find((one) => one.i === id)
  if (!box) return changed

  /* A container is at least one row, whatever anybody asked for. A container of
     no rows is a container deleted by a rounding error. */
  const asked = Math.max(1, Math.min(rows, Math.round(wanted)))
  let need = asked - box.h
  if (need <= 0) return changed

  /* The free rows first. `reach` counts the target itself, so this is the room
     under the whole column rather than under the target alone. */
  const free = Math.max(0, rows - reach(boxes, box))
  need -= Math.min(need, free)

  for (const mate of below(boxes, box)) {
    if (need <= 0) break
    const spare = Math.max(0, mate.h - floor)
    if (spare === 0) continue
    const taken = Math.min(need, spare)
    changed.set(mate.i, mate.h - taken)
    need -= taken
  }

  /* What was actually paid for. `need` is whatever nobody could cover, and it
     is subtracted rather than ignored — a container that grew by more than the
     column gave up is a column that overflows. */
  const granted = asked - box.h - need
  if (granted <= 0) return new Map()
  changed.set(id, box.h + granted)
  return changed
}

/**
 * The tallest this container could become right now.
 *
 * `pay` asked for everything and told what it would get. Written this way
 * rather than as its own arithmetic so there is exactly one rule: a `maxH` that
 * disagreed with what a resize actually does would be a handle that stops
 * somewhere nothing happens, or travels somewhere nothing is granted.
 */
export function mostFor(
  boxes: readonly Box[],
  id: string,
  rows = CANVAS_ROWS,
  floor = SQUEEZED_ROWS,
): number {
  const box = boxes.find((one) => one.i === id)
  if (!box) return rows
  return pay(boxes, id, rows, rows, floor).get(id) ?? box.h
}
