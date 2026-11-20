import type { Presence } from '../discover.ts'
import { sweepAfter } from '../sweepAfter.ts'
import { because, reasonNow, SWEEP_REASON } from '../traffic.ts'

/** What the sweeper reads of a survey: the presences, for what each manifest said it holds. */
export interface Surveyed {
  readonly presences: readonly Presence[]
}

export interface SweepDeps<V extends Surveyed = Surveyed> {
  /**
   * Sweep the registry and ask every registered program what it is (`survey` in `server.ts`).
   * `kept`: whatever manifest is kept, however old.
   */
  survey(kept: boolean): Promise<V>
  /** Whether a press's fresh sweep may ask again, or one right before it stands (`ManifestCache.refresh`). */
  refresh(): boolean
  /** Told of each new sweep as it begins, whoever asked for it (the boot window's first look). */
  began?(running: Promise<V>): void
  /* Seam, for tests: the clock. */
  now?: () => number
}

/**
 * The sweep, with two of them never running at once.
 *
 * A sweep is one HTTP request to every registered program. Two overlapping ones
 * are twice that for one answer, and there are now three things that can ask
 * for a sweep at nearly the same moment: the page on load, the page on focus,
 * and a person switching kehikko — which reports what is open and then wants to
 * know what is running there. Whoever asks second gets the answer the first is
 * already waiting for.
 *
 * Safe to share because a sweep is a question about the disk and the ports and
 * about nothing the caller brought with it. What each caller does with the
 * answer differs; the answer does not.
 */
export class Sweeper<V extends Surveyed = Surveyed> {
  readonly #deps: SweepDeps<V>
  readonly #now: () => number
  #sweeping: Promise<V> | null = null
  /** When the sweep out began (`sweepAfter`). */
  #since = 0
  /** Whether the sweep out reads only what is kept (`sweep({ kept: true })`). */
  #kept = false
  /**
   * The last sweep, kept so that stopping does not need a new one.
   *
   * The reaper runs on a timer and the whole point of it is to run when NOBODY is
   * looking — so it must not sweep, because a sweep is thirteen requests, and a
   * host making thirteen requests a minute forever to save memory would be
   * spending the saving on the saving. What it needs from a sweep is one bit per
   * module: is anything there. That bit going stale costs at most one tick of
   * delay in either direction, and `Nursery` refuses anything whose process has
   * since died, so a stale belief cannot become a wrong signal.
   */
  #seen: Promise<V> | null = null

  /**
   * What each module's manifest last said it holds (protocol 2.33.0, `holds`), by id, for what has to
   * be answered without a sweep: whether an automatic update may restart it (`holdsShells`). A module
   * that never answered is not here, which reads as having said nothing.
   */
  readonly holdsSaid = new Map<string, readonly string[] | undefined>()

  constructor(deps: SweepDeps<V>) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  /** The sweep in flight, or null. */
  get sweeping(): Promise<V> | null {
    return this.#sweeping
  }

  /** The last sweep that ended, or null before the first. */
  get seen(): Promise<V> | null {
    return this.#seen
  }

  /**
   * `fresh`: every manifest asked again, not read from `manifests` — for a person's press. A sweep
   * already out may have read kept ones, so a fresh one waits for it and then asks.
   */
  sweep(how: boolean | { kept: true } = false): Promise<V> {
    const fresh = how === true
    const kept = typeof how === 'object'
    const sweeping = this.#sweeping
    /* `refresh` declines a press right behind another press: what that one read stands. */
    if (fresh && this.#deps.refresh()) {
      if (sweeping) return sweeping.catch(() => null).then(() => this.sweep())
    }
    /* A sweep of what is kept may share any sweep out; any other does not share one of those. */
    if (sweeping && (kept || !this.#kept)) return sweeping
    if (sweeping) return sweeping.catch(() => null).then(() => this.sweep(how))
    /* A sweep is shared by whoever asks next, and is asked from callbacks with no reason of their own:
       it says its own, unless the one that started it gave a nearer one. */
    const running = because(reasonNow() ?? SWEEP_REASON, () => this.#deps.survey(kept)).finally(() => {
      if (this.#sweeping === running) this.#sweeping = null
      this.#seen = running
    })
    void running.then((swept) => {
      for (const presence of swept.presences) if (presence.module) this.holdsSaid.set(presence.id, presence.module.holds)
    }, () => undefined)
    this.#sweeping = running
    this.#since = this.#now()
    this.#kept = kept
    this.#deps.began?.(running)
    return running
  }

  /** A sweep that began at or after `at`: see `sweepAfter.ts`. What a start reads once its module answered. */
  sweepSince(at: number): Promise<V> {
    return sweepAfter(() => (this.#sweeping ? { running: this.#sweeping, since: this.#since } : null), at, () => this.sweep())
  }
}
