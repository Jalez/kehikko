import { hasUpdate, type Place, type Reading } from './updates.ts'

/**
 * A module never waits for an update check before it starts.
 *
 * ## What it used to cost
 *
 * Before an installed copy was started, the host brought it level with its
 * newest release (`level` in `server.ts`): `git ls-remote --tags` and, when a
 * tag was new, a fetch. Measured on three modules from this machine, that is
 * 0.6–2.1 seconds of network per module, once per module per ten minutes —
 * which is every module on the first switch to a kehikko after the app
 * starts, and the largest single part of that switch (the dev server binds
 * in 0.2–0.3 s).
 *
 * ## What happens instead
 *
 * The copy starts as it is. Beside it — never before it — the same check runs
 * (`started`), and what it finds is remembered: a newer release is WAITING.
 * It is put in place when the module is not running: when the host next stops
 * it (the reaper, `server.ts`) or restarts it (a press, or the Updates
 * menu's own Update, which already offers the release). Never under a running
 * module, which is the rule `level` always kept.
 *
 * Putting it in place is local — the check fetched the tags — so it costs a
 * checkout and, when the lockfile moved, the `bun install` an update needs
 * anyway. A module that has never been installed is untouched by any of this:
 * installing (`installs.ts`) still settles the copy on its newest release
 * before the first start.
 *
 * Pure of processes and git: the check and the apply are handed in, which is
 * what lets the order — start first, check after — be tested.
 */

/** What one check found. */
export type Found =
  | { kind: 'current' }
  | { kind: 'waiting'; target: string }
  | { kind: 'held'; why: string }
  | { kind: 'unreadable'; why: string }

/** What a reading of a copy (fetched) says about a newer release. */
export function foundIn(reading: Reading): Found {
  if ('error' in reading) return { kind: 'unreadable', why: reading.error }
  if (!hasUpdate(reading)) {
    return reading.release?.follows === 'ahead' && reading.blocked ? { kind: 'held', why: reading.blocked } : { kind: 'current' }
  }
  if (reading.blocked) return { kind: 'held', why: reading.blocked }
  return { kind: 'waiting', target: reading.release?.target ?? reading.upstream ?? 'its branch' }
}

/** How often a module is checked for a newer release when it starts. */
export const CHECK_AT_MOST_EVERY_MS = 10 * 60_000

export interface ReleaseWaitDeps {
  /** Read the copy, asking the remote. */
  check(place: Place): Promise<Found>
  /** Put the waiting release in place on a copy that is not running. */
  apply(place: Place): Promise<void>
  log(line: string): void
  now?(): number
}

export class ReleaseWaits {
  readonly #deps: ReleaseWaitDeps
  readonly #now: () => number
  #waiting = new Map<string, string>()
  #checkedAt = new Map<string, number>()
  #applying = new Set<string>()

  constructor(deps: ReleaseWaitDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  /**
   * A module has just been started: check it in the background, when a check
   * is due. Returns the check (for a test to await), or null when none ran.
   * Never awaited by the caller — the start has already happened.
   */
  started(place: Place): Promise<void> | null {
    const now = this.#now()
    if (now - (this.#checkedAt.get(place.id) ?? 0) <= CHECK_AT_MOST_EVERY_MS) return null
    this.#checkedAt.set(place.id, now)
    return this.#deps
      .check(place)
      .then((found) => {
        switch (found.kind) {
          case 'current':
            this.#waiting.delete(place.id)
            return
          case 'waiting':
            if (this.#waiting.get(place.id) !== found.target) {
              this.#deps.log(`kehikko: ${place.id} has ${found.target} waiting — it is put in place when ${place.id} next stops or restarts`)
            }
            this.#waiting.set(place.id, found.target)
            return
          case 'held':
            this.#deps.log(`kehikko: ${place.id} stays where it is: ${found.why}`)
            return
          case 'unreadable':
            this.#deps.log(`kehikko: could not check ${place.id} for a newer release: ${found.why}`)
        }
      })
      .catch((error: unknown) => this.#deps.log(`kehikko: could not check ${place.id} for a newer release: ${String(error)}`))
  }

  /** The release waiting for this module, if a check found one. */
  waiting(id: string): string | null {
    return this.#waiting.get(id) ?? null
  }

  /** A waiting release is being put in place right now; the module is not to be started meanwhile. */
  applying(id: string): boolean {
    return this.#applying.has(id)
  }

  /**
   * Put the waiting release in place, on a module the caller has made sure is
   * not running. False when nothing was waiting, or it is already under way.
   */
  async apply(place: Place): Promise<boolean> {
    if (!this.#waiting.has(place.id) || this.#applying.has(place.id)) return false
    this.#applying.add(place.id)
    try {
      await this.#deps.apply(place)
      return true
    } catch (error) {
      this.#deps.log(`kehikko: could not update ${place.id}: ${String(error)}`)
      return false
    } finally {
      this.#waiting.delete(place.id)
      this.#applying.delete(place.id)
    }
  }

  /** A module that is no longer registered stops being remembered. */
  forgetAllBut(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const id of [...this.#waiting.keys()]) if (!keep.has(id)) this.#waiting.delete(id)
    for (const id of [...this.#checkedAt.keys()]) if (!keep.has(id)) this.#checkedAt.delete(id)
  }
}
