import {
  LIMITS,
  type ActivityItem,
  type LastActivityKind,
  type MyRole,
  type ReviewerState,
  type TrackerRow,
} from 'kehikot-module-protocol'

/**
 * Tracker notices: what happened on the issues and changes a person cares
 * about — approved, changes requested, their review asked for, somebody else
 * commented, merged, closed, reopened, new commits on a change they review —
 * told in the Inbox as the host's own items. Pure, shared by the page (the
 * Settings section's words) and the server (`server/trackerNotices.ts`, which
 * keeps the last-seen facts and reports the list).
 *
 * ## One item per ref, not one per event
 *
 * Per tracker item there is at most ONE Inbox item, under
 * `TRACKER_NOTICES_MODULE`. Events accrue on it ("!123 approved by mona · 2 new
 * comments from bob") until the person puts it away — sees it, or dismisses
 * it — after which only a NEW event brings it back. A burst of events in one
 * reading is one update.
 *
 * ## Found between two readings, never on the first
 *
 * An event is a difference between the facts last seen for an item and the
 * row just read (`happenings`). The first reading of a project only records
 * the facts. What the person did themselves is never an event: their login on
 * the row's tracker, or `lastActivity.mine`.
 *
 * ## The Inbox's own states
 *
 *  - review requested from you, changes requested → `attention` (needs you),
 *    while it is still true;
 *  - approved, merged → `done` (good news), normal priority;
 *  - comments, reviews, closed, reopened, new commits → `done` at low priority:
 *    something to know, nothing to do.
 */

/** The module id the host files these items under; the by-line is `TRACKER_NOTICES_BY`. */
export const TRACKER_NOTICES_MODULE = 'kehikko.trackers'
export const TRACKER_NOTICES_BY = 'Kehikot'

export const NOTICE_EVENTS = [
  'review-requested',
  'changes-requested',
  'approved',
  'commented',
  'merged',
  'closed',
  'reopened',
  'pushed',
] as const
export type NoticeEvent = (typeof NOTICE_EVENTS)[number]

/* ---- the setting ---- */

/** `roles`: only where the person has a role. `epics`: that, and every ref an epic of the project names. */
export type NoticeScope = 'roles' | 'epics'

export interface NoticeSettings {
  on: boolean
  scope: NoticeScope
  events: Record<NoticeEvent, boolean>
}

export const DEFAULT_NOTICES: NoticeSettings = {
  on: true,
  scope: 'roles',
  events: Object.fromEntries(NOTICE_EVENTS.map((one) => [one, true])) as Record<NoticeEvent, boolean>,
}

/** The Settings section's words. */
export const NOTICE_WORDS = {
  title: 'Tracker notices',
  lead: 'A line in the Inbox when something happens on an issue, merge request or pull request: one line per item, updated as more happens. Your own actions are never told.',
  on: 'Tell me in the Inbox',
  scopes: {
    roles: 'Only where I have a role (author, assignee or reviewer)',
    epics: 'Also everything my epics name',
  } satisfies Record<NoticeScope, string>,
  events: {
    'review-requested': 'My review is asked for',
    'changes-requested': 'Changes are requested',
    approved: 'Approved',
    commented: 'Somebody else comments or reviews',
    merged: 'Merged',
    closed: 'Closed',
    reopened: 'Reopened',
    pushed: 'New commits on a change I review',
  } satisfies Record<NoticeEvent, string>,
  needs: 'A review asked of you, and changes asked of yours, need you until they are done. The rest are told as finished.',
} as const

/**
 * A change to the setting, read strictly: an unknown key or a value of the
 * wrong kind refuses the whole change. Absent keys keep what `was` has.
 */
export function noticesPatched(was: NoticeSettings, raw: unknown): NoticeSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  for (const key of Object.keys(body)) if (!['on', 'scope', 'events'].includes(key)) return null
  if (body.on !== undefined && typeof body.on !== 'boolean') return null
  if (body.scope !== undefined && body.scope !== 'roles' && body.scope !== 'epics') return null
  let events = was.events
  if (body.events !== undefined) {
    const given = body.events as Record<string, unknown> | null
    if (!given || typeof given !== 'object' || Array.isArray(given)) return null
    events = { ...events }
    for (const [key, value] of Object.entries(given)) {
      if (!(NOTICE_EVENTS as readonly string[]).includes(key) || typeof value !== 'boolean') return null
      events[key as NoticeEvent] = value
    }
  }
  return { on: (body.on as boolean | undefined) ?? was.on, scope: (body.scope as NoticeScope | undefined) ?? was.scope, events }
}

