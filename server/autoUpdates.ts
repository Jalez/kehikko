import type { Database } from 'bun:sqlite'

import {
  AUTO_UPDATES_DEFAULT,
  decide,
  isMajor,
  type AutoDone,
  type AutoTold,
  type AutoWait,
  type Candidate,
  type Decision,
} from '../src/host/autoUpdates.ts'
import { releaseVersion } from '../src/host/moduleReleases.ts'
import type { Checkout, Reading } from './updates.ts'

/**
 * "Keep modules up to date automatically": the switch, and the one thing that
 * acts on it. The rule (`decide`) and the words are `src/host/autoUpdates.ts`.
 *
 * ## No check of its own
 *
 * It never asks the network. It is handed what the checks that already run
 * read — the page's quiet check (`fetch=1&quiet=1`, compare-only), Check now,
 * and the check beside a start (`releaseWait.ts`) — and the copies' own tags
 * at host start (`boot`), which those checks fetched. Putting an update in
 * place is `update()` through the caller (`apply`), the same path as a press:
 * checkout, `bun install --frozen-lockfile`, build.
 *
 * ## When
 *
 * One at a time, in the order found. A module that may not be updated now —
 * on screen, holding sessions — is remembered and decided again whenever the
 * host decides what runs (`moved`): it goes when it is off screen or stopped.
 * A failure is not tried again before the next check (`RETRY_AFTER_MS`).
 *
 * ## At restart
 *
 * When the host starts, every installed copy whose own tags hold a newer
 * release it can run is put on it before the module is first started (`boot`),
 * so the app's own "Restart to update" brings the waiting modules along.
 */

const KEY = 'module-updates'

export function readAutoUpdates(db: Database): boolean {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    if (!row) return AUTO_UPDATES_DEFAULT
    const stored = JSON.parse(row.value) as unknown
    return typeof stored === 'object' && stored !== null && typeof (stored as { auto?: unknown }).auto === 'boolean'
      ? (stored as { auto: boolean }).auto
      : AUTO_UPDATES_DEFAULT
  } catch {
    return AUTO_UPDATES_DEFAULT
  }
}

export function writeAutoUpdates(db: Database, auto: boolean): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(KEY, JSON.stringify({ auto }))
}

/** A change the route takes: `{ auto: boolean }`, or null for anything else. */
export function autoUpdatesChange(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const auto = (body as { auto?: unknown }).auto
  return typeof auto === 'boolean' ? auto : null
}

/** What the server knows about one module now, beside its reading. Null when it is not registered any more. */
export type Facts = Omit<Candidate, 'on' | 'reading' | 'failed' | 'checking' | 'now'> & { name: string }

/** What putting one update in place came to. `skipped`: there was nothing to do by then (another update took it). */
export type Applied = { ok: true; checkout: Reading | null } | { ok: false; why: string } | { ok: 'skipped' }

export interface AutoUpdatesDeps {
  /** The switch, as it is now. */
  on(): boolean
  facts(id: string): Facts | null
  /** Put the update in place: `update()` with the restart rules of a press. */
  apply(id: string): Promise<Applied>
  /** Something a page shows changed: an update began or ended, or a wait. */
  changed(): void
  log(line: string): void
  now?(): number
}

/** How many finished updates are said in the Updates menu. */
const UPDATED_KEPT = 20

export class AutoUpdates {
  readonly #deps: AutoUpdatesDeps
  readonly #now: () => number
  /** The last reading of each installed copy a check handed in. */
  #readings = new Map<string, Checkout>()
  #waiting = new Map<string, AutoWait>()
  #failed = new Map<string, { target: string; at: number; why: string }>()
  #updated: AutoDone[] = []
  #queue: string[] = []
  #current: string | null = null
  #draining: Promise<void> | null = null

