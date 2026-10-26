import { reportOpen } from './canvases.ts'
import type { RegistryView } from './registry.ts'

/**
 * One sweep at a time — and one more after it for whoever asked meanwhile.
 *
 * The page's sweep used to DECLINE while another was in flight. That is right
 * for a timer, and wrong for the one caller whose request carries an order: the
 * load. The page sweeps once on mount, then reports which kehikko it has open
 * and sweeps again so the answer is about that kehikko. The second sweep was
 * asked while the first was still out, so it never happened — and the page took
 * the first answer, from before the server knew what was open, as the one that
 * knew. Nothing asked again until the window was focused or Start was pressed.
 *
 * So a call made while one runs is owed a sweep that STARTS after it was made.
 * Every such call shares that one follow-up: two timers and a report asking at
 * once still cost two sweeps, not four.
 */
export function oneAfterAnother(
  work: (fresh: boolean) => Promise<void>,
): ((fresh?: boolean) => Promise<void>) & { join(): Promise<void> } {
  let running: Promise<void> | null = null
  let next: Promise<void> | null = null
  /* Whether any call waiting for the follow-up asked for a fresh one. */
  let nextFresh = false
  const ask = (fresh = false): Promise<void> => {
    if (!running) {
      running = work(fresh).finally(() => {
        running = null
      })
      return running
    }
    nextFresh ||= fresh
    next ??= running
      .catch(() => undefined)
      .then(() => {
        next = null
        const asked = nextFresh
        nextFresh = false
        return ask(asked)
      })
    return next
  }
  /**
   * The sweep already out, or a new one when none is: for a caller that only needs AN answer and
   * carries no order — the page's first look, which React's StrictMode asks twice in development.
   */
  const join = (): Promise<void> => running ?? ask()
  return Object.assign(ask, { join })
}

/**
 * What a page does on arriving at a kehikko: say so, then look.
 *
 * In that order, and on nothing but arriving. It waits for no focus, no
 * visibility and no animation frame: an app relaunched behind another one is
 * not frontmost, and the modules on its kehikko are to start all the same. The
 * server starts them on the report (`/host/open`); the sweep after it is what
 * reads them back as starting, so the container says so instead of offering
 * Start over a start already under way. The report's answer says whether
 * anything was started; when nothing was, the page's own first look stands and
 * there is no second one.
 */
export async function arrive(kehikko: number | null, look: () => Promise<void>): Promise<void> {
  const said = await reportOpen(kehikko)
  /* The host answers whether the report started anything; when it did not, what the page
     already read stands, and a sweep would be the same answer again. */
  if (said.started) await look()
}

/**
 * How long after a reading that says something is starting the page looks once more, if nothing
 * has told it otherwise by then.
 *
 * The page does not poll while modules start. The host tells it, on `/host/watch`, when its wait for
 * a module it started ends — up or given up on, with the reading (`untilAnswered` in
 * `server/server.ts`) — and when an update, a restart or a pinned version moves (`wake.ts`). It used
 * to look every 1.5 s while anything said "starting" (and every 2 s while a pinned version was being
 * prepared): Monitor's record on 0.1.72 showed the page asking `/host/modules` 33 times in 9.1 s
 * after the app started, each look asking every module that was not answering yet. This is the one
 * look for news that was missed, past the host's own `STARTING_FOR_MS` (30 s), after which no start
 * says "starting" any more; a reading that still does re-arms it.
 */
export const MISSED_NEWS_MS = 35_000

/** Whether a reading says something the host is still doing — a start, an update, a version being prepared — that will end on its own. */
export function stillMoving(view: RegistryView | null): boolean {
  if (!view) return false
  const starting = view.presences.some((presence) => presence.lifecycle !== undefined && presence.lifecycle !== 'asleep')
  const preparing = (view.pins ?? []).some((pin) => ['preparing', 'starting'].includes(pin.state))
  return starting || preparing
}
