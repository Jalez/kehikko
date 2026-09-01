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
 * Twenty-eight, and the number is chosen rather than derived, so here is what
 * chose it.
 *
 * It is what the arrangements in this workspace ALREADY ARE. The three canvases
 * in the live database reach 28, 22 and 28 rows — `select canvas, max(y+h) from
 * placements group by canvas` — so adopting 28 as the count means not one
 * placement has to move. Every alternative considered required rewriting
 * somebody's canvases: a smaller count (twelve, to match the columns exactly,
 * which is prettier) would have meant scaling every `y` and `h` on every canvas
 * into it, on a live database, while the owner was working in it, with no way
 * back if the result read badly.
 *
 * And 28 is not a coincidence. A row at the old nominal 24 pixels, with an
 * 8-pixel gap above each and below the last, makes 28 rows exactly 904 pixels —
 * which is the canvas height on the screen these arrangements were built on. So
 * the number is the honest restatement of what a canvas has been all along; it
 * has simply never been written down as a rule the layout could rely on.
 *
 * Raising it is free and makes every row shorter. LOWERING it is a migration,
 * because an arrangement that already reaches row 28 would have to be moved.
 */
export const CANVAS_ROWS = 28

/**
 * The row height used before anything has been measured.
 *
 * Not a maximum any more — see the essay above on why the rows now fill the
 * height. It is the number the canvas draws with for the one frame between
 * mounting and the surface reporting how tall it is, and it is 24 because that
 * is what this canvas drew with for its whole life before any of this, so the
 * pre-measurement frame looks like the canvas rather than like a mistake.
 */
export const NOMINAL_ROW = 24

/**
 * The shortest a row may be squeezed to.
 *
 * Half the nominal, which is the point at which a folded container — one row,
 * holding a header — has visibly stopped being a thing you can press. Below
 * this, scrolling a correct-sized canvas is better than seeing all of a useless
 * one.
 */
export const FLOOR_ROW = 12

export interface Room {
  /** The height the canvas has to draw in, in pixels. `null` before it is measured. */
  room: number | null
  /** The vertical gap between rows, and above the first and below the last. */
  gap: number
}

/**
 * The row height to draw with: the room, divided into `rows` of them.
 *
 * Note what is NOT a parameter. Nothing about the arrangement — not the extent,
 * not the number of containers, not what any module asked for. That is the
 * whole of the fix, and a future parameter of that kind is the whole of the
 * regression.
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

  /* Floored rather than rounded: a row half a pixel too tall, times twenty-eight
     rows, is fourteen pixels of overflow — which is the whole complaint,
     arriving by the back door. */
  const fits = Math.floor((room - air) / rows)

  return Math.max(floor, fits)
}

/**
 * How tall a container may be, given where its top is.
 *
 * The vertical twin of "a container six wide starting at column eight is
 * clipped to four", and it exists because `maxRows` clamps a DRAG and a RESIZE
 * but is not consulted by the compaction that runs when the host writes a
 * placement itself. A module asking to grow is the host writing a placement, so
 * without this a `roadmap.resize` could put a container past the bottom of a
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
