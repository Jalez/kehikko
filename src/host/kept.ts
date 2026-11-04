import type { Presence } from './registry.ts'

/**
 * What a module kept for one container — the module on one kehikko — as the
 * page hands it on (protocol 2.51.0: the greeting's `state` and `context.kept`).
 *
 * The page never reads the string; it only decides which one to carry:
 *
 *   1. what the module wrote for that container while this page was open
 *      (`here`), which the server has or is about to have, and which the next
 *      registry sweep may not have caught up with yet;
 *   2. what the server keeps for that container (`presence.kept`);
 *   3. what the server kept for the module before there were containers
 *      (`presence.state`) — where a container that has kept nothing starts.
 */
export function keptFor(
  presence: Pick<Presence, 'state' | 'kept'> | undefined,
  module: string,
  kehikko: number | null,
  here: ReadonlyMap<string, string>,
): string | null {
  if (kehikko !== null) {
    const written = here.get(keptKey(kehikko, module))
    if (written !== undefined) return written
    const stored = presence?.kept?.[kehikko]
    if (stored !== undefined) return stored
  }
  return presence?.state ?? null
}

/** How `here` names one container. */
export function keptKey(kehikko: number, module: string): string {
  return `${kehikko}|${module}`
}

/** `here` with one container's string, the same map when it already says that. */
export function keptWritten(here: ReadonlyMap<string, string>, module: string, kehikko: number, state: string): ReadonlyMap<string, string> {
  const key = keptKey(kehikko, module)
  if (here.get(key) === state) return here
  const next = new Map(here)
  next.set(key, state)
  return next
}
