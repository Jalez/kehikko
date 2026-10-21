import type { Database } from 'bun:sqlite'
import type { TrackerRow } from 'kehikot-module-protocol'

import { isDismissed, isSeen } from '../src/host/inbox.ts'
import {
  DEFAULT_NOTICES,
  EVENTS_MAX,
  TRACKER_NOTICES_BY,
  TRACKER_NOTICES_MODULE,
  factsOf,
  happenings,
  hasRole,
  itemId,
  noticeItem,
  noticesStored,
  stillTrue,
  type NoticeSettings,
  type Seen,
} from '../src/host/trackerNotices.ts'
import type { Inbox } from './inbox.ts'

/**
 * Tracker notices, kept (`src/host/trackerNotices.ts` has the rules and the
 * words). Told by the tracker reading each time a read of a project lands —
 * whether or not any module that shows refs is open — it compares the rows
 * with the facts it last saw, and reports the host's own list of items to the
 * Inbox under `TRACKER_NOTICES_MODULE`.
 *
 * ## Where it lives
 *
 * In `frame.sqlite`, per project id, never in the project: what this person
 * last saw of a tracker is about this machine. `tracker_seen` holds one row
 * per tracker item (its last facts and the events not yet put away);
 * `tracker_seen_projects` when the project was last read, whose absence is
 * what makes the first reading silent. The setting is one row of `settings`.
 *
 * Not a second set of Inbox items: the items are the Inbox's own entries, with
 * their life and their moves; what is kept here is what an event is read from.
 * Whether the person put an item away is read from the Inbox's record.
 */

const KEY = 'tracker-notices'
/** Items kept per project; past it the oldest with nothing to tell go first. */
const SEEN_MAX = 3000

export function ensureTrackerNotices(db: Database): void {
  db.exec(`
    create table if not exists settings (
      key   text primary key,
      value text not null
    );
    create table if not exists tracker_seen (
      project integer not null references projects(id) on delete cascade,
      id      text    not null,
      data    text    not null,
      at      integer not null,
      told    integer not null default 0,
      primary key (project, id)
    );
    create table if not exists tracker_seen_projects (
      project integer primary key references projects(id) on delete cascade,
      at      integer not null
    );
  `)
}

export function readNotices(db: Database): NoticeSettings {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    return row ? noticesStored(JSON.parse(row.value)) : DEFAULT_NOTICES
  } catch {
    return DEFAULT_NOTICES
  }
}

export function writeNotices(db: Database, settings: NoticeSettings): void {
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(
    KEY,
    JSON.stringify(settings),
  )
}

export interface Landing {
  /** The rows of the reading, as just stored. */
  rows: readonly TrackerRow[]
  /** Who the person is per `tracker|host`, where known. */
  me: ReadonlyMap<string, string>
  /** The epic naming each ref spelling (`epicsByRef` in `trackers/reading.ts`). */
  epics: ReadonlyMap<string, string>
}

export class TrackerNotices {
  constructor(
    private readonly db: Database,
    private readonly inbox: Pick<Inbox, 'report' | 'all'>,
    private readonly clock: () => number = () => Date.now(),
  ) {
    ensureTrackerNotices(db)
  }

  settings(): NoticeSettings {
    return readNotices(this.db)
  }

