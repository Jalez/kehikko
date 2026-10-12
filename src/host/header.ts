/**
 * What each module last declared for its container's menus, held by the page.
 *
 * `kehikot.header` (protocol 1.1.0) is a module saying which view switches,
 * toggles, jumps and runs it has, so a host can draw them in the container's
 * header instead of the module drawing a toolbar of its own. The module owns
 * every piece of state in it — which option a switch is on, whether a run is
 * busy — and declares the whole list again after every change, so all a host
 * holds is the latest list per module.
 *
 * ## Held, and not drawn yet
 *
 * This host reads the message and keeps what it said; the menus themselves
 * (kehikko#62, step 2) are drawn from here by what comes next, and nothing a
 * person can see changes until then. Reading it now is what keeps a module
 * that declares a header from being reported as having sent something the
 * host could not read.
 *
 * ## When it goes
 *
 * With the document that declared it: a frame replaced, taken off, or gone
 * silent has declared nothing, and its successor declares again after its own
 * greeting — the protocol's client replays the last header after every
 * `ready`. `[]` is a module taking its menus away, and is kept as said: it is
 * a declaration, where an absent entry is a module that has said nothing.
 *
 * Both functions hand back the same object when nothing changed, so a caller
 * can hold it in state without causing a render.
 */

import type { HeaderItem } from 'kehikot-module-protocol'

/** The latest header by module id. */
export type Headers = Readonly<Record<string, readonly HeaderItem[]>>

export const NO_HEADERS: Headers = {}

/** What a module that has declared nothing is drawn with. */
export const NO_HEADER: readonly HeaderItem[] = []

/** The headers after one module declared: its list replaced whole, never merged. */
export function declared(held: Headers, id: string, items: readonly HeaderItem[]): Headers {
  const was = held[id]
  if (was && JSON.stringify(was) === JSON.stringify(items)) return held
  return { ...held, [id]: items }
}

/** The headers without one module's: its document is gone, and so is what it declared. */
export function withdrawn(held: Headers, id: string): Headers {
  if (!Object.hasOwn(held, id)) return held
  const { [id]: _gone, ...rest } = held
  return rest
}
