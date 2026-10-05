import {
  LIMITS,
  spellTrackerRef,
  trackerRowSchema,
  type TrackerDetailFacts,
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

/** What one read of one source came to. */
export type Read =
  | {
      ok: true
      rows: TrackerRow[]
      /** Numbers asked for that the tracker says do not exist, with the kind asked where it was known. */
      notFound: Array<{ number: number; kind: 'issue' | 'change' | null }>
      /** Numbers the tracker refused to answer (not "does not exist"); the rows above are the rest. */
      unread?: { why: string; refs: Array<{ number: number; kind: 'issue' | 'change' | null }> }
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
}

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

export const people = (v: unknown): string[] =>
  nodes(v).map(who).filter(Boolean).slice(0, LIMITS.TRACKER_PEOPLE)

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
 * Every trouble is a different sentence — the rule References learned the hard
 * way: "could not read the tracker" over all of them sends somebody to check
 * their network when they are not logged in.
 */
export function trouble(ran: Ran, cli: 'gh' | 'glab', host: string): string {
  const name = cli === 'gh' ? 'The GitHub CLI (gh)' : 'The GitLab CLI (glab)'
  if (ran.missing) return `${name} is not installed, so ${host} cannot be read from here.`
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