  constructor(deps: AutoUpdatesDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  /** A check read these copies: decide each, and take what may be taken now. */
  found(readings: readonly Reading[]): Promise<void> {
    for (const reading of readings) {
      if ('error' in reading) continue
      this.#readings.set(reading.id, reading)
      this.#decide(reading.id, true)
    }
    return this.#drain()
  }

  /**
   * The host decided again what runs (a sweep, a kehikko opened or left, a
   * module stopped): what was waiting to be off screen or stopped may go now.
   * Local and synchronous up to the start of an update.
   */
  moved(): Promise<void> {
    if (!this.#waiting.size) return this.#draining ?? Promise.resolve()
    for (const id of [...this.#waiting.keys()]) this.#decide(id, false)
    return this.#drain()
  }

  /** The switch was turned: on, what the last checks found is decided again; off, nothing waits. */
  turned(on: boolean): Promise<void> {
    if (!on) {
      this.#waiting.clear()
      this.#queue = []
      this.#deps.changed()
      return this.#draining ?? Promise.resolve()
    }
    for (const id of this.#readings.keys()) this.#decide(id, true)
    this.#deps.changed()
    return this.#drain()
  }

  /** Queued or being put in place: the module is not to be started meanwhile. */
  pending(id: string): boolean {
    return this.#current === id || this.#queue.includes(id)
  }

  /** Why one module's update waits, if it does. */
  waiting(id: string): AutoWait | null {
    return this.#waiting.get(id) ?? null
  }

  said(): AutoTold {
    return { on: this.#deps.on(), waiting: Object.fromEntries(this.#waiting), updated: [...this.#updated] }
  }

  /** A person's own update finished on it: what was read before it, and any wait, is out of date. */
  settled(id: string): void {
    this.#readings.delete(id)
    this.#failed.delete(id)
    if (this.#waiting.delete(id)) this.#deps.changed()
  }

  /** Modules no longer registered are forgotten. */
  forgetAllBut(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const map of [this.#readings, this.#waiting, this.#failed] as Map<string, unknown>[]) {
      for (const id of [...map.keys()]) if (!keep.has(id)) map.delete(id)
    }
  }

  #candidate(id: string, checking: boolean): { decision: Decision; name: string } | null {
    const facts = this.#deps.facts(id)
    const reading = this.#readings.get(id) ?? null
    if (!facts) return null
    const { name, ...rest } = facts
    const decision = decide({
      ...rest,
      on: this.#deps.on(),
      reading,
      failed: this.#failed.get(id) ?? null,
      checking,
      now: this.#now(),
    })
    return { decision, name }
  }

  #decide(id: string, checking: boolean): void {
    if (this.pending(id)) return
    const was = this.#waiting.get(id)
    const got = this.#candidate(id, checking)
    const decision = got?.decision ?? { do: 'nothing' as const }
    if (decision.do === 'now') {
      this.#waiting.delete(id)
      this.#queue.push(id)
    } else if (decision.do === 'wait') {
      const { do: _do, ...wait } = decision
      this.#waiting.set(id, wait)
      if (!was || was.until !== wait.until || was.target !== wait.target) {
        if (got) this.#deps.log(`kehikko: ${id} has ${wait.target ?? 'a newer release'} — not updated automatically yet (${wait.until})`)
      }
    } else this.#waiting.delete(id)
    if (JSON.stringify(was ?? null) !== JSON.stringify(this.#waiting.get(id) ?? null)) this.#deps.changed()
  }

  #drain(): Promise<void> {
    if (this.#draining) return this.#draining
    if (!this.#queue.length) return Promise.resolve()
    this.#draining = (async () => {
      try {
        while (this.#queue.length) {
          const id = this.#queue[0]!
          this.#current = id
          this.#queue.shift()
          await this.#one(id)
          this.#current = null
        }
      } finally {
        this.#current = null
        this.#draining = null
      }
    })()
    return this.#draining
  }

  async #one(id: string): Promise<void> {
    /* Decided again from what is true now: it may have come on screen, or a person may be updating it.
       Still as the check that queued it, which already judged a failure due again. */
    const got = this.#candidate(id, true)
    if (!got) return
    if (got.decision.do !== 'now') {
      if (got.decision.do === 'wait') {
        const { do: _do, ...wait } = got.decision
        this.#waiting.set(id, wait)
        this.#deps.changed()
      }
      return
    }
    const reading = this.#readings.get(id)!
    const from = reading.release?.installed ?? null
    const target = got.decision.target
    this.#deps.log(`kehikko: updating ${id} to ${target} automatically`)
    this.#deps.changed()
    const applied = await this.#deps.apply(id).catch((error: unknown): Applied => ({ ok: false, why: String(error) }))
    if (applied.ok === 'skipped') {
      this.#readings.delete(id)
    } else if (applied.ok) {
      this.#failed.delete(id)
      if (applied.checkout && !('error' in applied.checkout)) this.#readings.set(id, applied.checkout)
      else this.#readings.delete(id)
      this.#updated.unshift({
        id,
        name: got.name,
        from: from ? releaseVersion(from) : null,
        to: releaseVersion(target),
        at: new Date(this.#now()).toISOString(),
        major: isMajor(from, target),
      })
      this.#updated.length = Math.min(this.#updated.length, UPDATED_KEPT)
    } else {
      this.#failed.set(id, { target, at: this.#now(), why: applied.why })
      this.#waiting.set(id, { until: 'retry', target, detail: applied.why, major: isMajor(from, target) })
      this.#deps.log(`kehikko: could not update ${id} to ${target} automatically: ${applied.why} — tried again at the next check`)
    }
    this.#deps.changed()
  }
}