  #seen(project: number): Map<string, Seen> {
    const out = new Map<string, Seen>()
    for (const row of this.db.query<{ id: string; data: string }, [number]>('select id, data from tracker_seen where project = ?').all(project)) {
      try {
        out.set(row.id, JSON.parse(row.data) as Seen)
      } catch {
        /* A row that will not read is a row seen for the first time again: silent. */
      }
    }
    return out
  }

  #put(project: number, seen: Seen): void {
    this.db
      .query(
        `insert into tracker_seen (project, id, data, at, told) values (?, ?, ?, ?, ?)
         on conflict (project, id) do update set data = excluded.data, at = excluded.at, told = excluded.told`,
      )
      .run(project, seen.id, JSON.stringify(seen), seen.at, seen.events.length ? 1 : 0)
  }

  /** Every item's Inbox entry state, by id: whether the person put it away. */
  #putAway(project: number): Set<string> {
    const out = new Set<string>()
    for (const entry of this.inbox.all(project)) {
      if (entry.module !== TRACKER_NOTICES_MODULE) continue
      if (entry.closed !== null || isDismissed(entry) || isSeen(entry)) out.add(entry.id)
    }
    return out
  }

  /**
   * A reading of the project landed. Returns the Inbox's rev when the list was
   * reported, so the pages can be told.
   */
  landed(project: number, landing: Landing): { rev: number } {
    const now = this.clock()
    const settings = this.settings()
    const run = this.db.transaction(() => {
      const last = this.db.query<{ at: number }, [number]>('select at from tracker_seen_projects where project = ?').get(project)
      const lastAt = last ? last.at : null
      const held = this.#seen(project)
      const away = this.#putAway(project)

      /* One row per item: the spelling an epic names, where one does. */
      const items = new Map<string, TrackerRow>()
      for (const row of landing.rows) {
        const id = itemId(row)
        const was = items.get(id)
        if (!was || (!landing.epics.has(was.ref) && landing.epics.has(row.ref))) items.set(id, row)
      }

      for (const [id, row] of items) {
        const was = held.get(id)
        const me = landing.me.get(`${row.tracker}|${row.host}`) ?? null
        const facts = factsOf(row)
        const epic = landing.epics.get(row.ref)
        const relevant = settings.on && (hasRole(was, row) || (settings.scope === 'epics' && epic !== undefined))
        const fresh = relevant ? happenings(was, row, me, now, lastAt).filter((one) => settings.events[one.kind]) : []
        /* Put away (seen, dismissed, closed): only what is new comes back. */
        let events = was && !away.has(id) ? was.events : []
        let since = was && !away.has(id) ? was.since : null
        if (fresh.length) {
          events = [...events, ...fresh].slice(-EVENTS_MAX)
          since = Math.max(now, (since ?? 0) + 1)
        }
        events = stillTrue(events, facts)
        const next: Seen = {
          id,
          ref: row.ref,
          title: row.title,
          ...(epic ? { epic } : {}),
          facts,
          events,
          since: events.length ? since : null,
          at: now,
        }
        held.set(id, next)
        this.#put(project, next)
      }

      /* Items not in this reading keep their facts; one put away is let go. */
      for (const [id, seen] of held) {
        if (items.has(id) || !seen.events.length || !away.has(id)) continue
        const next = { ...seen, events: [], since: null }
        held.set(id, next)
        this.#put(project, next)
      }

      this.db
        .query('insert into tracker_seen_projects (project, at) values (?, ?) on conflict (project) do update set at = excluded.at')
        .run(project, now)
      this.#trim(project)
      return this.#report(project, [...held.values()], settings)
    })
    return run()
  }

  /** The setting changed: every project's list again, from what is held. */
  restate(projects: readonly number[]): { project: number; rev: number }[] {
    const settings = this.settings()
    return projects.map((project) => ({ project, rev: this.#report(project, [...this.#seen(project).values()], settings).rev }))
  }

  #report(project: number, held: readonly Seen[], settings: NoticeSettings): { rev: number } {
    const items = held.flatMap((one) => {
      const item = noticeItem(one, settings)
      return item ? [item] : []
    })
    return { rev: this.inbox.report(project, TRACKER_NOTICES_MODULE, TRACKER_NOTICES_BY, items).rev }
  }

  #trim(project: number): void {
    const n = this.db.query<{ n: number }, [number]>('select count(*) as n from tracker_seen where project = ?').get(project)!.n
    if (n <= SEEN_MAX) return
    this.db
      .query(
        `delete from tracker_seen where rowid in (
           select rowid from tracker_seen where project = ? and told = 0 order by at asc limit ?)`,
      )
      .run(project, n - SEEN_MAX)
  }
}
