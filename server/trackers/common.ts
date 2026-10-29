import {
  LIMITS,
  avatarUrlSchema,
  spellTrackerRef,
  trackerRowSchema,
  type TrackerBoard,
  type TrackerDetailFacts,
  type TrackerPerson,
  type TrackerRow,
} from 'kehikot-module-protocol'

import { TIMEOUT_MS, type Ran } from '../feedback.ts'
import type { Source } from './sources.ts'

/**
 * What every tracker adapter shares: the row it builds, the bounds it clips to,
 * and the sentences it fails with.
 *
 * ## One interface, many trackers
 *
 * An adapter is three reads — a listing of a source's recent work, the refs
 * somebody named, and the detail of a few — and every one of them answers in
 * `TrackerRow`s, the protocol's shape. Jira, or anything else, is a fourth file
 * beside `github.ts` and `gitlab.ts` and an entry in the protocol's `TRACKERS`.
 *
 * Credentials are the person's own logged-in CLIs, as `feedback.ts` does it
 * with `gh`: the host holds no token, and every call is an argument array with
 * no shell anywhere.
 */

/**
 * A board as the host keeps it: the protocol's board, and for a GitLab board
 * what it takes to place an issue on it — the label of each list in board
 * order, the labels the board is scoped to, and whether it shows its Open and
 * Closed lists. Never sent as it is: `tracker.columns` takes the protocol's
 * three fields.
 */
export interface HeldBoard extends TrackerBoard {
  lists?: string[]
  scope?: string[]
  open?: boolean
  closed?: boolean
}

/**
 * What a read learned of a source's boards: the boards it saw, or why it
 * could not see any (a sentence a person can act on, said once in the
 * tracker sources panel). A read that did not look says nothing.
 */
export type BoardsRead = { boards: HeldBoard[] } | { unreadable: string }

/** What one read of one source came to. */
export type Read =
  | {
      ok: true
      rows: TrackerRow[]
      /** The boards the read saw its items on, when it looked. */
      boards?: BoardsRead
      /** Numbers asked for that the tracker says do not exist, with the kind asked where it was known. */
      notFound: Array<{ number: number; kind: 'issue' | 'change' | null }>
      /** Numbers the tracker refused to answer (not "does not exist"); the rows above are the rest. */
      unread?: { why: string; refs: Array<{ number: number; kind: 'issue' | 'change' | null }> }
      /**
       * Set when the tracker would not say who reviews a change (an older
       * GitLab without the fields): the rows came without `reviewers`, and
       * this is the sentence a person is told, once.
       */
      people?: { unreadable: string }
    }
  | { ok: false; why: string }

export interface Wanted {
  number: number
  /** Known for GitLab (`#12` vs `!12`); null for GitHub, whose numbers are shared. */
  kind: 'issue' | 'change' | null
}

export interface Adapter {
  /** The source's recent issues and changes, up to `limit` of each. */
  list(source: Source, limit: number, now: string): Promise<Read>
  /** These numbers, read one by one or in batches. */
  refs(source: Source, wanted: readonly Wanted[], now: string): Promise<Read>
  /** The detail of these rows, by number. */
  detail(source: Source, rows: readonly TrackerRow[], now: string): Promise<Map<string, TrackerDetailFacts> | { why: string }>
  /**
   * The source's boards, read on their own — for a tracker whose items do not
   * say where they stand (GitLab: the list is worked out from the labels).
   * Null when they could not be read; the boards held before stay.
   */
  boards?(source: Source): Promise<BoardsRead | null>
  /**
   * The source's branch names, read on their own on a whole read — for a
   * tracker whose issues do not say which branches are theirs (GitLab: a
   * related branch is one named `<iid>-…`). Null when they could not be read;
   * the names held before stay. (protocol 2.19.0)
   */
  branches?(source: Source): Promise<string[] | null>
  /**
   * Who the person is on this tracker host — `gh api user`, `glab api user` —
   * or why that could not be read, in a sentence. For `myRoles`. (2.7.0)
   */
  me?(host: string): Promise<Me>
}

