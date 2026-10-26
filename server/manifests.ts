import { BUILD_HEADER, buildStamp } from 'kehikot-module-protocol'

import { MANIFEST_TIMEOUT_MS, type Presence } from './discover.ts'
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
 * - A module nothing answers for is never kept: asking it is a refused connection, and the next
 *   sweep must see it the moment somebody starts it in a terminal.
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
  readonly #reading = new Map<string, { url: string; read: Promise<Presence> }>()
  /** Bumped by `forget`, so a read that was out when the module changed is not kept as fresh. */
  readonly #generation = new Map<string, number>()

  /**
   * `keyOf`: what a kept manifest is filed under, the registration's id by default. A cache of
   * several programs per module id (the pinned versions, each on its own port) files them apart.
   */
  constructor(
    look: (registration: Registration) => Promise<Presence>,
    options: { now?: () => number; freshMs?: number; floorMs?: number; keyOf?: (registration: Registration) => string } = {},
  ) {
    this.#look = look
    this.#now = options.now ?? Date.now
    this.#freshMs = options.freshMs ?? MANIFEST_FRESH_MS
    this.#floorMs = options.floorMs ?? FRESH_FLOOR_MS
    this.#keyOf = options.keyOf ?? ((registration) => registration.id)
  }

  /** What the module is, from what was kept when it is fresh, otherwise asked (once, however many ask). */
  read(registration: Registration, { fresh = false }: { fresh?: boolean } = {}): Promise<Presence> {
    const { url } = registration
    const id = this.#keyOf(registration)
    const kept = this.#kept.get(id)
    if (!fresh && kept && kept.url === url && this.#now() - kept.at < this.#freshMs) return Promise.resolve(kept.presence)
    const out = this.#reading.get(id)
    if (out && out.url === url) return out.read
    const generation = this.#generation.get(id) ?? 0
    const read = this.#look(registration).then(
      (presence) => {
        if (this.#reading.get(id)?.read === read) this.#reading.delete(id)
        if ((this.#generation.get(id) ?? 0) === generation) {
          if (presence.reached) this.#kept.set(id, { url, at: this.#now(), presence })
          else this.#kept.delete(id)
        }
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

  /** The module's process changed, or may have: the next read asks it. */
  forget(id: string): void {
    this.#kept.delete(id)
    this.#reading.delete(id)
    this.#generation.set(id, (this.#generation.get(id) ?? 0) + 1)
  }

  /** Every module's process may have changed (a person asked to look again): every next read asks. */
  forgetAll(): void {
    for (const id of new Set([...this.#kept.keys(), ...this.#reading.keys()])) this.forget(id)
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
