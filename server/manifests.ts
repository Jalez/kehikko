import { BUILD_HEADER, buildStamp } from 'kehikot-module-protocol'

import { MANIFEST_TIMEOUT_MS, type Presence } from './discover.ts'
import { ASK_FIRST_MS, nextAsk } from './launch.ts'
import type { Registration } from './registrations.ts'

/**
 * What each module's manifest said, kept: ONE cache per module, so a sweep is not a request to
 * every module.
 *
 * ## Why
 *
 * A sweep used to ask every registered module for its manifest, and the host sweeps on many
 * occasions: the page loading, the page saying what it has open (on every focus), a stream
 * opening, a module ending, the liveness tick. Monitor's record showed each manifest re-read every
 * few seconds with the same answer. What a module serves changes when its PROCESS changes — it is
 * started, restarted, updated, or answered by another program — and those are things this host
 * either does itself or finds out by its liveness check.
 *
 * ## The rule
 *
 * - A presence of a module that answered (`reached`) is kept for `MANIFEST_FRESH_MS`, against the
 *   registration's url; a sweep within that time reads it from here.
 * - A module nothing answers for is kept only for `UNANSWERED_MS`: asking it is a refused
 *   connection, and a sweep must see it soon after somebody starts it in a terminal — but a cold
 *   start asks the same refused port from every sweep in a row (the page's first reads, a stream
 *   opening, a module's server asking), and Monitor's record on 0.1.72 showed every starting
 *   module's manifest fetched 28 times in 9.5 s. Within that short time a sweep reads the refusal.
 * - A module the host has just started is asked by the host's wait for it (`wait`) and by nothing
 *   else: every read while the wait runs is what the wait's last ask found, and the answer that
 *   ends it is kept as any read is, so the sweep after it asks nothing.
 * - `forget(id)` on everything that changes the process: the host starting or stopping it, its
 *   process ending, the liveness check seeing it go, come back, or answer from another build.
 * - `read(…, { fresh: true })` for a person's press ("look again", Start, an install) and for the
 *   checks that must know now (a page saying its module went quiet). A press within
 *   `FRESH_FLOOR_MS` of the last one reads what that one read (`refresh`).
 * - Every reader of a manifest on a page's request goes through a cache: the registered modules'
 *   here, the pinned versions' in `Pins` (one per program), the update check's here.
 * - Two reads of one module at once are one request.
 *
 * The protocol's doors answer with no `ETag` (every reply is `no-store`) and send the build on
 * every reply (`x-module-build`), so there is no conditional request to make; the cheap check is
 * the module's own health door (`probe`), whose build header says whether the same process is
 * answering.
 */

/** How long a manifest that was read stands before a sweep reads it again. */
export const MANIFEST_FRESH_MS = 60_000

/**
 * How long a module that did not answer stands as not answering before a sweep asks it again.
 * Short: it is what stands between somebody starting a module in a terminal and the canvas
 * seeing it, and only a burst of sweeps in a row — a page arriving while modules start — needs it.
 */
export const UNANSWERED_MS = 1_500

/**
 * How soon after one press's fresh read another press reads the kept manifests instead.
 *
 * A press asks every module again, which is right once. Monitor's record on a real machine showed
 * every module's manifest fetched about every twenty seconds under "the page reads the modules";
 * whatever presses in a row, a press within this long of the last one has nothing new to learn
 * that the one before did not already ask.
 */
export const FRESH_FLOOR_MS = 2_000

interface Kept {
  url: string
  at: number
  presence: Presence
}

/** The host's own wait for a module it started: what its last ask found, and its first ask while out. */
interface Waiting {
  url: string
  last: Presence | null
  first: Promise<Presence>
}

/** How the host's wait for a module it started ended. */
export type Waited = { up: true; presence: Presence } | { up: false; presence: Presence | null; cancelled: boolean }

/** Whether a presence is the module answering: anything served at its manifest path, as `answered` in `launch.ts` took an OK reply. */
export const answers = (presence: Presence): boolean => presence.reached && (presence.condition !== 'silent' || presence.served === true)

export interface Probed {
  /** Whether anything answered at all (a refused connection is the only false). */
  reached: boolean
  /** The build the answer named (`x-module-build`), or null when it named none. */
  stamp: string | null
}