/** Who the person is on one tracker host, or why it is not known. */
export type Me = { login: string } | { why: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
export const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {})
export const str = (v: unknown): string => (typeof v === 'string' ? v : '')
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
/** A GraphQL connection's nodes, or a plain array. */
export const nodes = (v: unknown): unknown[] => (Array.isArray(v) ? v : list(obj(v).nodes))

/** Text clipped to a bound. For text only: a ref is never clipped. */
export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** An instant the protocol will take, or null. */
export function instant(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** A person's name as rows show one: the name, else the handle. */
export function who(v: unknown): string {
  const p = obj(v)
  return clip(str(p.name) || str(p.login) || str(p.username), LIMITS.TRACKER_PERSON)
}

/** A person's login (GitHub `login`, GitLab `username`), clipped, or ''. */
export function login(v: unknown): string {
  const p = obj(v)
  return clip(str(p.login) || str(p.username), LIMITS.TRACKER_PERSON)
}

/** The logins of a list of people, the ones without a login left out. */
export const logins = (v: unknown): string[] =>
  nodes(v).map(login).filter(Boolean).slice(0, LIMITS.TRACKER_PEOPLE)

export const people = (v: unknown): string[] =>
  nodes(v).map(who).filter(Boolean).slice(0, LIMITS.TRACKER_PEOPLE)

/*
 * Faces (protocol 2.10.0).
 *
 * A row's `people` is one map, by login, of the display name and the picture of
 * every person the row names by login: its author, assignees, reviewers and
 * whoever acted last. The adapters ask for each person's picture in the
 * queries they already make (GitHub `avatarUrl(size: 48)`, GitLab `avatarUrl`
 * or REST `avatar_url`) and hand every person object they read to `withPeople`,
 * which keeps only the logins the row names.
 *
 * A picture is sent only as an absolute `https:` URL. GitLab gives a relative
 * path (`/uploads/-/system/user/avatar/…`) for a picture it stores itself; that
 * is made absolute against the source's host. Anything else — `http:`, a
 * `data:` URL, something too long — is left out, never the row.
 */

/** A person's picture as an absolute `https:` URL, or undefined. A relative path is the tracker host's. */
export function avatarOf(v: unknown, host: string): string | undefined {
  const p = obj(v)
  const raw = (str(p.avatarUrl) || str(p.avatar_url)).trim()
  if (!raw) return undefined
  let url: string
  try {
    url = new URL(raw, `https://${host}/`).href
  } catch {
    return undefined
  }
  return avatarUrlSchema.safeParse(url).success ? url : undefined
}

/** The display name a person object carries, under `name` or the `fullName` alias GitHub's queries use. */
const nameOf = (p: Record<string, unknown>): string => clip((str(p.fullName) || str(p.name)).trim(), LIMITS.TRACKER_PERSON)

/**
 * `people` for a row, out of every person object read for it, keyed by the
 * logins the row names and nothing else. Undefined when nothing is known of any
 * of them. Two objects for one login fill each other in; the first wins.
 */
export function peopleOf(
  named: Pick<TrackerRow, 'authorLogin' | 'assigneeLogins' | 'reviewers' | 'lastActivity'>,
  read: readonly unknown[],
  host: string,
): Record<string, TrackerPerson> | undefined {
  const logins = [
    ...(named.authorLogin ? [named.authorLogin] : []),
    ...(named.assigneeLogins ?? []),
    ...(named.reviewers ?? []).map((r) => r.login),
    ...(named.lastActivity ? [named.lastActivity.login] : []),
  ]
  const wanted = new Map(logins.map((l) => [l.toLowerCase(), l]))
  const out: Record<string, TrackerPerson> = {}
  for (const raw of read) {
    const p = obj(raw)
    const key = wanted.get(login(p).toLowerCase())
    if (!key) continue
    const was = out[key] ?? {}
    const name = was.name ?? (nameOf(p) || undefined)
    const avatarUrl = was.avatarUrl ?? avatarOf(p, host)
    if (name === undefined && avatarUrl === undefined) continue
    out[key] = { ...(name !== undefined ? { name } : {}), ...(avatarUrl !== undefined ? { avatarUrl } : {}) }
  }
  const entries = Object.entries(out).slice(0, LIMITS.ROW_PEOPLE)
  return entries.length ? Object.fromEntries(entries) : undefined
}

/** A row's fields with `people` worked out from them and the person objects read for it. */
export function withPeople(fields: Record<string, unknown>, read: readonly unknown[], host: string): Record<string, unknown> {
  return { ...fields, people: peopleOf(fields as Parameters<typeof peopleOf>[0], read, host) }
}

export const labelsOf = (v: unknown): string[] =>
  nodes(v)
    .map((l) => clip(typeof l === 'string' ? l : str(obj(l).name) || str(obj(l).title), LIMITS.TRACKER_LABEL))
    .filter(Boolean)
    .slice(0, LIMITS.TRACKER_LABELS)

/** The spelling of a ref this source found, or null when it would not fit `LIMITS.REF`. */
export function spell(source: Source, kind: 'issue' | 'change', number: number): string | null {
  const ref = spellTrackerRef({ tracker: source.tracker, repo: source.repo, kind, number, isDefault: source.default })
  return ref.length <= LIMITS.REF ? ref : null
}

/**
 * A row, checked against the protocol before it is kept.
 *
 * The adapters build rows out of a CLI's JSON, which is somebody's program's
 * output and not a promise. A row that does not fit is dropped rather than
 * stored, so that `tracker.get` never answers with something its own schema
 * would refuse.
 */
export function row(fields: Record<string, unknown>): TrackerRow | null {
  const parsed = trackerRowSchema.safeParse(
    Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
  )
  return parsed.success ? parsed.data : null
}

/**
 * Why a CLI failed, as a sentence somebody can act on.
 *
 * Every trouble is a different sentence — the rule a module learned the hard
 * way: "could not read the tracker" over all of them sends somebody to check
 * their network when they are not logged in.
 */
export function trouble(ran: Ran, cli: 'gh' | 'glab', host: string): string {
  const name = cli === 'gh' ? 'The GitHub CLI (gh)' : 'The GitLab CLI (glab)'
  if (ran.missing) return `${name} is not installed, so ${host} cannot be read from here.`
  /* Held back by Kehikot's budget for the person's account: the sentence says why, as it is. */
  if (ran.held) return clip(`${ran.err}.`, LIMITS.REASON)
  if (ran.timedOut) return `${host} did not answer within ${TIMEOUT_MS / 1000}s.`
  const said = `${ran.err}\n${ran.out}`
  const low = said.toLowerCase()
  if (
    (cli === 'gh' && ran.code === 4) ||
    /auth login|not logged in|authentication|401 unauthorized|no token found|unauthenticated/.test(low)
  ) {
    return `${name} is not logged in to ${host}: run \`${cli} auth login${cli === 'glab' && host !== 'gitlab.com' ? ` --hostname ${host}` : ''}\`.`
  }
  if (/rate limit|secondary rate|abuse detection|429/.test(low)) {
    return `${host} is rate-limiting this login. Nothing is wrong with the project; the limit resets on its own.`
  }
  if (/no such host|dial tcp|network is unreachable|connection refused|i\/o timeout|tls handshake|could not resolve host/.test(low)) {
    return `${host} could not be reached from this machine — the network, a VPN, or the host is down.`
  }
  if (/404|not found|could not resolve to a repository/.test(low)) {
    return `${host} has no repository it will show this login under that name.`
  }
  const last = (ran.err || ran.out || `${cli} failed and did not say why`).split('\n').filter(Boolean).slice(-2).join(' ')
  return clip(last, LIMITS.REASON)
}

/** JSON out of a run, or null. GraphQL answers with data AND a non-zero exit when part of it was not found. */
export function parsed(ran: Ran): unknown {
  if (!ran.out) return null
  try {
    return JSON.parse(ran.out)
  } catch {
    return null
  }
}

/** Groups of at most `size`, so one refusal costs one batch rather than all of them. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/* ------------------------------------------------------------------------ *
 * Closing, and contributing (protocol 2.26.0, Jalez/kehikko#187)
 * ------------------------------------------------------------------------ */

/** The issue numbers after a keyword: `#12`, `#12, #13`, `#12 and #13`. */
const NUMBERS = String.raw`[\s:]*((?:#\d+[\s,]*(?:and\s*)?)+)`

/**
 * The words in a change's description that say it DELIVERS an issue: GitLab's
 * own closing keywords, which GitHub reads the same way.
 */
const CLOSING = new RegExp(String.raw`\b(?:clos(?:e|es|ed|ing)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing))\b${NUMBERS}`, 'gi')

/**
 * The words that say it delivers PART of one: "Part of #12", "Implements #12",
 * "Contributes to #12". The upper merge requests of a stack use them, since
 * GitLab's `closed_by` ignores a merge request that targets a feature branch.
 * Never closing: the issue is done when it closes, not when one part merges.
 */
const CONTRIBUTING = new RegExp(String.raw`\b(?:part of|implements|contributes to)\b${NUMBERS}`, 'gi')

function numbersAfter(description: string | null | undefined, words: RegExp): number[] {
  const out = new Set<number>()
  for (const m of (description ?? '').matchAll(words)) {
    for (const ref of m[1]!.matchAll(/#(\d+)/g)) out.add(Number(ref[1]))
  }
  return [...out]
}

/** The issues a description says the change closes. */
export const closingIssues = (description: string | null | undefined): number[] => numbersAfter(description, CLOSING)

/** The issues a description says the change is part of, leaving out any it also says it closes. */
export function contributedIssues(description: string | null | undefined): number[] {
  const closes = new Set(closingIssues(description))
  return numbersAfter(description, CONTRIBUTING).filter((n) => !closes.has(n))
}

/**
 * A change's `contributes`: the issues spelled for this source, without any the
 * change already `closes`, bounded. Undefined when there are none, so a row
 * that contributes nothing has no field rather than an empty one.
 */
export function contributesOf(source: Source, numbers: readonly number[], closes: readonly string[]): string[] | undefined {
  const closing = new Set(closes)
  const refs = numbers
    .map((n) => spell(source, 'issue', n))
    .filter((one): one is string => one !== null && !closing.has(one))
  const out = [...new Set(refs)].slice(0, LIMITS.TRACKER_LINKS)
  return out.length ? out : undefined
}

/**
 * Give each issue the changes among `rows` that say they are part of it, as
 * `contributedBy`. Worked out afresh every time: no tracker hands an issue its
 * contributors, so the field is only ever this mirror. An entry naming a change
 * `rows` does not hold is kept (nothing here can say it is wrong); one naming a
 * held change that no longer contributes is taken off. A change that closes
 * the issue (a `closed-by` link) is not also a contributor. Never touches
 * `links` or `closedByMerge`. `key` says which source a ref is spelled in.
 */
export function withContributors(rows: TrackerRow[], key: (row: TrackerRow, ref: string) => string = (_, ref) => ref): TrackerRow[] {
  const held = new Set<string>()
  const by = new Map<string, string[]>()
  for (const one of rows) {
    if (one.kind !== 'change') continue
    held.add(key(one, one.ref))
    for (const ref of one.contributes ?? []) {
      const at = key(one, ref)
      by.set(at, [...(by.get(at) ?? []), one.ref])
    }
  }
  return rows.map((one) => {
    if (one.kind !== 'issue') return one
    const was = one.contributedBy ?? []
    const closing = new Set(one.links.filter((l) => l.relation === 'closed-by').map((l) => l.ref))
    const next = [...new Set([...was.filter((ref) => !held.has(key(one, ref))), ...(by.get(key(one, one.ref)) ?? [])])]
      .filter((ref) => !closing.has(ref))
      .slice(0, LIMITS.TRACKER_LINKS)
    if (next.length === was.length && next.every((ref, i) => ref === was[i])) return one
    const { contributedBy: _, ...rest } = one
    return next.length ? { ...rest, contributedBy: next } : rest
  })
}
