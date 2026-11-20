import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'

import {
  LIMITS,
  RESTART_REASON_ENV,
  RESTART_VERSION_ENV,
  WORK_QUEUE,
  serviceDescriptor,
  workHoldResult,
  type RestartReason,
  type RestartReleaseParams,
  type RestartReleaseResult,
} from 'kehikot-module-protocol'

/**
 * An app restart that waits for queued work, and why a module was started again (protocol 2.110.0).
 *
 * ## Why, for the modules this host starts
 *
 * An agent module wakes the conversations a restart cut off with one sentence that says why
 * (`resumeLine(restartOf())`). The host is what knows why, so it passes `KEHIKOT_RESTART_REASON` (and
 * `KEHIKOT_RESTART_VERSION` for an update) to the modules it starts:
 *
 * - **after an app restart it asked for**: the reason is saved in `frame.sqlite` just before
 *   (`writeRestartReason`), read once by the next host (`takeRestartReason`, only when fresh), and
 *   given to every module started in its first minutes (`BOOT_WINDOW_MS`);
 * - **after it updated or restarted one module**: `module-update` or `module-restart` for that
 *   module's next start only (`RestartEnv.note`).
 *
 * Anything else (a crash, the computer restarting, an older host) passes nothing, and a module says
 * a plain restart.
 *
 * ## Holding the restart behind queued work
 *
 * "Restart to update" asks the `work.queue` provider that says `hold` to hold it behind the runs
 * ahead of it (`RestartHold.ask`); the host names no provider of its own accord. Held, it waits for
 * `restart.release` with its token: `go: true` restarts, `go: false` (the person cancelled it in the
 * queue) does not. No provider, none that holds, or one that does not answer: the restart goes now.
 * "Restart now" goes past a hold (`drop`); a release for a token no longer held is `unknown`.
 */

const SETTING = 'restart-reason'
/** How old a saved reason may be for the next host to believe it: a restart takes seconds, not this. */
export const REASON_FRESH_MS = 10 * 60_000
/** How long after its start a host gives the saved reason to the modules it starts. */
export const BOOT_WINDOW_MS = 10 * 60_000
/** How long a work queue gets to answer a hold. */
export const HOLD_ANSWER_MS = 3_000

export interface RestartWhy {
  reason: RestartReason
  version: string | null
}

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/
const versionOrNull = (version: unknown): string | null => (typeof version === 'string' && VERSION.test(version) ? version : null)

function settings(db: Database): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
}

/** Saved just before this host asks for an app restart, for the next host to read once. */
export function writeRestartReason(db: Database, why: RestartWhy, now = Date.now()): void {
  settings(db)
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(SETTING, JSON.stringify({ ...why, at: now }))
}

/** The reason the last host saved, taken (so it is read once), when it is fresh; null otherwise. */
export function takeRestartReason(db: Database, now = Date.now()): RestartWhy | null {
  try {
    settings(db)
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(SETTING)
    if (!row) return null
    db.query('delete from settings where key = ?').run(SETTING)
    const said = JSON.parse(row.value) as { reason?: unknown; version?: unknown; at?: unknown }
    if (said.reason !== 'app-update' && said.reason !== 'app-restart') return null
    if (typeof said.at !== 'number' || now - said.at > REASON_FRESH_MS || now < said.at) return null
    return { reason: said.reason, version: versionOrNull(said.version) }
  } catch {
    return null
  }
}

/** The environment for the reason a module is being started, per module. */
export class RestartEnv {
  readonly #noted = new Map<string, RestartWhy>()
  constructor(
    readonly boot: RestartWhy | null,
    readonly bootAt: number,
    readonly clock: () => number = Date.now,
  ) {}

  /** This host is about to update or restart `id`: its next start says so. */
  note(id: string, reason: 'module-update' | 'module-restart', version: string | null = null): void {
    this.#noted.set(id, { reason, version: versionOrNull(version) })
  }

