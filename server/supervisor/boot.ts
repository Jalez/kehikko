import type { Presence } from '../discover.ts'
import { bootReadsNow, DEFER_FOR_MS, deferredMayRun, type WantedNow } from '../startOrder.ts'
import type { Place, Reading } from '../updates.ts'

/** How long, at most, a module is held back at host start while its copy is read. */
export const BOOT_READ_MS = 8_000

/** What the boot window reads of a sweep: the presences. */
export interface Booted {
  readonly presences: readonly Presence[]
}

export interface BootDeps<V extends Booted = Booted> {
  /** Whether "Keep modules up to date automatically" was on when this host started (`readAutoUpdates`). */
  autoUpdates: boolean
  /** Whether a registered module is an installed copy. */
  isInstalled(id: string): boolean
  /** The ids registered now. */
  registered(): Iterable<string>
  /** An installed module's place; null for anything else. */
  installedPlace(id: string): Place | null
  /** Read a copy's checkout, without a fetch (`readCheckout` in `updates.ts`). */
  readCheckout(place: Place): Promise<Reading>
  /** A copy read with a newer release it can run: queued, and held back from here (`auto.found`). */
  found(reading: Reading): void
  /** What the open pages want now (`wantedNow`). */
  wanted(): WantedNow
  /** The last sweep, or null before the first. */
  seen(): Promise<V> | null
  /** See a module somebody else was running, so the host does not start a copy of its own (`Supervisor.notice`). */
  notice(presences: readonly Presence[], now: number): void
  /** Decide and act, from a sweep in hand (`Supervisor.govern`). */
  govern(presences: readonly Presence[]): void
  /** Tell the pages, with the reading. */
  told(view: V): Promise<void>
  /** A release check, beside a start (`releases.started`). */
  check(place: Place): void
  startup: { mark(step: string): void; at(step: string): number | null }
  /* Seams, for tests: the clock and timers. */
  now?: () => number
  /** Run `fn` once after `ms`, never keeping the process up for it. */
  after?: (ms: number, fn: () => void) => void
}

/**
 * The host's first moments, and what waits for them.
 *
 * At host start, with the switch on: every installed copy whose own tags hold
 * a newer release it can run — fetched by a check before the restart — is put
 * on it before the module is first started, so "Restart to update" brings the
 * modules along in the same restart. Nothing is asked of the network; a copy
 * read takes a few git calls. Until its own copy is read, a module is not
 * started (`holds`, at most `BOOT_READ_MS`) — and the copies of the modules
 * on screen are read first, all together, the rest a few at a time
 * (`bootReadsNow` in `startOrder.ts`, which says why).
 *
 * And a release check waits until the open kehikko is up, or `DEFER_FOR_MS` after this host began:
 * see `deferredMayRun` in `startOrder.ts`. Held by module, so a module started twice meanwhile is
 * checked once (`checkWhenUp`).
 */
export class BootWindow<V extends Booted = Booted> {
  readonly #deps: BootDeps<V>
  readonly #now: () => number
  readonly #after: (ms: number, fn: () => void) => void
  /**
   * At host start, with "Keep modules up to date automatically" on, an installed copy is not started
   * until its own tags were read (`firstLook`, on the first sweep): `booting` until then.
   */
  #booting: boolean
  #read = false
  /** Installed copies not yet read at this start, each held back from starting until it is. */
  readonly #held = new Map<string, Place>()
  /** The held copies being read now. */
  readonly #reading = new Set<string>()
  #lettingGo = false
  readonly #began: number
  readonly #heldChecks = new Map<string, Place>()

  constructor(deps: BootDeps<V>) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
    this.#after = deps.after ?? ((ms, fn) => void setTimeout(fn, ms).unref?.())
    this.#booting = deps.autoUpdates
    this.#began = this.#now()
  }

  /** Whether this module is held back at host start: every installed copy until the first sweep, then each until its copy is read. */
  holds(id: string): boolean {
    return this.#held.has(id) || (this.#booting && this.#deps.isInstalled(id))
  }

  /** Whether the first look is still to come: the first sweep is when it is taken (`firstLook`). */
  get waiting(): boolean {
    return this.#booting && !this.#read
  }

  /** Called with the host's first sweep, whoever asked for it: no sweep of its own. */
  async firstLook(first: Promise<V>): Promise<void> {
    if (!this.#booting || this.#read) return
    this.#read = true
    const { startup } = this.#deps
    startup.mark('auto-update first look begins')
    /* What answers now: a module kept running across the restart is running, and waits for its stop. */
    const view = await first.catch(() => null)
    if (view) {
      this.#deps.notice(view.presences, this.#now())
      for (const id of this.#deps.registered()) {
        const place = this.#deps.installedPlace(id)
        if (place) this.#held.set(id, place)
      }
    }
    this.#booting = false
    if (!this.#held.size) return this.#done()
    /* The cap: whatever is still held starts as it is, and its read, when it lands, changes nothing. */
    this.#after(BOOT_READ_MS, () => {
      if (!this.#held.size) return
      this.#held.clear()
      this.#done()
    })
    this.pump()
  }

  /** Start reading the held copies `bootReadsNow` picks; each one read is let go, and the next picked. */
  pump(): void {
    if (!this.#held.size) return
    for (const id of bootReadsNow(this.#held.keys(), this.#reading, this.#deps.wanted())) {
      const place = this.#held.get(id)
      if (!place) continue
      this.#reading.add(id)
      void this.#deps.readCheckout(place)
        .catch(() => null)
        .then((reading) => {
          this.#reading.delete(id)
          /* Let go by the cap meanwhile: it has started as it was. */
          if (!this.#held.delete(id)) return
          /* Queued synchronously: from here `auto.pending` holds it back. */
          if (reading) this.#deps.found(reading)
          if (!this.#held.size) return this.#done()
          this.#letGo()
          this.pump()
        })
    }
  }

  #done(): void {
    this.#deps.startup.mark('auto-update first look done')
    this.#letGo()
  }

  /**
   * What was held back starts now, decided from the sweep in hand: nothing is asked again. The pages
   * are told with that reading: a copy held back that is not started now no longer says "starting",
   * and none of them asks for it. Several copies read in one moment are let go together.
   */
  #letGo(): void {
    if (this.#lettingGo || !this.#deps.seen()) return
    this.#lettingGo = true
    this.#after(0, () => {
      this.#lettingGo = false
      const seen = this.#deps.seen()
      if (!seen) return
      void seen
        .then(async (view) => {
          this.#deps.govern(view.presences)
          await this.#deps.told(view)
        })
        .catch(() => null)
    })
  }

  /** A release check for a module just started: now, or once the open kehikko is up (`deferredMayRun`). */
  checkWhenUp(place: Place): void {
    if (deferredMayRun(this.#now(), this.#began, this.#deps.startup.at('open kehikko up'))) this.#deps.check(place)
    else this.#heldChecks.set(place.id, place)
  }

  /** The release checks held until now: run once each. */
  runHeldChecks(): void {
    if (!this.#heldChecks.size) return
    this.#deps.startup.mark('held release checks run')
    for (const place of this.#heldChecks.values()) this.#deps.check(place)
    this.#heldChecks.clear()
  }

  /** The held checks go ahead `DEFER_FOR_MS` after the host began, even with no kehikko up. */
  start(): void {
    this.#after(DEFER_FOR_MS, () => this.runHeldChecks())
  }
}
