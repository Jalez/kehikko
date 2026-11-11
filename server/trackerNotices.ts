import type { Database } from 'bun:sqlite'
import type { TrackerRow } from 'kehikot-module-protocol'

import { isDismissed, isSeen } from '../src/host/inbox.ts'
import {
  DEFAULT_NOTICES,
  EVENTS_MAX,
  TRACKER_NOTICES_BY,
  TRACKER_NOTICES_MODULE,
  factsOf,
  authorOf,
  happenings,
  hasRole,
  itemId,
  linkOf,
  noticeItem,
  noticesStored,
  stillTrue,
  type NoticeLink,
  type NoticeSettings,
  type Seen,
} from '../src/host/trackerNotices.ts'
import { newsLine, newsOf, newsTells, type EpicPlace, type NewsTell } from '../src/host/trackerNews.ts'
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
  /**
   * Every epic, and part of one, holding each ref spelling (`epicPlacesByRef`): where tracker news to
   * agents goes (`src/host/trackerNews.ts`). Absent: no news is found.
   */
  places?: ReadonlyMap<string, readonly EpicPlace[]>
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
   * reported, so the pages can be told, and the news for the agent sessions at
   * each epic (`news`), found in the same comparison: the caller sends it. Each
   * event is in exactly one landing's news — the facts it was read from are kept
   * here, in the same transaction.
   */
  landed(project: number, landing: Landing): { rev: number; news: NewsTell[] } {
    const now = this.clock()
    const settings = this.settings()
    const run = this.db.transaction(() => {
      const last = this.db.query<{ at: number }, [number]>('select at from tracker_seen_projects where project = ?').get(project)
      const lastAt = last ? last.at : null
      const held = this.#seen(project)
      const away = this.#putAway(project)

      /* One row per item: the spelling an epic names, where one does. Its places, from every spelling. */
      const items = new Map<string, TrackerRow>()
      const places = new Map<string, EpicPlace[]>()
      for (const row of landing.rows) {
        const id = itemId(row)
        const was = items.get(id)
        if (!was || (!landing.epics.has(was.ref) && landing.epics.has(row.ref))) items.set(id, row)
        const at = landing.places?.get(row.ref)
        if (at?.length) places.set(id, [...(places.get(id) ?? []), ...at])
      }
      const news: { line: string; places: readonly EpicPlace[] }[] = []

      for (const [id, row] of items) {
        const was = held.get(id)
        const me = landing.me.get(`${row.tracker}|${row.host}`) ?? null
        const facts = factsOf(row, was?.facts)
        const epic = landing.epics.get(row.ref)
        const relevant = settings.on && (hasRole(was, row) || (settings.scope === 'epics' && epic !== undefined))
        const fresh = relevant ? happenings(was, row, me, now, lastAt).filter((one) => settings.events[one.kind]) : []
        /* Tracker news to agents: only an item an epic holds, whatever the Inbox's setting. */
        const at = places.get(id)
        if (at?.length) {
          const told = newsOf(was, row, me, now, lastAt)
          if (told.length) news.push({ line: newsLine(row.ref, row.title, told, row.discussions?.unresolved), places: at })
        }
        /* Put away (seen, dismissed, closed): only what is new comes back. */
        let events = was && !away.has(id) ? was.events : []
        let since = was && !away.has(id) ? was.since : null
        if (fresh.length) {
          events = [...events, ...fresh].slice(-EVENTS_MAX)
          since = Math.max(now, (since ?? 0) + 1)
        }
        events = stillTrue(events, facts)
        const author = authorOf(row, me)
        const next: Seen = {
          id,
          ref: row.ref,
          title: row.title,
          link: linkOf(row),
          ...(author ? { author } : {}),
          ...(epic ? { epic } : {}),
          facts,
          events,
          since: events.length ? since : null,
          at: now,
        }
        held.set(id, next)
        this.#put(project, next)
      }

      /*
       * Items not in this reading keep their facts; one put away is let go. What
       * asked something of the person — a review, changes — is let go too when
       * the item is gone from a reading that did read its repository: a change
       * merged or closed, or the review no longer asked, drops out of what the
       * tracker lists for the person, and "needs you" must not outlive it. A
       * repository that was not read at all (a source down) says nothing.
       */
      const repos = new Set([...items.values()].map((row) => `${row.tracker}|${row.host}|${row.repo}`))
      for (const [id, seen] of held) {
        if (items.has(id) || !seen.events.length) continue
        if (away.has(id)) {
          const next = { ...seen, events: [], since: null }
          held.set(id, next)
          this.#put(project, next)
          continue
        }
        const link = seen.link
        if (!link || !repos.has(`${link.tracker}|${link.host}|${link.repo}`)) continue
        const kept = seen.events.filter((one) => one.kind !== 'review-requested' && one.kind !== 'changes-requested')
        if (kept.length === seen.events.length) continue
        const next = { ...seen, events: kept, since: kept.length ? seen.since : null }
        held.set(id, next)
        this.#put(project, next)
      }

      this.db
        .query('insert into tracker_seen_projects (project, at) values (?, ?) on conflict (project) do update set at = excluded.at')
        .run(project, now)
      this.#trim(project)
      return { ...this.#report(project, [...held.values()], settings), news: newsTells(news) }
    })
    return run()
  }

  /** Where one item is (`NoticeLink`), by its Inbox id: what pressing it picks or opens. Null when not held. */
  link(project: number, id: string): NoticeLink | null {
    const row = this.db.query<{ data: string }, [number, string]>('select data from tracker_seen where project = ? and id = ?').get(project, id)
    if (!row) return null
    try {
      return (JSON.parse(row.data) as Seen).link ?? null
    } catch {
      return null
    }
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
