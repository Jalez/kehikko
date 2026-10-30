import type { Database } from 'bun:sqlite'

import type { Me } from './trackers/common.ts'
import { isLogin } from '../src/host/whatsNewMentions.ts'

/**
 * Who the person is on each forge, kept for this machine: the login per
 * `tracker|host` (`github|github.com`, `gitlab|gitlab.example.com`) — the same
 * key the tracker reading uses.
 *
 * ## Where a login comes from
 *
 *  - The tracker reading already asks (`gh api user`, `glab api user`, through
 *    the person's own CLI and its login — no credential is read here) and
 *    tells every landed read who the person is (`learned`). That is free.
 *  - When a login is wanted and none is held (`login`), it is asked ONCE through
 *    the same adapter and the reading's own short memory (`Trackers.me`), and
 *    kept. A login held is used for `FRESH_MS` before it is asked again; a
 *    failed ask is not repeated for `RETRY_MS`, and the login held before
 *    stays in use meanwhile.
 *
 * Machine level, in `frame.sqlite`: who you are on a forge is not a fact about
 * a project, and never travels with one.
 */

/** How long a login is used before it is asked again. Tracker reads keep it fresh for free. */
export const FRESH_MS = 7 * 24 * 60 * 60_000
/** After a failed ask, how long before another. */
export const RETRY_MS = 60 * 60_000

export function ensureForgeLogins(db: Database): void {
  db.exec(`
    create table if not exists forge_logins (
      forge text primary key,
      login text not null,
      at    integer not null
    );
  `)
}

export type AskMe = (tracker: 'github' | 'gitlab', host: string) => Promise<Me | null>

export class ForgeLogins {
  #failed = new Map<string, number>()
  #asking = new Map<string, Promise<string | null>>()

  constructor(
    private readonly db: Database,
    private readonly ask: AskMe,
    private readonly clock: () => number = () => Date.now(),
  ) {
    ensureForgeLogins(db)
  }

  #held(forge: string): { login: string; at: number } | null {
    const row = this.db.query<{ login: string; at: number }, [string]>('select login, at from forge_logins where forge = ?').get(forge)
    return row && isLogin(row.login) ? row : null
  }

  #keep(forge: string, login: string): void {
    this.db
      .query('insert into forge_logins (forge, login, at) values (?, ?, ?) on conflict (forge) do update set login = excluded.login, at = excluded.at')
      .run(forge, login, this.clock())
  }

  /** What a tracker read learned, by `tracker|host`. Never throws. */
  learned(me: ReadonlyMap<string, string>): void {
    try {
      for (const [forge, login] of me) if (isLogin(login)) this.#keep(forge, login)
    } catch {
      /* A login not kept is asked for when it is next wanted. */
    }
  }

  /** The login held for a forge, without asking anything. */
  known(tracker: 'github' | 'gitlab', host: string): string | null {
    try {
      return this.#held(`${tracker}|${host}`)?.login ?? null
    } catch {
      return null
    }
  }

  /** The person's login on a forge: held, or asked once and kept. Null when it is not known. Never throws. */
  login(tracker: 'github' | 'gitlab', host: string): Promise<string | null> {
    const forge = `${tracker}|${host}`
    let held: { login: string; at: number } | null = null
    try {
      held = this.#held(forge)
    } catch {
      held = null
    }
    const now = this.clock()
    if (held && now - held.at < FRESH_MS) return Promise.resolve(held.login)
    const failed = this.#failed.get(forge)
    if (failed !== undefined && now - failed < RETRY_MS) return Promise.resolve(held?.login ?? null)
    const out = this.#asking.get(forge)
    if (out) return out
    const asking = (async () => {
      try {
        const me = await this.ask(tracker, host)
        if (me && 'login' in me && isLogin(me.login)) {
          this.#keep(forge, me.login)
          this.#failed.delete(forge)
          return me.login
        }
      } catch {
        /* Said as not known below. */
      }
      this.#failed.set(forge, this.clock())
      return held?.login ?? null
    })().finally(() => this.#asking.delete(forge))
    this.#asking.set(forge, asking)
    return asking
  }
}
