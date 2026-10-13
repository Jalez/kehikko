import { METHODS } from 'kehikot-module-protocol'

/**
 * Which capability a method is answered under, and whether a module asked for it.
 *
 * A manifest's `declares.uses` lists the capabilities a module asks for. The
 * protocol maps every method to one (`METHODS`), and this host holds every
 * method to that list: a call under a capability the manifest did not ask for
 * is not answered. `parts.set` was the first held so (see `PartsDoor` in
 * `server/answers.ts`); this is the same rule for the rest, in one place for
 * both halves of the host — the server for what it answers, the canvas for
 * what it answers (`division.ts`).
 *
 * `uses` is read off the manifest the registry last fetched, which no call
 * can write.
 */

/** The capability a method belongs to, or null for a name the protocol does not have. */
export function capabilityOf(method: string): string | null {
  /* `hasOwn`, because a method name comes from somebody else's program and
     `constructor` is a legal string. */
  return Object.hasOwn(METHODS, method) ? METHODS[method as keyof typeof METHODS] : null
}

/**
 * Methods answered whatever the manifest says, with one line logged per call.
 *
 * The way out for a method a module that is live today calls without having
 * declared it: name it here, fix the module's manifest, then take it out.
 * Empty, because the check of every official module's manifest against what
 * its page calls found none.
 */
export const ANSWERED_UNDECLARED: ReadonlySet<string> = new Set<string>([])

export type Held =
  /** Asked for, or a name with no capability: answer it. */
  | { held: false }
  /** Not asked for, and on the list above: answer it and say so in the log. */
  | { held: false; undeclared: string }
  /** Not asked for: do not answer it. `why` is for the module's author. */
  | { held: true; capability: string; why: string }

/** Whether this call is kept from a module that `may` only what its manifest asked for. */
export function hold(method: string, may: (capability: string) => boolean): Held {
  const capability = capabilityOf(method)
  if (capability === null || may(capability)) return { held: false }
  if (ANSWERED_UNDECLARED.has(method)) return { held: false, undeclared: capability }
  return {
    held: true,
    capability,
    why: `This module’s manifest does not ask for ${capability} (declares.uses), so this host does not answer ${method} for it.`,
  }
}

/** The log line for a call answered though its capability was not declared. */
export const undeclaredLine = (module: string, method: string, capability: string): string =>
  `${module} called ${method} without ${capability} in its manifest's declares.uses; answered for now.`