/** What is stored, read leniently: anything unreadable is the default. */
export function noticesStored(raw: unknown): NoticeSettings {
  return noticesPatched(DEFAULT_NOTICES, raw) ?? DEFAULT_NOTICES
}

/* ---- facts, and what changed between two of them ---- */

/** What is kept of a row between readings: only what an event is read from. */
export interface Facts {
  kind: 'issue' | 'change'
  state: TrackerRow['state']
  /** Reviewer states by login, lower case. Absent when the tracker did not say who reviews. */
  reviewers?: Record<string, ReviewerState>
  review?: TrackerRow['review']
  activity?: { login: string; at: string; kind: LastActivityKind; mine?: boolean }
  pushAt?: string
  /** Absent when who the person is was not known. */
  roles?: MyRole[]
  updatedAt?: string
}

/** One thing that happened, as kept on the item until it is put away. */
export interface Happening {
  kind: NoticeEvent
  /** Who did it, by login; absent when the tracker did not say. */
  by?: string
  /** Their display name, when the row carried one. */
  name?: string
  /** When the host noticed it. */
  at: number
}

/** The record of one tracker item between readings. */
export interface Seen {
  id: string
  ref: string
  title: string
  /** The epic naming the ref, when one does. */
  epic?: string
  facts: Facts
  /** What happened since the person last put the item away. */
  events: Happening[]
  /** When the latest event was noticed: the Inbox item's `since`. */
  since: number | null
  /** When these facts were taken. */
  at: number
}

export const EVENTS_MAX = 40

const lower = (login: string) => login.toLowerCase()
const same = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

