/**
 * How tall a grid row is drawn, and how many rows a canvas has at all.
 *
 * ## The asymmetry this exists to end
 *
 * The canvas has always fitted its width and never its height, and the reason
 * is one line of configuration rather than anything deep. `react-grid-layout`
 * is given twelve columns, so a column is a TWELFTH OF WHATEVER WIDTH THERE IS
 * — a container six wide is half the canvas on a laptop and half the canvas on
 * a monitor. But it was given `rowHeight={24}`, a fixed number of pixels, so a
 * container ten rows tall was 240 pixels everywhere. Widths were a proportion
 * and heights were an absolute.
 *
 * What followed is that an arrangement somebody built on a large screen
 * overflowed a small one downward, forever, and the only remedy was scrolling.
 * The owner's words: "the grid still ends overflowing height wise, width wise
 * it has always been able to adjust accordingly so that it doesn't overflow."
 *
 * ## The first fix, and why it was wrong
 *
 * The first attempt made the row height a function of the ARRANGEMENT: measure
 * how many rows the lowest container reaches, and shrink the rows until that
 * many fit. It fitted, and it introduced a worse problem within the hour.
 *
 * The owner again: "If something expands on another grid column, it seems to
 * push other grid column items to become needlessly smaller, which doesn't make
 * sense to me." It did not make sense because it was wrong. Growing one
 * container raised the extent, which lowered the row height, which shrank every
 * container on the canvas — including ones in other columns with no vertical
 * relationship to the one that moved.
 *
 * The second attempt held the row height steady while somebody worked and
 * refitted only when the window moved. That stopped the shrinking by letting
 * the canvas overflow again, which is the complaint it was supposed to fix. The
 * owner saw it and said so: "Seems like the path chosen to fix the window fits
 * was to reintroduce overflow and scrolling."
 *
 * Both attempts missed what actually makes the width axis work.
 *
 * ## What makes the width axis work is that you cannot be thirteen wide
 *
 * A column's width is `room / 12` and nothing about the content can change it,
 * because the COLUMN COUNT is fixed and no item can exceed it. Widening a
 * container cannot shrink its neighbours, cannot overflow the canvas, and
 * cannot be pushed past the edge — not because anything measures the content,
 * but because the axis is a fixed number of divisions and an item is bounded to
 * them.
 *
 * So the mirror of twelve columns is not "fit the content into the window". It
 * is a FIXED NUMBER OF ROWS. The canvas is `CANVAS_ROWS` tall, a row is that
 * fraction of the room, and `maxRows` on the grid means no arrangement can
 * exceed it. All three properties fall out at once:
 *
 *   - nothing overflows, because nothing can be taller than the canvas;
 *   - growing one container cannot shrink another, because the row height is a
 *     function of the window and of nothing else;
 *   - growth is BOUNDED, exactly as widening is bounded at twelve columns.
 *
 * The third is the one that feels like a loss and is not. You cannot make a
 * container thirteen columns wide either, and nobody has ever filed that as a
 * bug. A person who wants a container to hold more than a canvas-height of
 * content scrolls INSIDE it, which is what a container that already reaches the
 * bottom does today.
 *
 * ## The row height grows as well as shrinks now, and it has to
 *
 * The version before this deliberately never grew past a nominal 24 pixels, on
 * the argument that a tall container mostly holds more empty space. That
 * argument does not survive `maxRows`. Capped rows on a tall screen would leave
 * a band at the bottom of the canvas that is visible, is not part of any
 * container, and CANNOT BE USED — nothing can be dragged into it, because
 * nothing may exceed `CANVAS_ROWS`. Space a person can see and cannot reach is
 * a bug, and it is exactly the thing the width axis never does: twelve columns
 * always fill the width.
 *
 * So the rows fill the height, and an arrangement drawn on a monitor is the
 * same arrangement drawn larger — which is what happens across the width today
 * and what nobody has ever complained about.
 *
 * ## The floor, and the one case that still scrolls
 *
 * Shrinking has an end. A row is the unit of a container's height, and past
 * some point a container is too short to hold anything a person can read. So
 * this stops at `FLOOR_ROW` and the canvas scrolls below it — which happens on
 * a canvas under about 570 pixels tall, and is the only overflow this design
 * leaves. Fitting is a courtesy, not a promise.
 *
 * ## The feedback loop is now shut by construction
 *
 * This file used to carry a warning that the drawn row height must never be fed
 * back into the pixels-to-rows conversion in `onHeight`, because of a loop with
 * a person inside it: a module asks for 300px, a shorter row means more rows,
 * more rows means a taller arrangement, a taller arrangement means shorter
 * rows, around again until everything is at the floor.
 *
 * That loop needed the row height to depend on the arrangement. It no longer
 * does — it depends on `room` and on a constant — so the cycle has nowhere to
 * close and `App.tsx` now converts pixels to rows with the DRAWN height, which
 * is the only conversion that gives a module the height it actually asked for.
 * The warning is recorded here rather than deleted, because the day somebody
 * makes this a function of the content again is the day it comes back.
 */

