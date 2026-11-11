import { LIMITS, type TrackerRow } from 'kehikot-module-protocol'

import { happenings, namesSaid, type Happening, type Seen } from './trackerNotices.ts'

/**
 * Tracker news to agents: what somebody other than the person did on an issue
 * or change that belongs to an epic, told to the agent sessions working at that
 * epic — on any of its kehikot — as the host's own message. Pure: the server
 * (`server/trackerNotices.ts`) finds the news in the same comparison of two
 * readings the Inbox's tracker notices come from, and sends it through the
 * same delivery as a module's news to a place (`AgentMessages.tell`): at most
 * one message from it a minute per session, the rest merged, an hourly cap,
 * and a wake.
 *
 * ## Told once
 *
 * An event is a difference between the facts last kept for an item and the row
 * just read, and the facts are kept as soon as they are compared. So an event
 * is told in the reading it was found in and never again — not after a restart,
 * not on the next reading. The first reading of a project tells nothing.
 *
 * ## Never the person's own, never outside the epic
 *
 * Nothing is told on a tracker where who the person is was not known, and
 * nothing whose doer is not known — except CI, which is nobody's act. Only an
 * item an epic names (in its refs, or a part's) is told, and only to that epic.
 *
 * ## From
 *
 * Stamped `TRACKER_NEWS_FROM`: the host's reading of the trackers, not a module.
 * A session reads it under the marker `⟦Trackers · report #N⟧`. The person's
 * switch for it is the "Messages to agents" mute under that id, per project
 * (`server/messageMutes.ts`), shown as "Tracker news to agents".
 */

/** Who the news is from, as the messages record stamps it. The host names no module and no vendor. */
export const TRACKER_NEWS_FROM = { module: 'kehikot.host', name: 'Trackers' } as const

/** The person's switch, in the trackers panel and on the news itself. */
export const TRACKER_NEWS_WORDS = {
  title: 'Tracker news to agents',
  lead: 'Tell the agent sessions at an epic when somebody else reviews, comments, pushes, merges or closes one of its issues or changes, or its CI fails or recovers. Your own actions are never told.',
  on: 'Agents working on an epic hear of new activity on its items, in this project.',
  off: 'Off: agents are told nothing from the trackers in this project.',
} as const

export const NEWS_KINDS = [
  'changes-requested',
  'approved',
  'review',
  'merged',
  'closed',
  'reopened',
  'commented',
  'pushed',
  'ci-failed',
  'ci-recovered',
] as const
export type NewsKind = (typeof NEWS_KINDS)[number]

export interface NewsEvent {
  kind: NewsKind
  by?: string
  name?: string
  path?: string
  line?: number
  commits?: number
}

/** Where an item belongs: an epic, and the parts of it that hold the item (none: the epic itself names it). */
export interface EpicPlace {
  epic: string
  parts: string[]
}

const ACTED: ReadonlySet<NewsKind> = new Set(['changes-requested', 'approved', 'review', 'merged', 'closed', 'reopened', 'commented', 'pushed'])

/**
 * What agents are told of one item between the facts last kept (`was`) and the
 * row just read. Nothing when the person (`me`) is not known on the row's
 * tracker, on the first reading (`lastAt` null) or for an item not seen before;
 * nothing the person did, and nothing whose doer is not known but CI.
 */
export function newsOf(was: Seen | undefined, row: TrackerRow, me: string | null, now: number, lastAt: number | null): NewsEvent[] {
  if (me === null || lastAt === null || !was) return []
  const out: NewsEvent[] = []
  for (const one of happenings(was, row, me, now, lastAt, { anyPush: true })) {
    const kind = asNews(one)
    if (!kind) continue
    if (ACTED.has(kind) && !one.by) continue
    if (one.by && one.by.toLowerCase() === me.toLowerCase()) continue
    out.push({
      kind,
      ...(one.by ? { by: one.by } : {}),
      ...(one.name ? { name: one.name } : {}),
      ...(one.path ? { path: one.path } : {}),
      ...(one.line ? { line: one.line } : {}),
      ...(one.commits ? { commits: one.commits } : {}),
    })
  }
  const before = was.facts.ci
  const after = row.kind === 'change' ? (row.pipeline === 'success' ? 'passed' : row.pipeline === 'failed' ? 'failed' : null) : null
  if (before !== undefined && after === 'failed' && before !== 'failed') out.push({ kind: 'ci-failed' })
  if (before === 'failed' && after === 'passed') out.push({ kind: 'ci-recovered' })
  return out
}

