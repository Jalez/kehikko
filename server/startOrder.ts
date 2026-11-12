/**
 * The order of a host start, as arithmetic: which installed copies are read
 * first, and when the work that is not needed to show the open kehikko may
 * begin. `server.ts` gathers the facts and does what these say.
 *
 * ## Why a copy is read before its module starts, and why not all of them first
 *
 * With "Keep modules up to date automatically" on, a restart brings the
 * modules along: an installed copy whose own tags hold a newer release is put
 * on it before its module first starts (`bootAutoUpdates` in `server.ts`).
 * That needs each copy read first — a dozen local git calls. The host used to
 * read every installed copy at once and start none until all were read, so
 * the open kehikko's modules waited for the twenty-odd it does not show: two
 * to three seconds of git on a quiet machine, and up to the eight-second cap
 * on a busy one. Now each module waits only for its own copy, and the copies
 * of the modules on screen are read first, all together; the rest follow a
 * few at a time.
 *
 * ## Why some work waits for the open kehikko
 *
 * A release check (`releases.started`) is a `git ls-remote` and maybe a
 * fetch per module, and it used to start beside each module's own start —
 * eight network checks and their git processes competing with eight programs
 * booting. None of it changes what is on screen now: a release it finds is put
 * in place at the module's next stop. So it waits until the open kehikko's
 * modules have answered, or `DEFER_FOR_MS` after the host began, whichever is
 * first — a page that never opens a kehikko still gets its checks.
 */

/** How many copies outside the open kehikko are read at once at host start. */
export const BOOT_READS_AT_ONCE = 3

/** What the open pages want running: `wanted` in `lifecycle.ts`. */
export interface WantedNow {
  needed: ReadonlySet<string>
  warm: ReadonlyMap<string, number>
}

/**
 * Which held copies to start reading now. Every copy of a module on an open
 * kehikko that is not already being read, all at once; once none of those is
 * left, and while fewer than `atOnce` others are being read, the next of the
 * rest — the project's other kehikot in their order first, then the remainder
 * by id. `held` is every copy not yet read, those being read included.
 */
export function bootReadsNow(
  held: Iterable<string>,
  reading: ReadonlySet<string>,
  wanted: WantedNow,
  atOnce = BOOT_READS_AT_ONCE,
): string[] {
  const all = [...held]
  const waiting = all.filter((id) => !reading.has(id))
  const now = waiting.filter((id) => wanted.needed.has(id)).sort()
  /* Nothing else competes with the open kehikko's own copies for the disk. */
  if (all.some((id) => wanted.needed.has(id))) return now
  const busy = [...reading].filter((id) => !wanted.needed.has(id)).length
  const room = Math.max(0, atOnce - busy)
  const rest = waiting
    .filter((id) => !wanted.needed.has(id))
    .sort((a, b) => rank(a, wanted) - rank(b, wanted) || a.localeCompare(b))
    .slice(0, room)
  return [...now, ...rest]
}

/** Warm modules by their order, then everything else. */
function rank(id: string, wanted: WantedNow): number {
  return wanted.warm.get(id) ?? Number.MAX_SAFE_INTEGER
}

/** How long after the host began the deferred work goes ahead even with no kehikko up. */
export const DEFER_FOR_MS = 10_000

/**
 * Whether work that is not needed to show the open kehikko may run now: once
 * the open kehikko's modules are up (`upAt`), or `deferFor` after the host
 * began (`began`), whichever comes first.
 */
export function deferredMayRun(now: number, began: number, upAt: number | null, deferFor = DEFER_FOR_MS): boolean {
  return upAt !== null || now - began >= deferFor
}