/**
 * How many rows a canvas has. The mirror of twelve columns.
 *
 * Fifty-six: twenty-eight rows, each cut in two. The number is chosen rather than derived,
 * so here is what chose it, both times.
 *
 * ## Twenty-eight, first
 *
 * It was what the arrangements in this workspace ALREADY WERE. The three
 * canvases in the live database reached 28, 22 and 28 rows, so adopting 28 as
 * the count meant not one placement had to move. And 28 was not a coincidence:
 * a row at the old nominal 24 pixels, with an 8-pixel gap above each and below
 * the last, makes 28 rows exactly 904 pixels — the canvas height on the screen
 * those arrangements were built on.
 *
 * ## Then fifty-six, because twenty-eight left a band at the bottom
 *
 * The owner, later: "often times kehikko leaves some empty space at the bottom
 * to which you can't expand to. I think it's because the rows are so few and
 * tall that if there's not enough space to expand one more row it will leave a
 * gap at the bottom." Two things made that band, and both were here.
 *
 *   - The row height was FLOORED to whole pixels, so up to a pixel a row — up
 *     to twenty-seven pixels on a canvas of twenty-eight — was left under the
 *     last row, at every window height that did not divide evenly. That is
 *     `rowHeightFor`'s to fix, and it does: see there.
 *   - A row was a step of thirty-odd pixels, so a resize moved a container's
 *     bottom edge in steps that size and a module's request for a height was
 *     rounded UP to the next one. Halving the row halves the step.
 *
 * Why two and not three. A row is drawn with an 8-pixel gap under it, so a
 * canvas of N rows spends N+1 gaps on air whatever the room. At fifty-six that
 * is 456 pixels, and a row on the 904-pixel canvas is 8 pixels: a step of 16.
 * At eighty-four it would be 680 pixels of air — more than most of a laptop's
 * canvas — and the floor below would have nowhere to be, because the old
 * floor's step of 20 pixels divided in three is less than a gap. Fifty-six is
 * the finest count at which every height a canvas has ever drawn, the floor
 * included, is still drawn exactly.
 *
 * And exactly is the point of a multiple. A container `h` rows tall at the
 * top of row `y` on a canvas of 28 is, to the pixel, a container `2h` rows tall
 * at row `2y` on a canvas of 56 — the air between two half-rows is the same
 * 8 pixels the old row spent inside itself, and with the row height no longer
 * floored the arithmetic is exact (`test/fit.test.ts` holds it to that). So
 * the move is a migration that nobody can see: every `y`, `h` and `wish`
 * stored in 28ths is doubled once, and every arrangement draws where it drew.
 * The migration is that doubling, applied by the database
 * (`placements.rows` in `server/canvases.ts`), by the project's file (a
 * `kehikot.json` with no `"rows": 56` at its top, in `server/kehikot.ts`) and
 * by a layout file (version 1 → 2 in `src/host/layouts.ts`). Each says which
 * rows it counts in, so nothing is doubled twice.
 *
 * The things that are COUNTS of rows doubled with it, for the same reason: the
 * folded height (`FOLDED_ROWS`, two), the least a neighbour is squeezed to
 * (`SQUEEZED_ROWS`, six), a new container (`NEW_H`, twenty) and the least gap
 * a new one is shaped into (`GAP_MIN_H`, twelve). Each is the same pixels it
 * always was.
 *
 * Raising it again is the same migration; LOWERING it moves an arrangement that
 * reaches the bottom, and is not free.
 */
export const CANVAS_ROWS = 56

/**
 * How many rows a canvas had before it had `CANVAS_ROWS`: what a database row
 * without a row count, a `kehikot.json` without `rows` and a layout file of
 * version 1 were all written in.
 */
export const ROWS_BEFORE = 28

/**
 * A count of the old rows, as a count of these. Exact: `CANVAS_ROWS` is a
 * multiple of `ROWS_BEFORE`, and a container that drew at `y` and `h` in the
 * old rows draws at `finer(y)` and `finer(h)` in these, to the pixel.
 */