function asNews(one: Happening): NewsKind | null {
  switch (one.kind) {
    case 'review-requested':
      return null
    case 'commented':
      return one.review ? 'review' : 'commented'
    default:
      return one.kind
  }
}

const fileOf = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * One item's news as one line, most pressing first: "Mona requested changes on
 * !1801 · 2 unresolved threads", "Ali pushed 3 commits to !1801", "CI failed on
 * #42" — then the item's title. `threads` is how many review discussions are
 * unresolved, when the reading said.
 */
export function newsLine(ref: string, title: string, events: readonly NewsEvent[], threads?: number): string {
  const of = (kind: NewsKind) => events.filter((one) => one.kind === kind)
  const who = (list: readonly NewsEvent[]) => namesSaid(list.map((one) => ({ kind: 'commented' as const, at: 0, ...(one.by ? { by: one.by } : {}), ...(one.name ? { name: one.name } : {}) })))
  const out: string[] = []
  if (of('changes-requested').length) {
    out.push(`${who(of('changes-requested'))} requested changes on ${ref}${threads ? ` · ${plural(threads, 'unresolved thread', 'unresolved threads')}` : ''}`)
  }
  if (of('approved').length) out.push(`${who(of('approved'))} approved ${ref}`)
  if (of('review').length) out.push(`${who(of('review'))} reviewed ${ref}`)
  /* Of merged, closed and reopened, only where it ended up. */
  const state = events.filter((one) => one.kind === 'merged' || one.kind === 'closed' || one.kind === 'reopened').at(-1)
  if (state) out.push(`${who([state])} ${state.kind} ${ref}`)
  const comments = of('commented')
  if (comments.length === 1) {
    const one = comments[0]!
    const place = one.path ? (one.line ? ` on line ${one.line} of ${fileOf(one.path)} in` : ` on ${fileOf(one.path)} in`) : ' on'
    out.push(`${who(comments)} commented${place} ${ref}`)
  } else if (comments.length > 1) out.push(`${comments.length} new comments on ${ref} from ${who(comments)}`)
  const pushes = of('pushed')
  if (pushes.length) {
    const commits = pushes.reduce((n, one) => n + (one.commits ?? 0), 0)
    out.push(`${who(pushes)} pushed ${commits && pushes.every((one) => one.commits) ? plural(commits, 'commit', 'commits') : 'new commits'} to ${ref}`)
  }
  const ci = events.filter((one) => one.kind === 'ci-failed' || one.kind === 'ci-recovered').at(-1)
  if (ci) out.push(ci.kind === 'ci-failed' ? `CI failed on ${ref}` : `CI passes again on ${ref}`)
  if (!out.length) return ''
  const named = title.trim() ? ` — ${clip(title.replace(/\s+/g, ' ').trim(), 100)}` : ''
  return `${out.join('; ')}${named}`
}

/** One message to one place: an epic, or some of its parts. */
export interface NewsTell {
  place: { epic: string; parts?: string[] }
  body: string
}

/**
 * The messages one reading sends: per item, its line to every epic that names it
 * — to the epic itself when the epic names it, else to the parts that hold it —
 * one message per place, its lines in the order found.
 */
export function newsTells(items: readonly { line: string; places: readonly EpicPlace[] }[]): NewsTell[] {
  const byPlace = new Map<string, NewsTell & { lines: string[] }>()
  for (const item of items) {
    if (!item.line) continue
    const perEpic = new Map<string, Set<string> | null>()
    for (const one of item.places) {
      const was = perEpic.get(one.epic)
      if (was === null) continue
      if (!one.parts.length) perEpic.set(one.epic, null)
      else perEpic.set(one.epic, new Set([...(was ?? []), ...one.parts]))
    }
    for (const [epic, parts] of perEpic) {
      const place = parts === null ? { epic } : { epic, parts: [...parts].sort().slice(0, LIMITS.PARTS) }
      const key = JSON.stringify(place)
      const at = byPlace.get(key) ?? { place, body: '', lines: [] }
      at.lines.push(item.line)
      byPlace.set(key, at)
    }
  }
  return [...byPlace.values()].map(({ place, lines }) => ({ place, body: clip(lines.join('\n'), LIMITS.MESSAGE_BODY) }))
}
