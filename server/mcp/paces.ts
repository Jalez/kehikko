/**
 * What the door remembers between calls, to keep its paces: when each conversation last changed
 * an arrangement (`arrange_modules`, `ARRANGE_PER_MINUTE`) and when an agent last jumped the view
 * (`jump`, `paceRefusal` in `src/host/jump.ts`).
 *
 * A request's `Door` is built afresh for every call, so what has to outlive one call is made once,
 * where the door is set up — `server.ts` makes one of these when it starts and hands it to every
 * request — and never kept at module level, where two doors (a test's and another's) would share it.
 */
export interface DoorPaces {
  /** When each caller's recent `arrange_modules` changes were made. */
  arranges: Map<string, number[]>
  /** When an agent last jumped the view, under key 0: one screen, one key. */
  jumps: Map<number, number>
}

export function doorPaces(): DoorPaces {
  return { arranges: new Map(), jumps: new Map() }
}