  /** The variables for `id`'s start now: what was noted for it (taken), else the app's in the first minutes. */
  envFor(id: string | undefined): Record<string, string> {
    const noted = id ? this.#noted.get(id) : undefined
    if (id && noted) this.#noted.delete(id)
    const why = noted ?? (this.boot && this.clock() - this.bootAt <= BOOT_WINDOW_MS ? this.boot : null)
    if (!why) return {}
    return { [RESTART_REASON_ENV]: why.reason, ...(why.version ? { [RESTART_VERSION_ENV]: why.version } : {}) }
  }
}

/** A provider of `work.queue` as the host's services answer it. */
export interface QueueProvider {
  module: string
  name: string
  descriptor: unknown
}

export interface HoldDeps {
  /** The providers of `work.queue` in use here. */
  providers(): QueueProvider[]
  /** POST to a module's service path as this host, vouched (`callModule`). Throws with words. */
  call(module: string, path: string, body: unknown, ms: number): Promise<unknown>
  clock?: () => number
  token?: () => string
}

/** What a held restart is, as the page reads it. */
export interface HeldRestart {
  reason: 'app-update' | 'app-restart'
  version: string | null
  /** The provider's name ("Queue"), as it says it. */
  by: string
  ahead: number
  at: number
}

export type HoldAsked = { held: true; restart: HeldRestart } | { held: false; why: string | null }

export class RestartHold {
  #held: (HeldRestart & { token: string; module: string }) | null = null
  constructor(readonly deps: HoldDeps) {}

  /** The restart held now, without its token; null when none is. */
  state(): HeldRestart | null {
    if (!this.#held) return null
    const { token: _token, module: _module, ...rest } = this.#held
    return rest
  }

  /**
   * Ask the work queue to hold this restart behind the runs ahead of it. Not held (go now) when no
   * provider holds, nothing is ahead, or the provider could not be asked; `why` says which.
   */
  async ask(why: { reason: 'app-update' | 'app-restart'; version: string | null; label: string }): Promise<HoldAsked> {
    const provider = this.deps.providers().map((one) => ({ one, descriptor: serviceDescriptor(WORK_QUEUE, one.descriptor) })).find((it) => it.descriptor?.hold)
    if (!provider) return { held: false, why: null }
    const token = (this.deps.token ?? (() => randomBytes(18).toString('base64url')))()
    try {
      const got = workHoldResult.safeParse(
        await this.deps.call(provider.one.module, provider.descriptor!.hold!, { token, reason: why.reason, label: why.label.slice(0, LIMITS.TITLE) }, HOLD_ANSWER_MS),
      )
      if (!got.success) return { held: false, why: `${provider.one.name} answered in a shape Kehikot does not read.` }
      if (!got.data.held) return { held: false, why: got.data.why || null }
      this.#held = { token, module: provider.one.module, reason: why.reason, version: versionOrNull(why.version), by: provider.one.name, ahead: got.data.ahead, at: (this.deps.clock ?? Date.now)() }
      return { held: true, restart: this.state()! }
    } catch (error) {
      return { held: false, why: `${provider.one.name} could not be asked to hold it (${error instanceof Error ? error.message : String(error)}).` }
    }
  }

  /**
   * `restart.release` from a module's server: only the provider that holds it, with its token. `go`
   * hands back what to restart for; `cancelled` lets it go.
   */
  release(module: string, params: RestartReleaseParams): RestartReleaseResult & { restart?: RestartWhy } {
    const held = this.#held
    if (!held || held.module !== module || held.token !== params.token) return { outcome: 'unknown', why: 'Kehikot holds no restart under that token.' }
    this.#held = null
    if (!params.go) return { outcome: 'cancelled', why: '' }
    return { outcome: 'restarting', why: '', restart: { reason: held.reason, version: held.version } }
  }

  /** "Restart now", or the restart went another way: whatever was held is let go. */
  drop(): HeldRestart | null {
    const was = this.state()
    this.#held = null
    return was
  }
}
