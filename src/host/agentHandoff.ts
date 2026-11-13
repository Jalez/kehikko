import { type Placement, place } from './canvases.ts'
import { pressed, tiledTo } from './columns.ts'

/**
 * Handing something to an agent, the page's half (the host's is `startAgentSession` in
 * `server/agentSession.ts`): the agent module's container is on the kehikko and open, so the person
 * sees the session it starts, as if they had pressed "New session" there themselves.
 *
 * `shownFor`: the arrangement with the module's container added where a new one goes (`place`) when
 * it is missing, unfolded when folded, and restored when it is a tile. Null when it is already on the
 * kehikko and open: nothing to write.
 */
export function shownFor(placements: readonly Placement[], module: string): Placement[] | null {
  const on = placements.find((one) => one.i === module)
  if (!on) return place(placements, module)
  if (on.tiled) return tiledTo(placements, { untile: [module] })
  if (on.collapsed) return pressed(placements, module, false)
  return null
}

/** What the person is told when the agent has the item: the dialog closes on it. */
export const handedSaid = (name: string): string => `${name} is on it in its container.`
