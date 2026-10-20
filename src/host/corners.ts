/** The four corners a container can be resized from: compass points, as the grid names them. */
export const CORNERS = ['nw', 'ne', 'sw', 'se'] as const
export type Corner = (typeof CORNERS)[number]

/**
 * Which corner a press landed on, read off the handle that was pressed.
 *
 * The grid reports a resize without saying which handle began it, and the
 * answer matters: a top corner moves the top edge and trades rows with what is
 * on top of the container (`topEdge` in `columns.ts`), where a bottom corner
 * trades with what is below. The handle carries its corner as `data-corner`,
 * and a press can land on a child of it, so the element is walked up.
 */
export function cornerOf(target: EventTarget | null | undefined): Corner | null {
  const node = target as { closest?: (selector: string) => Element | null } | null | undefined
  const found = node?.closest?.('[data-corner]')?.getAttribute('data-corner')
  return (CORNERS as readonly string[]).includes(found ?? '') ? (found as Corner) : null
}