export function factsOf(row: TrackerRow): Facts {
  return {
    kind: row.kind,
    state: row.state,
    ...(row.reviewers ? { reviewers: Object.fromEntries(row.reviewers.map((r) => [lower(r.login), r.state])) } : {}),
    ...(row.review ? { review: row.review } : {}),
    ...(row.lastActivity
      ? {
          activity: {
            login: row.lastActivity.login,
            at: row.lastActivity.at,
            kind: row.lastActivity.kind,
            ...(row.lastActivity.mine !== undefined ? { mine: row.lastActivity.mine } : {}),
          },
        }
      : {}),
    ...(row.lastPushAt ? { pushAt: row.lastPushAt } : {}),
    ...(row.myRoles ? { roles: [...row.myRoles] } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
  }
}

/** One item however its ref is spelled: GitHub numbers are shared by issues and pull requests. */
export function itemId(row: Pick<TrackerRow, 'tracker' | 'host' | 'repo' | 'kind' | 'number'>): string {
  const whole = `${row.tracker}:${row.host}/${row.repo}${row.tracker === 'github' ? '#' : row.kind === 'change' ? '!' : '#'}${row.number}`
  if (whole.length <= LIMITS.ACTIVITY_ID) return whole
  /* A deep GitLab path: kept unique by a hash of the whole, readable by its end. */
  let h = 0x811c9dc5
  for (let i = 0; i < whole.length; i += 1) h = Math.imul(h ^ whole.charCodeAt(i), 0x01000193) >>> 0
  const tail = whole.slice(-(LIMITS.ACTIVITY_ID - 10))
  return `${h.toString(36).padStart(8, '0')}:${tail}`.slice(0, LIMITS.ACTIVITY_ID)
}

const time = (at: string | null | undefined): number => {
  const t = at ? Date.parse(at) : NaN
  return Number.isFinite(t) ? t : 0
}

/** The display name the row carries for a login (protocol 2.10.0 `people`), when it does. */
function nameOf(row: TrackerRow, login: string): string | undefined {
  const people = row.people
  if (!people) return undefined
  const one = people[login] ?? Object.entries(people).find(([key]) => same(key, login))?.[1]
  return one?.name?.trim() || undefined
}

/** Whether the person has any role on the item, before or now. */
export function hasRole(was: Seen | undefined, row: TrackerRow): boolean {
  return Boolean(row.myRoles?.length || was?.facts.roles?.length)
}

const REVIEWING: readonly MyRole[] = ['reviewer-asked', 'reviewer-done']

/**
 * What happened to one item between the facts last seen (`was`) and the row
 * just read, leaving out what the person (`me`, their login on the row's
 * tracker; null when not known) did themselves.
 *
 * `lastAt` is when the project was last read, or null for its first reading,
 * which tells nothing. An item not seen before tells only that the person's
 * review was asked for, and only when the item moved since the last reading.
 */
export function happenings(was: Seen | undefined, row: TrackerRow, me: string | null, now: number, lastAt: number | null): Happening[] {
  if (lastAt === null) return []
  const mine = (login: string | undefined) => login !== undefined && me !== null && same(login, me)
  const by = (login: string | undefined): Pick<Happening, 'by' | 'name'> =>
    login === undefined ? {} : { by: login, ...(nameOf(row, login) ? { name: nameOf(row, login)! } : {}) }
  const out: Happening[] = []

  if (!was) {
    const moved = Math.max(time(row.updatedAt), time(row.lastActivity?.at))
    if (row.state === 'open' && row.myRoles?.includes('reviewer-asked') && moved > lastAt) {
      out.push({ kind: 'review-requested', at: now })
    }
    return out
  }

  const facts = was.facts
  const activity = row.lastActivity
  const actor = activity && !activity.mine && !mine(activity.login) ? activity.login : undefined
  const reviewed = new Set<string>()

  /* Reviews, reviewer by reviewer where the tracker says; else the change's own review state. */
  if (row.reviewers && facts.reviewers) {
    for (const r of row.reviewers) {
      if (mine(r.login)) continue
      const before = facts.reviewers[lower(r.login)]
      if (before === r.state) continue
      const kind: NoticeEvent | null =
        r.state === 'approved' ? 'approved' : r.state === 'changes' ? 'changes-requested' : r.state === 'commented' ? 'commented' : null
      if (!kind) continue
      out.push({ kind, ...by(r.login), at: now })
      reviewed.add(lower(r.login))
    }
  } else if (row.review !== facts.review && (row.review === 'approved' || row.review === 'changes-requested')) {
    const self = activity?.kind === 'review' && (activity.mine === true || mine(activity.login))
    if (!self) {
      const who = activity?.kind === 'review' ? actor : undefined
      out.push({ kind: row.review === 'approved' ? 'approved' : 'changes-requested', ...by(who), at: now })
      if (who) reviewed.add(lower(who))
    }
  }

  /* The person's review asked for: by the reviewers when both readings had them, else by the roles. */
  const meAt = me !== null && row.reviewers ? row.reviewers.find((r) => same(r.login, me))?.state : undefined
  const meWas = me !== null && facts.reviewers ? facts.reviewers[lower(me)] : undefined
  const askedNow = row.reviewers && facts.reviewers && me !== null ? meAt === 'requested' : Boolean(row.myRoles?.includes('reviewer-asked'))
  const askedWas = row.reviewers && facts.reviewers && me !== null ? meWas === 'requested' : Boolean(facts.roles?.includes('reviewer-asked'))
  if (row.state === 'open' && askedNow && !askedWas) out.push({ kind: 'review-requested', at: now })

  /* Merged, closed, reopened — not when the person did it. */
  if (row.state !== facts.state) {
    const self = activity?.kind === 'state' && (activity.mine === true || mine(activity.login))
    if (!self) {
      const kind: NoticeEvent = row.state === 'merged' ? 'merged' : row.state === 'closed' ? 'closed' : 'reopened'
      out.push({ kind, ...by(activity?.kind === 'state' ? actor : undefined), at: now })
    }
  }

  /* Somebody else commented or reviewed: the latest activity moved, and is not the person's. */
  if (activity && (activity.kind === 'comment' || activity.kind === 'review')) {
    const after = facts.activity ? time(facts.activity.at) : was.at
    const known = activity.mine === false || (activity.mine === undefined && me !== null && !mine(activity.login))
    if (time(activity.at) > after && known && !(activity.kind === 'review' && reviewed.has(lower(activity.login)))) {
      out.push({ kind: 'commented', ...by(activity.login), at: now })
    }
  }

  /* New commits on a change the person reviews, pushed by somebody else. */
  if (row.kind === 'change' && row.lastPushAt && facts.pushAt && time(row.lastPushAt) > time(facts.pushAt)) {
    const reviewing = [...(row.myRoles ?? []), ...(facts.roles ?? [])].some((one) => REVIEWING.includes(one))
    const self = (activity?.kind === 'commit' && (activity.mine === true || mine(activity.login))) || mine(row.authorLogin ?? undefined)
    if (reviewing && !self) out.push({ kind: 'pushed', ...by(activity?.kind === 'commit' ? activity.login : undefined), at: now })
  }

  return out
}

/**
 * Events that asked something of the person, kept only while that is still
 * true: their review while it is still asked and the item open; changes asked
 * while that reviewer still asks them (or the change's review still says so).
 */
export function stillTrue(events: readonly Happening[], facts: Facts): Happening[] {
  return events.filter((one) => {
    if (one.kind === 'review-requested') return facts.state === 'open' && Boolean(facts.roles?.includes('reviewer-asked'))
    if (one.kind === 'changes-requested') {
      if (facts.state !== 'open') return false
      if (facts.reviewers && one.by) return facts.reviewers[lower(one.by)] === 'changes'
      return facts.review === 'changes-requested' || Object.values(facts.reviewers ?? {}).includes('changes')
    }
    return true
  })
}

/* ---- the item ---- */

/** "mona", "mona and bob", "mona, bob and carol", "mona, bob and 2 others". */
export function namesSaid(events: readonly Happening[]): string {
  const names: string[] = []
  const had = new Set<string>()
  for (const one of events) {
    if (!one.by || had.has(lower(one.by))) continue
    had.add(lower(one.by))
    names.push(one.name ?? one.by)
  }
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`
}

const withBy = (words: string, events: readonly Happening[]) => {
  const who = namesSaid(events)
  return who ? `${words} by ${who}` : words
}

/** The phrases of an item's events, most pressing first. */
export function phrases(events: readonly Happening[]): string[] {
  const of = (kind: NoticeEvent) => events.filter((one) => one.kind === kind)
  const out: string[] = []
  if (of('changes-requested').length) out.push(withBy('changes requested', of('changes-requested')))
  if (of('review-requested').length) out.push('review requested from you')
  if (of('approved').length) out.push(withBy('approved', of('approved')))
  /* Of merged, closed and reopened, only where it ended up. */
  const states = events.filter((one) => one.kind === 'merged' || one.kind === 'closed' || one.kind === 'reopened')
  const last = states[states.length - 1]
  if (last) out.push(withBy(last.kind, [last]))
  const comments = of('commented')
  if (comments.length) {
    const who = namesSaid(comments)
    const said = comments.length === 1 ? 'a new comment' : `${comments.length} new comments`
    out.push(who ? `${said} from ${who}` : said)
  }
  if (of('pushed').length) out.push('new commits')
  return out
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * The Inbox item for one tracker item, or null when nothing is left to tell.
 * Events the setting does not want are left out; what asked something of the
 * person and is no longer true is left out.
 */
export function noticeItem(seen: Seen, settings: NoticeSettings): ActivityItem | null {
  if (!settings.on) return null
  const events = stillTrue(seen.events, seen.facts).filter((one) => settings.events[one.kind])
  if (!events.length || seen.since === null) return null
  const needs = events.some((one) => one.kind === 'review-requested' || one.kind === 'changes-requested')
  const good = events.some((one) => one.kind === 'approved' || one.kind === 'merged')
  const label = clip(`${seen.ref} ${phrases(events).join(' · ')}`, LIMITS.ACTIVITY_LABEL)
  return {
    id: seen.id,
    state: needs ? 'attention' : 'done',
    label,
    ...(seen.title ? { detail: clip(seen.title, LIMITS.ACTIVITY_DETAIL) } : {}),
    priority: needs || good ? 'normal' : 'low',
    refs: [seen.ref],
    ...(seen.epic ? { place: { epic: seen.epic } } : {}),
    since: seen.since,
  }
}
