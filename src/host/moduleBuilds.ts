import { z } from 'zod'

/**
 * How an installed module is said to run, in words — the page's side of
 * `server/moduleBuilds.ts`, which builds them. Pure.
 *
 * An installed copy that can be built is built once, on this machine, when it
 * is installed or updated; its `run.sh` then serves that build ("ready-built")
 * while it is the commit checked out, and the module's source through Vite
 * otherwise ("from source"). A build that does not finish is never an error a
 * person has to act on: the module works, from source, and the words say so
 * plainly and point at the log.
 */

/** What the Updates menu is told about one module's build: only the two worth a line. */
export const buildToldSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('preparing') }),
  z.object({ state: z.literal('failed'), why: z.string() }),
])

export type BuildTold = z.infer<typeof buildToldSchema>

/** How an installed copy runs, for its details. Mirrors `buildOf` in `server/server.ts`. */
export const buildDetailsSchema = z.object({
  ready: z.boolean(),
  preparing: z.boolean().default(false),
  failed: z.object({ why: z.string(), lines: z.array(z.string()).default([]), log: z.string() }).nullable().default(null),
})

export type BuildDetails = z.infer<typeof buildDetailsSchema>

/** While it is being built, after an install or an update. */
export function preparingSaid(name: string): string {
  return `Preparing ${name}…`
}

/** Its build did not finish: it works, from source. */
export function fromSourceSaid(name: string): string {
  return `${name} runs from source; its build didn't finish (see log)`
}

/** The module's details: which of the two it runs as. */
export function runsAsSaid(details: Pick<BuildDetails, 'ready'>): string {
  return details.ready ? 'Ready-built' : 'Running from source'
}