export class ManifestCache {
  readonly #look: (registration: Registration) => Promise<Presence>
  readonly #now: () => number
  readonly #freshMs: number
  readonly #floorMs: number
  readonly #keyOf: (registration: Registration) => string
  /** When `refresh` last forgot everything, or null. */
  #refreshedAt: number | null = null
  readonly #kept = new Map<string, Kept>()
  /** What did not answer, and when: kept for `UNANSWERED_MS`. */
  readonly #unanswered = new Map<string, Kept>()
  readonly #unansweredMs: number
  readonly #waiting = new Map<string, Waiting>()
  readonly #sleep: (ms: number) => Promise<void>
  readonly #reading = new Map<string, { url: string; read: Promise<Presence> }>()
  /** Bumped by `forget`, so a read that was out when the module changed is not kept as fresh. */
  readonly #generation = new Map<string, number>()

  /**
   * `keyOf`: what a kept manifest is filed under, the registration's id by default. A cache of
   * several programs per module id (the pinned versions, each on its own port) files them apart.
   */
  constructor(
    look: (registration: Registration) => Promise<Presence>,
    options: {
      now?: () => number
      freshMs?: number
      floorMs?: number
      unansweredMs?: number
      keyOf?: (registration: Registration) => string
      sleep?: (ms: number) => Promise<void>
    } = {},
  ) {
    this.#look = look
    this.#now = options.now ?? Date.now
    this.#freshMs = options.freshMs ?? MANIFEST_FRESH_MS
    this.#unansweredMs = options.unansweredMs ?? UNANSWERED_MS
    this.#sleep = options.sleep ?? ((ms) => new Promise((wake) => setTimeout(wake, ms)))
    this.#floorMs = options.floorMs ?? FRESH_FLOOR_MS
    this.#keyOf = options.keyOf ?? ((registration) => registration.id)
  }

