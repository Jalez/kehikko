import type { Build, FilterGroup, ModuleCondition } from 'kehikot-module-protocol'

/**
 * What the canvas currently believes about one module, which is not always what
 * the server last said.
 *
 * The server establishes a condition by asking for a manifest. The frame
 * establishes one by being greeted and answering — or not. Both are true
 * observations of the same program at different moments, and the later one
 * wins: a module whose manifest answered and whose page then said nothing is
 * silent, whatever the sweep concluded thirty seconds ago.
 */
export interface Live {
  condition: ModuleCondition
  /**
   * The sentence the conversation itself produced, or `null` when it has not
   * produced one — a module that simply answered has nothing to say about
   * itself, and the container falls back to what discovery wrote.
   *
   * Null rather than an empty string, because an empty string is a sentence as
   * far as `??` is concerned, and the container would show nothing where it meant to
   * show the server's line.
   */
  line: string | null
  /**
   * The page's own account of why it did not answer (protocol 2.59.0,
   * `kehikot.page.error`): the first lines of the error's stack, shown under
   * "Show details" beside `line`. Text, never markup.
   */
  more?: string | null
  fault: string | null
  /**
   * The build that served the page that answered, when the page says — which
   * server PROCESS it came from. Compared with the build the module's server
   * states now to see a page older than its server; see `isStale` in
   * `host/standing.ts`. Null or absent for a module from before build
   * identities, which is never called stale.
   */
  build?: Build | null
  /**
   * What this module last said it can be narrowed by, or nothing.
   *
   * Here rather than in the arrangement, and the split is the point: the OFFER
   * belongs to a running program and dies with it, while the CHOICE belongs to
   * a container on a canvas and outlives everything — see `filters` on the
   * placement schema. A module that is stopped stops offering, its control
   * disappears, and what somebody chose is still in the database waiting for it
   * to come back.
   *
   * Absent for every module that has never said anything, which is almost all
   * of them, and absence is what draws no control at all.
   */
  filters?: FilterGroup[]
  /**
   * What this module last said could be cleared of what it is showing, in its
   * own words — or `null`, which is the module saying there is nothing on
   * screen to clear right now.
   *
   * Here beside the filter offer and for the same reason: it belongs to a
   * running program and dies with it. Unlike the filter, there is no matching
   * CHOICE stored anywhere, because there is nothing to remember — a press is
   * an event, not a state, and a container does not carry "somebody once
   * cleared this" from one day to the next.
   *
   * Three values and they are three different things. Absent is a module that
   * has never said anything, which is almost all of them and draws no control.
   * `null` is a module that HAS said something and is currently offering
   * nothing, which also draws no control but arrived there deliberately. A
   * string is an offer. The host draws the same nothing for the first two, and
   * the distinction is kept because `Live` is what a person reads when working
   * out why a control is missing.
   */
  clear?: string | null
  /**
   * What this module last said about being refreshed, or nothing.
   *
   * The third offer, held here beside the other two and for the same reason:
   * all three belong to a running program and die with it, while what a person
   * chose about the container outlives everything. For the filter that split is
   * offer-here / choice-in-the-placement; for this it is state-here /
   * INTERVAL-in-the-placement, which is the same split with different words.
   *
   * `at` is the part that could not have come from anywhere else. This host
   * knows when it asked; it does not know whether the module answered out of a
   * cache, whether the read failed over a reading still on screen, or whether
   * the module refreshed itself for a reason nothing here can see. So the
   * module says, and `null` — "I cannot say" — draws no time rather than a
   * guess.
   *
   * Absent for every module that has never mentioned the idea, which is almost
   * all of them, and absence draws no control at all.
   */
  refresh?: { can: boolean; at: string | null; busy: boolean }
}