export function finer(oldRows: number): number {
  return oldRows * (CANVAS_ROWS / ROWS_BEFORE)
}

/**
 * The row height used before anything has been measured.
 *
 * Not a maximum — see the essay above on why the rows fill the height. It is
 * the number the canvas draws with for the one frame between mounting and the
 * surface reporting how tall it is: 8, which is 56 rows on the 904-pixel canvas
 * these arrangements were built on — the same canvas the old nominal 24 drew
 * with 28 — so the pre-measurement frame looks like the canvas rather than like
 * a mistake.
 */
export const NOMINAL_ROW = 8

/**
 * The shortest a row may be squeezed to.
 *
 * Two pixels, which with its gap is a step of 10 — half the old floor's 12 and
 * its gap, so two of these are exactly the row the old floor drew. That is the
 * point at which a folded container — `FOLDED_ROWS` of them, holding a header —
 * has visibly stopped being a thing you can press. Below it, scrolling a
 * correct-sized canvas is better than seeing all of a useless one, and the
 * canvas scrolls at the same 568 pixels it always did.
 */
export const FLOOR_ROW = 2

export interface Room {
  /** The height the canvas has to draw in, in pixels. `null` before it is measured. */
  room: number | null
  /** The vertical gap between rows, and above the first and below the last. */
  gap: number
}

/**
 * The row height to draw with: the room, divided into `rows` of them, EXACTLY.
 *
 * Note what is NOT a parameter. Nothing about the arrangement — not the extent,
 * not the number of containers, not what any module asked for. That is the
 * whole of the fix, and a future parameter of that kind is the whole of the
 * regression.
 *
 * And note what the answer is not: a whole number. It used to be floored, on
 * the argument that a row half a pixel too tall, times twenty-eight rows, is
 * fourteen pixels of overflow. True, and the floor's own cost was the same
 * pixels the other way — up to one a row left under the last row, a band at the
 * bottom of the canvas nothing could be resized into. Neither is needed. The
 * grid places each container at `round((row + gap) * y + gap)` and draws it
 * `round(row * h + gap * (h - 1))` tall (`calcGridItemPosition` in
 * react-grid-layout), rounding per container rather than accumulating, so a
 * fractional row puts every edge within a pixel of where it belongs, and the
 * bottom of the last row within a pixel of the bottom of the room less its gap —
 * inside that gap, so it never overflows. The grid's own height is the same sum
 * unrounded, which is the room again.
 */
export function rowHeightFor(
  { room, gap }: Room,
  rows = CANVAS_ROWS,
  floor = FLOOR_ROW,
  nominal = NOMINAL_ROW,
): number {
  if (room === null || room <= 0 || rows <= 0) return nominal

  /* `containerPadding` puts a gap above the first row and below the last, and
     `margin` puts one between each pair. A canvas of N rows therefore spends
     N+1 gaps on air, and asking for the rows to fit without counting them is
     how a fit ends up one gap too tall. */
  const air = gap * (rows + 1)

  return Math.max(floor, (room - air) / rows)
}

/**
 * How many rows hold `px` pixels of a container, at the row height drawn —
 * what a module's `kehikot.resize` asks for, as rows.
 *
 * The least that holds it, so a module is never given less than it asked for;
 * and with a hair of tolerance, because the row height is fractional now and a
 * request for exactly three rows' worth must not come out at 3.0000000001 and
 * be rounded up to four. Bounded by the canvas: a request past it is "as much
 * as there is".
 */
export function rowsHolding(px: number, rowHeight: number, gap: number, rows = CANVAS_ROWS): number {
  return Math.min(rows, Math.max(1, Math.ceil((px + gap) / (rowHeight + gap) - 1e-6)))
}

/**
 * How tall a container may be, given where its top is.
 *
 * The vertical twin of "a container six wide starting at column eight is
 * clipped to four", and it exists because `maxRows` clamps a DRAG and a RESIZE
 * but is not consulted by the compaction that runs when the host writes a
 * placement itself. A module asking to grow is the host writing a placement, so
 * without this a `kehikot.resize` could put a container past the bottom of a
 * canvas that is supposed to have no past-the-bottom.
 *
 * The honest answer to a module that asks for more than there is room for is
 * that it does not get it — the container stops at the edge and the module's
 * own page scrolls, which is exactly what a container already sitting at the
 * bottom of the canvas does today.
 */
export function roomBelow(y: number, rows = CANVAS_ROWS): number {
  return Math.max(1, rows - Math.max(0, y))
}
