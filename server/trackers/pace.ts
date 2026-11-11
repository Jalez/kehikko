import type { Ran, Runner } from '../feedback.ts'

/**
 * How long a tracker host is given to answer, and how much one query asks of
 * it, learned per host (Jalez/kehikko#317).
 *
 * ## Why not one fixed limit
 *
 * A query can be under a tracker's complexity limit and still take longer than
 * any one fixed timeout: a self-hosted GitLab answered a hundred merge requests
 * with their approvals, notes and pipelines in 24 to 27 seconds, so the host's
 * own, larger query went over 30 s every time and the rows stayed stale for
 * good. So:
 *
 * - a host starts at `BASE_MS` when it is one of the public ones and at
 *   `SELF_HOSTED_MS` when it is somebody's own instance;
 * - a call that runs over doubles that host's limit (up to `MAX_MS`) for the
 *   next call, and the caller asks for less at a time;
 * - a call that took more than half its limit makes the next query smaller,
 *   and the limit at least `SLOW_FACTOR` times what it took; a call that took
 *   under a fifth lets the query grow back, a little at a time, towards its full size, and the
 *   limit settle back towards where it started.
 *
 * Kept in memory only: a restart starts from the defaults and learns again in
 * a read or two.
 */

/** The hosts everyone shares; any other is somebody's own instance. */
const PUBLIC_HOSTS = new Set(['github.com', 'gitlab.com'])

/** What a public host is given at first. */
export const BASE_MS = 30_000
/** What a self-hosted instance is given at first: slower machines, heavier queries. */
export const SELF_HOSTED_MS = 90_000
/** The longest anything is given. */
export const MAX_MS = 300_000
/** A slow answer makes the limit at least this many times what it took. */
const SLOW_FACTOR = 3
/**
 * How much of a full query a fast answer adds back. Halved on trouble, grown back
 * a sixteenth at a time: a host that just ran over is not asked for all of it
 * again two answers later.
 */
const GROW = 1 / 16
/** The smallest part of a full query a host is asked for. */
const MIN_SCALE = 1 / 64

/** Where a host's limit starts, and the floor it settles back to. */
export const startingLimit = (host: string): number => (PUBLIC_HOSTS.has(host) ? BASE_MS : SELF_HOSTED_MS)

interface HostPace {
  limit: number
  /** The part of a full query the host is asked for, 1 = all of it. */
  scale: number
}

export class Pace {
  #hosts = new Map<string, HostPace>()

  #of(host: string): HostPace {
    let one = this.#hosts.get(host)
    if (!one) {
      one = { limit: startingLimit(host), scale: 1 }
      this.#hosts.set(host, one)
    }
    return one
  }

  /** How long the next call to this host may take, in milliseconds. */
  limitMs(host: string): number {
    return this.#of(host).limit
  }

  /** How many items the next query to this host asks for, out of `full`; at least one. */
  size(host: string, full: number): number {
    return Math.max(1, Math.min(full, Math.round(full * this.#of(host).scale)))
  }

  /** What one call came to: how long it took, and whether it ran over its limit. */
  heard(host: string, tookMs: number, timedOut: boolean): void {
    const one = this.#of(host)
    const floor = startingLimit(host)
    if (timedOut) {
      one.limit = Math.min(MAX_MS, one.limit * 2)
      one.scale = Math.max(MIN_SCALE, one.scale / 2)
      return
    }
    if (tookMs > one.limit / 2) {
      one.scale = Math.max(MIN_SCALE, one.scale / 2)
      one.limit = Math.min(MAX_MS, Math.max(one.limit, Math.ceil(tookMs * SLOW_FACTOR)))
    } else if (tookMs < one.limit / 5) {
      one.scale = Math.min(1, one.scale + GROW)
      one.limit = Math.max(floor, Math.max(Math.ceil(tookMs * SLOW_FACTOR), Math.round(one.limit * 0.9)))
    }
  }

  /**
   * A runner that gives each call this host's limit and learns from it. A call
   * that ran over says how long it was given (`waitedMs`), for the sentence.
   */
  runner(run: Runner, clock: () => number = Date.now): (argv: string[], host: string) => Promise<Ran> {
    return async (argv, host) => {
      const limit = this.limitMs(host)
      const started = clock()
      const ran = await run(argv, { timeout: limit })
      const timedOut = ran.timedOut === true
      if (!ran.missing && !ran.held) this.heard(host, clock() - started, timedOut)
      return timedOut ? { ...ran, waitedMs: limit } : ran
    }
  }
}