  /**
   * What the module is, from what was kept when it is fresh, otherwise asked (once, however many
   * ask). While the host waits for a module it started, what that wait last found, whoever asks.
   * `kept`: whatever is kept however old, for a sweep that only one module's news calls for.
   */
  read(registration: Registration, { fresh = false, kept: stale = false }: { fresh?: boolean; kept?: boolean } = {}): Promise<Presence> {
    const { url } = registration
    const id = this.#keyOf(registration)
    const waiting = this.#waiting.get(id)
    if (waiting && waiting.url === url) return waiting.last ? Promise.resolve(waiting.last) : waiting.first
    /* `kept`: what was kept, however old, and asked only when nothing is. */
    const kept = this.#kept.get(id)
    if (!fresh && kept && kept.url === url && (stale || this.#now() - kept.at < this.#freshMs)) return Promise.resolve(kept.presence)
    const refused = this.#unanswered.get(id)
    if (!fresh && refused && refused.url === url && (stale || this.#now() - refused.at < this.#unansweredMs)) return Promise.resolve(refused.presence)
    const out = this.#reading.get(id)
    if (out && out.url === url) return out.read
    return this.#ask(registration)
  }

  /** One ask of the module, shared by everyone who asks while it is out, and kept by its outcome. */
  #ask(registration: Registration): Promise<Presence> {
    const { url } = registration
    const id = this.#keyOf(registration)
    const generation = this.#generation.get(id) ?? 0
    const read = this.#look(registration).then(
      (presence) => {
        if (this.#reading.get(id)?.read === read) this.#reading.delete(id)
        if ((this.#generation.get(id) ?? 0) === generation) this.#keep(id, url, presence)
        return presence
      },
      (error: unknown) => {
        if (this.#reading.get(id)?.read === read) this.#reading.delete(id)
        throw error
      },
    )
    this.#reading.set(id, { url, read })
    return read
  }

  #keep(id: string, url: string, presence: Presence): void {
    if (presence.reached) {
      this.#kept.set(id, { url, at: this.#now(), presence })
      this.#unanswered.delete(id)
    } else {
      this.#kept.delete(id)
      this.#unanswered.set(id, { url, at: this.#now(), presence })
    }
  }

  /**
   * The host started this module: ask it until it answers or `within` runs out, at widening
   * intervals (`nextAsk`, from `ASK_FIRST_MS`), and let nothing else ask it meanwhile. The answer
   * that ends the wait is kept, so the sweep after it asks nothing. Ends early, `cancelled`, when
   * the module is forgotten meanwhile (stopped, ended, started again): whoever did that decides.
   */
  async wait(registration: Registration, within: number): Promise<Waited> {
    const { url } = registration
    const id = this.#keyOf(registration)
    const until = this.#now() + within
    const first = this.#look(registration)
    const mine: Waiting = { url, last: null, first }
    this.#waiting.set(id, mine)
    const current = () => this.#waiting.get(id) === mine
    let wait = ASK_FIRST_MS
    let asking: Promise<Presence> = first
    try {
      for (;;) {
        const presence = await asking.catch((): Presence | null => null)
        if (!current()) return { up: false, presence, cancelled: true }
        if (presence) {
          mine.last = presence
          if (answers(presence)) {
            this.#keep(id, url, presence)
            return { up: true, presence }
          }
        }
        const left = until - this.#now()
        if (left <= 0) {
          if (presence) this.#keep(id, url, presence)
          return { up: false, presence, cancelled: false }
        }
        /* Widening, but never past the deadline: the last ask is still made at it. */
        await this.#sleep(Math.max(0, Math.min(wait, left)))
        wait = nextAsk(wait)
        if (!current()) return { up: false, presence: mine.last, cancelled: true }
        asking = this.#look(registration)
      }
    } finally {
      if (current()) this.#waiting.delete(id)
    }
  }

  /** Whether the host is waiting for this module to answer (`wait`). */
  waiting(id: string): boolean {
    return this.#waiting.has(id)
  }

  /** The module's process changed, or may have: the next read asks it. A wait for it ends. */
  forget(id: string): void {
    this.#kept.delete(id)
    this.#unanswered.delete(id)
    this.#reading.delete(id)
    this.#waiting.delete(id)
    this.#generation.set(id, (this.#generation.get(id) ?? 0) + 1)
  }

  /**
   * Every module's process may have changed (a person asked to look again): every next read asks.
   * A wait the host has out goes on: it is already asking, and what it finds is the answer.
   */
  forgetAll(): void {
    for (const id of new Set([...this.#kept.keys(), ...this.#unanswered.keys(), ...this.#reading.keys()])) {
      if (this.#waiting.has(id)) continue
      this.forget(id)
    }
  }

  /**
   * A person's press: `forgetAll`, unless a press already did within `FRESH_FLOOR_MS` — then what
   * that press read stands. True when it forgot, which is when the reads after it are fresh.
   */
  refresh(): boolean {
    const now = this.#now()
    if (this.#refreshedAt !== null && now - this.#refreshedAt < this.#floorMs) return false
    this.#refreshedAt = now
    this.forgetAll()
    return true
  }

  /** Only these keys are kept; the rest were unregistered (or, for versions, stopped). */
  keepOnly(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const id of [...this.#kept.keys()]) if (!keep.has(id)) this.#kept.delete(id)
    for (const id of [...this.#unanswered.keys()]) if (!keep.has(id)) this.#unanswered.delete(id)
  }

  /** When the kept manifest was read, or null when none is kept. */
  readAt(id: string): number | null {
    return this.#kept.get(id)?.at ?? null
  }

  /** The build the kept manifest named, or null. */
  stampOf(id: string): string | null {
    const build = this.#kept.get(id)?.presence.module?.build
    return build ? buildStamp(build) : null
  }
}

/**
 * The cheap question "is the same process still answering there": one GET of the module's health
 * door (its manifest's `health`, `/healthz` for every module built on the protocol's doors),
 * bounded like a manifest. Any answer is "reached" — a 404 is still a program holding the port —
 * and the build it names is read off the header, never the body.
 */
export async function probe(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = MANIFEST_TIMEOUT_MS): Promise<Probed> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: abort.signal, redirect: 'error' })
    /* Not read: the header is the answer. Cancelled so the socket is let go. */
    void response.body?.cancel().catch(() => {})
    return { reached: true, stamp: response.headers.get(BUILD_HEADER) }
  } catch (error) {
    const name = (error as Error)?.name
    return { reached: name === 'AbortError' || name === 'TimeoutError', stamp: null }
  } finally {
    clearTimeout(timer)
  }
}
