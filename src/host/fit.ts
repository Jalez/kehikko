/**
 * How tall a grid row should be, so an arrangement fits the height it has.
 *
 * ## The asymmetry this exists to end
 *
 * The canvas has always fitted its width and never its height, and the reason
 * is one line of configuration rather than anything deep. `react-grid-layout`
 * is given twelve columns, so a column is a TWELFTH OF WHATEVER WIDTH THERE IS
 * — a container six wide is half the canvas on a laptop and half the canvas on
 * a monitor. But it is given `rowHeight={24}`, a fixed number of pixels, so a
 * container ten rows tall is 240 pixels everywhere. Widths are a proportion and
 * heights are an absolute.
 *
 * What follows is that an arrangement somebody built on a large screen
 * overflows a small one downward, forever, and the only remedy is scrolling.
 * The owner's words: "the grid still ends overflowing height wise, width wise
 * it has always been able to adjust accordingly so that it doesn't overflow."
 *
 * ## Shrink to fit, and do not grow to fill
 *
 * The symmetry is not taken all the way, and the asymmetry that remains is
 * deliberate. A row never grows past `nominal`, so three containers on a tall
 * screen stay their ordinary size instead of ballooning to fill it. Columns can
 * grow because a wide container holds more words per line, which is a better
 * reading of the same text; a tall container mostly holds more empty space, and
 * a canvas whose two small containers had inflated to a third of a monitor each
 * would be a worse drawing of the same arrangement.
 *
 * So this only ever answers the question the owner actually asked: when the
 * arrangement is taller than the room, make the rows smaller until it is not.
 *
 * ## The floor, and why scrolling still exists below it
 *
 * Shrinking has an end. A row is the unit of a container's height, and past
 * some point a container is too short to hold anything a person can read — at
 * which point fitting the arrangement on screen has stopped being a service to
 * them. So this stops at `floor` and the canvas scrolls the rest, which is what
 * it did before this file existed. Fitting is a courtesy, not a promise.
 *
 * ## Why the LAYOUT arithmetic must not use the answer
 *
 * This decides how tall a row is DRAWN. It must not be fed back into the
 * conversion between a module's requested pixels and the rows it is given —
 * `onHeight` in `App.tsx` — and the reason is a loop with a person inside it:
 * a module asks for 300px, a shorter row means more rows to hold 300px, more
 * rows means a taller arrangement, a taller arrangement means shorter rows, and
 * around again until everything is at the floor and the canvas is full of
 * forty-row containers.
 *
 * The layout stays in nominal units. What changes is only the scale it is drawn
 * at, exactly as a column's width changes without any stored `w` changing.
 */

/** The row height a canvas uses when it has all the room it wants. */
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
  /** The bottom edge of the lowest container, in rows. Zero for an empty canvas. */
  extent: number
  /** The vertical gap between rows, and above the first and below the last. */
  gap: number
}

/**
 * The row height to draw with.
 *
 * `nominal` whenever the arrangement already fits, whenever nothing has been
 * measured yet, and whenever there is nothing on the canvas — three different
 * reasons to change nothing, and none of them worth telling apart.
 */
export function rowHeightFor(
  { room, extent, gap }: Room,
  nominal = NOMINAL_ROW,
  floor = FLOOR_ROW,
): number {
  if (room === null || room <= 0 || extent <= 0) return nominal

  /* `containerPadding` puts a gap above the first row and below the last, and
     `margin` puts one between each pair. A canvas of N rows therefore spends
     N+1 gaps on air, and asking for the rows to fit without counting them is
     how a fit ends up one gap too tall. */
  const air = gap * (extent + 1)
  const forRows = (room - air) / extent

  /* Floored rather than rounded: a row half a pixel too tall, times forty rows,
     is twenty pixels of overflow — which is the whole complaint, arriving by
     the back door. */
  const fits = Math.floor(forRows)

  if (fits >= nominal) return nominal
  return Math.max(floor, fits)
}
