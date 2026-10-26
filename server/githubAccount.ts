import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { LIMITS, trafficCommand, type TrafficAccount, type TrafficAllowance, type TrafficBudget } from 'kehikot-module-protocol'

import type { Ran, Runner } from './feedback.ts'
import type { Stats } from './github.ts'
import { because } from './traffic.ts'

/**
 * Kehikot's own budget for the calls it makes to GitHub AS THE PERSON, through their signed-in `gh`.
 *
 * Their account's limit (5,000 REST calls an hour, and 5,000 GraphQL points) is shared with
 * everything they run as that account: their own `gh` and `git`, CI, other apps, agent sessions.
 * Kehikot keeps to a part of it, and leaves the rest alone.
 *
 * ## The rules (`decide`)
 *
 * - **A share**: at most `SHARE` (20%) of each hourly limit — 1,000 of 5,000 — spent by Kehikot in
 *   the account's window. Background reads (tracker refreshes on their schedule, update checks,
 *   release lists) stop there until the window resets. A read the person pressed (Refresh, Check
 *   now; `pressed`) may go past it.
 * - **A floor**: when the account has less than `FLOOR` (10%) of a limit left — whoever spent it —
 *   nothing that is a read goes out, pressed or not, until the window resets. A write the person
 *   asked for (filing an issue) is not a read and is not held by the share or the floor.
 * - **When GitHub says stop**: a limit used up (403/429 with `x-ratelimit-remaining: 0`, GraphQL's
 *   `RATE_LIMITED`) holds that limit's calls until its reset; a secondary limit (`retry-after`, or
 *   the words) holds every call for what GitHub asked, else a minute, doubling while it repeats.
 *   Nothing goes out while GitHub said to wait, writes included.
 *
 * A held call is not run: the runner answers it at once with `held: true` and the sentence, and it
 * is filed in the record of traffic as `refused` with "held: <the sentence>".
 *
 * ## Knowing the account's state
 *
 * `gh api rate_limit` is free (GitHub does not count it). It is read at most once a minute
 * (`READ_EVERY_MS`), and only when it is wanted: while a Monitor reads traffic (`watch`), while the
 * account is near the floor or its numbers are stale, and once before the first call. Otherwise the
 * numbers come from the answers already being read: every `gh api` call is made with `--include`,
 * its `x-ratelimit-*` headers read, and the headers taken off before the caller sees the output.
 * A GraphQL query is asked for its own `rateLimit { cost }` so the share is charged what it cost.
 *
 * Only github.com is budgeted. GitLab's limit is only reported, from the `RateLimit-*` headers of
 * the `glab api` REST calls that are made anyway.
 */

/** Kehikot's share of each of the account's hourly limits. */
export const SHARE = 0.2
/** Below this part of a limit left, Kehikot reads nothing. */
export const FLOOR = 0.1
/** "Near the floor": less than this many floors left, when the account is read every minute. */
export const NEAR = 2
/** The account's limits are read (for free) at most this often. */
export const READ_EVERY_MS = 60_000
/** A Monitor counts as open for this long after its last `traffic.read`. */
export const WATCHED_MS = 90_000
/** GitHub's limit when it has not said one yet. */
export const ASSUMED_LIMIT = 5000
/** The first wait for a secondary limit that named no time, doubling while it repeats, to `SLOWED_MAX_MS`. */
export const SLOWED_MS = 60_000
export const SLOWED_MAX_MS = 15 * 60_000
/** The longest anything is held for, whatever reset GitHub names. */
export const HELD_MAX_MS = 60 * 60_000
const WINDOW_MS = 60 * 60_000

export type Resource = 'core' | 'graphql'
export type Urgency = 'background' | 'pressed' | 'write'

/** One of the account's limits as GitHub last said it. `reset` in ms since the epoch. */
export interface Limit {
  limit: number
  used: number
  remaining: number
  reset: number | null
}

/** What Kehikot spent of its share in one window: the window ends at `reset` (null until GitHub names it). */
export interface Spend {
  used: number
  reset: number | null
  /** When this window's counting began, so one whose reset was never learned still ends after an hour. */
  started: number
}

/** A wait GitHub asked for: one limit used up, or `all` for a secondary limit. */
export interface Backoff {
  resource: Resource | 'all'
  until: number
  why: string
}

export type Decision = { go: true } | { go: false; why: string; until: number | null; kind: 'limited' | 'slowed' | 'floor' | 'share' }

/* ------------------------------------------------------------------------ *
 * Who pressed: the urgency of the work running now.
 * ------------------------------------------------------------------------ */

const urgency = new AsyncLocalStorage<Urgency>()

/** Run `work` as a read the person pressed: it may go past Kehikot's share, never past the floor. */
export function pressed<T>(work: () => T): T {
  return urgency.run('pressed', work)
}

/** The urgency of the work running now: `background` unless it runs inside `pressed`. */
export const urgencyNow = (): Urgency => urgency.getStore() ?? 'background'

/**
 * Whether a request to this host is the person pressing something that reads GitHub: Refresh on
 * the trackers, Check now and Update, their feedback and proposals, adding one of their modules.
 * The page's own automatic check (`/host/updates?fetch=1&quiet=1`) is not.
 */
export function pressedRequest(method: string, url: URL): boolean {
  const path = url.pathname
  if (path === '/host/updates') return method === 'POST' || (url.searchParams.get('fetch') === '1' && url.searchParams.get('quiet') !== '1')
  if (path === '/host/tracker/refresh') return method === 'POST'
  if (path === '/host/feedback' || path === '/host/official/propose') return true
  if (path.startsWith('/host/mine/')) return method === 'POST'
  return false
}

/* ------------------------------------------------------------------------ *
 * The rules.
 * ------------------------------------------------------------------------ */

export const shareOf = (limit: number): number => Math.floor(limit * SHARE)
export const floorOf = (limit: number): number => Math.ceil(limit * FLOOR)

/** A time of day, as the person reads it: "11:00". */
export const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const LIMIT_SAID: Record<Resource, string> = { core: 'your GitHub limit', graphql: 'your GitHub GraphQL limit' }
const number = (n: number): string => n.toLocaleString('en-US')

/** The window `spend` counts in, moved on when it ended and given GitHub's reset once known. */
export function rolled(spend: Spend, limit: Limit | null, now: number): Spend {
  let out = spend
  const ended = out.reset !== null ? now >= out.reset : now - out.started >= WINDOW_MS
  if (ended) out = { used: 0, reset: null, started: now }
  if (out.reset === null && limit?.reset != null && limit.reset > now) out = { ...out, reset: limit.reset }
  return out
}

/** A limit GitHub said, while its window lasts; null once it reset (its numbers no longer hold). */
const current = (limit: Limit | null, now: number): Limit | null => (limit && (limit.reset === null || limit.reset > now) ? limit : null)

/**
 * Whether one call may go out now. Pure. `limit` is what GitHub last said of this resource, `spend`
 * Kehikot's own in its window, `backoff` a wait GitHub asked for.
 */
export function decide(input: {
  resource: Resource
  urgency: Urgency
  now: number
  limit: Limit | null
  spend: Spend
  backoff: Backoff | null
}): Decision {
  const { resource, now, backoff } = input
  if (backoff && now < backoff.until && (backoff.resource === 'all' || backoff.resource === resource)) {
    return { go: false, why: backoff.why, until: backoff.until, kind: backoff.resource === 'all' ? 'slowed' : 'limited' }
  }
  if (input.urgency === 'write') return { go: true }
  const limit = current(input.limit, now)
  if (limit) {
    const floor = floorOf(limit.limit)
    if (limit.remaining < floor) {
      const until = limit.reset
      return {
        go: false,
        why: `${cap(LIMIT_SAID[resource])} is down to ${number(limit.remaining)} of ${number(limit.limit)}; Kehikot leaves the last ${number(floor)} to you${until ? ` until ${clock(until)}` : ''}`,
        until,
        kind: 'floor',
      }
    }
  }
  if (input.urgency === 'pressed') return { go: true }
  const spend = rolled(input.spend, limit, now)
  const share = shareOf(limit?.limit ?? ASSUMED_LIMIT)
  if (spend.used >= share) {
    const until = spend.reset ?? spend.started + WINDOW_MS
    return { go: false, why: `Kehikot's share of ${LIMIT_SAID[resource]} is used until ${clock(until)}`, until, kind: 'share' }
  }
  return { go: true }
}

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/* ------------------------------------------------------------------------ *
 * Reading what GitHub says.
 * ------------------------------------------------------------------------ */

const int = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
}

/** One resource of `gh api rate_limit`'s answer. */
function limitOf(raw: unknown): Limit | null {
  if (!raw || typeof raw !== 'object') return null
  const one = raw as Record<string, unknown>
  const limit = int(one.limit)
  const remaining = int(one.remaining)
  if (limit === null || remaining === null) return null
  const reset = int(one.reset)
  return { limit, remaining, used: int(one.used) ?? Math.max(0, limit - remaining), reset: reset === null ? null : reset * 1000 }
}

/** `gh api rate_limit`'s answer: the REST (`core`) and GraphQL limits, each null when it is not there. */
export function parseRateLimit(text: string): { core: Limit | null; graphql: Limit | null } | null {
  let answer: unknown
  try {
    answer = JSON.parse(text)
  } catch {
    return null
  }
  const resources = (answer as { resources?: Record<string, unknown> } | null)?.resources
  if (!resources || typeof resources !== 'object') return null
  return { core: limitOf(resources.core), graphql: limitOf(resources.graphql) }
}

/** An answer printed with `--include`: the status, the headers (names in lower case) and the body. Null when it is not one. */
export function splitIncluded(out: string): { status: number; headers: Map<string, string>; body: string } | null {
  const first = /^HTTP\/[\d.]+ (\d{3})[^\n]*(?:\n|$)/.exec(out)
  if (!first) return null
  const headers = new Map<string, string>()
  let at = first[0].length
  while (at < out.length) {
    const end = out.indexOf('\n', at)
    const line = (end < 0 ? out.slice(at) : out.slice(at, end)).replace(/\r$/, '')
    at = end < 0 ? out.length : end + 1
    if (line === '') break
    const colon = line.indexOf(':')
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
  }
  return { status: Number(first[1]), headers, body: out.slice(at) }
}

/** The limit GitHub's `x-ratelimit-*` headers describe, and which one it is. */
export function githubHeaders(headers: Map<string, string>): { resource: string; limit: Limit } | null {
  const limit = int(headers.get('x-ratelimit-limit'))
  const remaining = int(headers.get('x-ratelimit-remaining'))
  if (limit === null || remaining === null) return null
  const reset = int(headers.get('x-ratelimit-reset'))
  return {
    resource: headers.get('x-ratelimit-resource') ?? 'core',
    limit: { limit, remaining, used: int(headers.get('x-ratelimit-used')) ?? Math.max(0, limit - remaining), reset: reset === null ? null : reset * 1000 },
  }
}

/** The limit GitLab's `RateLimit-*` headers describe. */
export function gitlabHeaders(headers: Map<string, string>): Limit | null {
  const limit = int(headers.get('ratelimit-limit'))
  const remaining = int(headers.get('ratelimit-remaining'))
  if (limit === null || remaining === null) return null
  const reset = int(headers.get('ratelimit-reset'))
  return { limit, remaining, used: int(headers.get('ratelimit-observed')) ?? Math.max(0, limit - remaining), reset: reset === null ? null : reset * 1000 }
}

/* ------------------------------------------------------------------------ *
 * Which calls count, and how they are asked.
 * ------------------------------------------------------------------------ */

/** What one program run is to the budget. */
export interface Call {
  forge: 'github' | 'gitlab'
  /** Which limit it spends; null for a free call (`gh api rate_limit`). */
  resource: Resource | null
  write: boolean
  /** A `gh api`/`glab api` run whose headers can be asked for. */
  include: boolean
  graphql: boolean
}

const WRITES = /^(create|edit|close|reopen|comment|merge|delete|review|lock|unlock|transfer|pin|unpin|develop|ready|archive|rename|fork|sync|upload|add|remove|set)$/

/** The value given to one of `flags` in `argv`, or null. */
function flagValue(argv: readonly string[], flags: readonly string[]): string | null {
  for (let i = 0; i < argv.length - 1; i++) if (flags.includes(argv[i]!)) return argv[i + 1]!
  return null
}

/** The GraphQL query a `gh api graphql` run sends, or null. */
function queryOf(argv: readonly string[]): { at: number; query: string } | null {
  for (let i = 0; i < argv.length - 1; i++) {
    if (!['-f', '-F', '--field', '--raw-field'].includes(argv[i]!)) continue
    const value = argv[i + 1]!
    if (value.startsWith('query=')) return { at: i + 1, query: value.slice('query='.length) }
  }
  return null
}

/**
 * What a run of `gh` or `glab` is to the budget, or null for any other program and for one that
 * does not reach the forge (`gh auth`, `gh config`). Only github.com is GitHub here; a GitHub
 * Enterprise host has limits of its own and is left alone.
 */
export function classify(argv: readonly string[]): Call | null {
  const said = trafficCommand(argv)
  if (!said) return null
  const program = said.kind.split(' ')[0]
  const paginate = argv.includes('--paginate')
  const included = argv.includes('-i') || argv.includes('--include')
  if (program === 'gh') {
    if (said.host !== 'api.github.com' && said.host !== 'github.com') return null
    if (said.kind === 'gh api') {
      if (said.path === '/rate_limit') return { forge: 'github', resource: null, write: false, include: false, graphql: false }
      const graphql = said.path === '/graphql'
      const method = (flagValue(argv, ['-X', '--method']) ?? 'GET').toUpperCase()
      const write = graphql ? /^\s*mutation\b/.test(queryOf(argv)?.query ?? '') : method !== 'GET' && method !== 'HEAD'
      return { forge: 'github', resource: graphql ? 'graphql' : 'core', write, include: !paginate && !included, graphql }
    }
    /* `gh issue list`, `gh pr view`: gh's own commands ask GraphQL. */
    const sub = said.kind.split(' ')[2] ?? ''
    return { forge: 'github', resource: 'graphql', write: WRITES.test(sub), include: false, graphql: false }
  }
  if (program === 'glab') {
    if (said.kind !== 'glab api') return { forge: 'gitlab', resource: 'core', write: false, include: false, graphql: false }
    const graphql = said.path === '/graphql'
    return { forge: 'gitlab', resource: 'core', write: false, include: !graphql && !paginate && !included, graphql }
  }
  return null
}

/** `argv` asking for the response's headers: `--include` right after `api`. */
export function withInclude(argv: readonly string[]): string[] {
  const at = argv.indexOf('api')
  return at < 0 ? [...argv] : [...argv.slice(0, at + 1), '--include', ...argv.slice(at + 1)]
}

const COST_FIELD = 'kehikotCost: rateLimit { cost }'

/**
 * `argv` with its GraphQL query asking what it cost (`rateLimit { cost }`, which costs nothing), or
 * null when the query is not one this can add to: a mutation, or a shape it does not recognise.
 */
export function withCost(argv: readonly string[]): string[] | null {
  const found = queryOf(argv)
  if (!found || /\brateLimit\b/.test(found.query)) return null
  const open = /^\s*(?:query\b[^{]*)?\{/.exec(found.query)
  if (!open) return null
  const query = `${found.query.slice(0, open[0].length)} ${COST_FIELD} ${found.query.slice(open[0].length)}`
  const out = [...argv]
  out[found.at] = `query=${query}`
  return out
}

/** Whether a GraphQL answer's own errors (not its data) say the limit is used up. */
export function graphqlLimited(body: string): boolean {
  if (!body.includes('RATE_LIMITED')) return false
  try {
    const errors = (JSON.parse(body) as { errors?: unknown }).errors
    return Array.isArray(errors) && errors.some((one) => (one as { type?: unknown } | null)?.type === 'RATE_LIMITED')
  } catch {
    return false
  }
}

/** The cost a query answered with, and the answer as it would have been without asking. */
export function takeCost(body: string): { cost: number | null; body: string } {
  if (!body.includes('kehikotCost')) return { cost: null, body }
  try {
    const answer = JSON.parse(body) as { data?: Record<string, unknown> | null }
    const data = answer?.data
    if (!data || typeof data !== 'object' || !('kehikotCost' in data)) return { cost: null, body }
    const cost = int((data.kehikotCost as { cost?: unknown } | null)?.cost)
    delete data.kehikotCost
    return { cost, body: JSON.stringify(answer) }
  } catch {
    return { cost: null, body }
  }
}

/* ------------------------------------------------------------------------ *
 * The account.
 * ------------------------------------------------------------------------ */

export interface AccountDeps {
  /** The runner every `gh` call would otherwise go through; tests stub it. */
  run: Runner
  now?(): number
  /** Where the share spent and any wait are kept between runs. */
  file?: string
  log?(line: string): void
  /** A call that was held, with the sentence, for the record of traffic. */
  held?(argv: readonly string[], why: string): void
}

interface Known {
  login: string | null
  core: Limit | null
  graphql: Limit | null
  /** When the numbers were last learned. */
  at: number | null
  /** Whether `gh` is signed in to github.com: null until a read says. */
  signedIn: boolean | null
}

interface Kept {
  spend: Record<Resource, Spend>
  backoff: Backoff | null
  /** How many secondary limits in a row, for the doubling wait. */
  slowed: number
}

const isSpend = (value: unknown): value is Spend =>
  !!value && typeof value === 'object' && typeof (value as Spend).used === 'number' && typeof (value as Spend).started === 'number'

export function githubAccount(deps: AccountDeps) {
  const now = deps.now ?? Date.now
  const known: Known = { login: null, core: null, graphql: null, at: null, signedIn: null }
  const gitlab: { login: string | null; core: Limit | null; at: number | null } = { login: null, core: null, at: null }
  const fresh = (): Spend => ({ used: 0, reset: null, started: now() })
  const kept: Kept = { spend: { core: fresh(), graphql: fresh() }, backoff: null, slowed: 0 }
  let readAt = 0
  let reading: Promise<void> | null = null
  let watchedAt = 0

  if (deps.file) {
    try {
      const file = JSON.parse(readFileSync(deps.file, 'utf8')) as Partial<Kept>
      if (isSpend(file.spend?.core)) kept.spend.core = file.spend.core
      if (isSpend(file.spend?.graphql)) kept.spend.graphql = file.spend.graphql
      const backoff = file.backoff
      if (backoff && typeof backoff.until === 'number' && typeof backoff.why === 'string' && ['core', 'graphql', 'all'].includes(backoff.resource)) {
        kept.backoff = { resource: backoff.resource, until: Math.min(backoff.until, now() + HELD_MAX_MS), why: backoff.why.slice(0, LIMITS.REASON) }
      }
      if (typeof file.slowed === 'number') kept.slowed = Math.max(0, Math.min(10, Math.floor(file.slowed)))
    } catch {
      /* No file yet, or not one to use. */
    }
  }

  function persist(): void {
    if (!deps.file) return
    try {
      mkdirSync(dirname(deps.file), { recursive: true })
      const tmp = `${deps.file}.writing-${process.pid}`
      writeFileSync(tmp, JSON.stringify(kept))
      renameSync(tmp, deps.file)
    } catch (error) {
      deps.log?.(`github account: could not keep what it spent: ${(error as Error).message}`)
    }
  }

  const spendOf = (resource: Resource): Spend => {
    const was = kept.spend[resource]
    const next = rolled(was, known[resource], now())
    if (next !== was) kept.spend[resource] = next
    return next
  }

  function charge(resource: Resource, cost: number): void {
    if (cost === 0) return
    const spend = spendOf(resource)
    kept.spend[resource] = { ...spend, used: Math.max(0, spend.used + cost) }
    /* Until GitHub says again, the account has that much less left. */
    const limit = known[resource]
    if (limit) known[resource] = { ...limit, used: Math.max(0, limit.used + cost), remaining: Math.max(0, limit.remaining - cost) }
    persist()
  }

  function learned(resource: string, limit: Limit): void {
    if (resource !== 'core' && resource !== 'graphql') return
    known[resource] = limit
    known.at = now()
    known.signedIn = true
    spendOf(resource)
  }

  function wait(backoff: Backoff): void {
    const at = now()
    kept.backoff = { ...backoff, until: Math.min(backoff.until, at + HELD_MAX_MS) }
    persist()
  }

  /** The account's limits and login, read for free. Shared by whoever asks while it runs. */
  function read(): Promise<void> {
    if (reading) return reading
    readAt = now()
    reading = because('your GitHub limits (free to read)', async () => {
      const ran = await deps.run(['gh', 'api', 'rate_limit'], { timeout: 10_000 }).catch((): Ran => ({ code: null, out: '', err: '', missing: true }))
      if (ran.code === 0) {
        const limits = parseRateLimit(ran.out)
        if (limits) {
          if (limits.core) learned('core', limits.core)
          if (limits.graphql) learned('graphql', limits.graphql)
        }
        if (!known.login) {
          const user = await deps.run(['gh', 'config', 'get', 'user', '-h', 'github.com'], { timeout: 5_000 }).catch(() => null)
          const login = user?.code === 0 ? user.out.trim() : ''
          if (/^[A-Za-z0-9-]{1,39}$/.test(login)) known.login = login
        }
        return
      }
      if (ran.missing || ran.code === 4 || /auth login|not logged in|no oauth token|authentication/i.test(`${ran.err}\n${ran.out}`)) {
        known.signedIn = false
        known.core = null
        known.graphql = null
        known.login = null
      }
    }).finally(() => {
      reading = null
    })
    return reading
  }

  const due = (): boolean => now() - readAt >= READ_EVERY_MS

  /** Whether this limit is close enough to the floor, or stale enough, to be read every minute. */
  function near(resource: Resource): boolean {
    const limit = known[resource]
    if (!limit) return known.signedIn !== false
    if (limit.reset !== null && limit.reset <= now()) return true
    return limit.remaining < NEAR * floorOf(limit.limit)
  }

  /** Read the account's limits if a minute has passed since the last read. */
  async function refreshIfDue(): Promise<void> {
    if (due()) await read()
    else if (reading) await reading
  }

  /** What GitHub said about a limit, in a run's output or error. */
  function heard(call: Call, ran: Ran, said: ReturnType<typeof splitIncluded>): void {
    const at = now()
    const fromErr = /HTTP (\d{3})/.exec(ran.err)?.[1]
    const status = said?.status ?? (fromErr ? Number(fromErr) : null)
    const failed = ran.code !== 0 || (status !== null && status >= 400)
    /* What an answer that came back fine says is the person's data (an issue may be titled anything): only a failure's words are read. */
    const text = failed ? `${ran.err}\n${said ? said.body : ran.out}` : ''
    const body = said ? said.body : ran.out
    const headers = said?.headers ?? new Map<string, string>()
    const retry = int(headers.get('retry-after'))
    const remaining = headers.get('x-ratelimit-remaining')
    const resource: Resource = headers.get('x-ratelimit-resource') === 'graphql' ? 'graphql' : headers.get('x-ratelimit-resource') === 'core' ? 'core' : (call.resource ?? 'core')
    const secondary = /secondary rate limit|abuse detection/i.test(text)
    const refused = status === 403 || status === 429
    if (refused && retry !== null) return slowDown(at + retry * 1000)
    if ((refused && remaining === '0') || (!secondary && /API rate limit (?:already )?exceeded/i.test(text)) || (call.graphql && graphqlLimited(body))) {
      const reset = known[resource]?.reset
      const until = reset && reset > at ? reset : at + SLOWED_MS
      wait({ resource, until, why: `${cap(LIMIT_SAID[resource])} is used up until ${clock(until)}; Kehikot waits` })
      void read().catch(() => {})
      return
    }
    if (secondary || status === 429) return slowDown(null)
    if (ran.code === 0 && kept.slowed) {
      kept.slowed = 0
      persist()
    }
  }

  function slowDown(until: number | null): void {
    const at = now()
    kept.slowed = Math.min(10, kept.slowed + 1)
    const end = until ?? at + Math.min(SLOWED_MAX_MS, SLOWED_MS * 2 ** (kept.slowed - 1))
    wait({ resource: 'all', until: end, why: `GitHub asked Kehikot to slow down; it waits until ${clock(end)}` })
  }

  /** A run of `glab api` with its headers: GitLab's limit, noted; the output as it would have been. */
  async function viaGitlab(call: Call, argv: string[], options: Parameters<Runner>[1]): Promise<Ran> {
    if (!call.include) return deps.run(argv, options)
    const host = flagValue(argv, ['--hostname']) ?? 'gitlab.com'
    if (host !== 'gitlab.com') return deps.run(argv, options)
    const ran = await deps.run(withInclude(argv), options)
    const said = splitIncluded(ran.out)
    if (!said) return ran
    const limit = gitlabHeaders(said.headers)
    if (limit) {
      gitlab.core = limit
      gitlab.at = now()
    }
    if (said.status === 200 && argv.includes('user')) {
      try {
        const name = (JSON.parse(said.body) as { username?: unknown }).username
        if (typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name)) gitlab.login = name
      } catch {
        /* Not the user. */
      }
    }
    return { ...ran, out: said.body.trim() }
  }

  /**
   * The runner to give every caller of `gh`: anything that is not a counted call to github.com goes
   * straight through; a counted one is decided on, charged, asked with its headers and read.
   */
  const run: Runner = async (argv, options) => {
    const call = classify(argv)
    if (!call) return deps.run(argv, options)
    if (call.forge === 'gitlab') return viaGitlab(call, argv, options)
    if (!call.resource) return deps.run(argv, options)
    const resource = call.resource
    if (known.signedIn === null || near(resource) || (kept.backoff && now() >= kept.backoff.until)) await refreshIfDue().catch(() => {})
    if (kept.backoff && now() >= kept.backoff.until) {
      kept.backoff = null
      persist()
    }
    /* Not signed in: this is not the person's account, and gh will say so itself. */
    if (known.signedIn === false) return deps.run(argv, options)

    const decided = decide({ resource, urgency: call.write ? 'write' : urgencyNow(), now: now(), limit: known[resource], spend: spendOf(resource), backoff: kept.backoff })
    if (!decided.go) {
      deps.held?.(argv, decided.why)
      return { code: 1, out: '', err: decided.why, held: true }
    }

    charge(resource, 1)
    const costed = call.graphql && !call.write ? withCost(argv) : null
    const asked = call.include ? withInclude(costed ?? argv) : (costed ?? argv)
    const ran = await deps.run(asked, options)
    if (ran.missing) {
      charge(resource, -1)
      return ran
    }
    const said = call.include ? splitIncluded(ran.out) : null
    if (said) {
      const limit = githubHeaders(said.headers)
      if (limit) learned(limit.resource, limit.limit)
    }
    heard(call, ran, said)
    let body = said ? said.body.trim() : ran.out
    if (costed) {
      const taken = takeCost(body)
      body = taken.body
      if (taken.cost !== null && taken.cost !== 1) charge(resource, taken.cost - 1)
    }
    if (!known.login && said?.status === 200 && argv.includes('user') && !call.graphql) {
      try {
        const login = (JSON.parse(body) as { login?: unknown }).login
        if (typeof login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(login)) known.login = login
      } catch {
        /* Not the user. */
      }
    }
    return body === ran.out ? ran : { ...ran, out: body }
  }

  /** A Monitor is reading traffic: keep the account's numbers no older than a minute while it does. */
  function watch(): void {
    watchedAt = now()
    void refreshIfDue().catch(() => {})
  }

  const watched = (): boolean => now() - watchedAt < WATCHED_MS

  function allowance(resource: Resource): TrafficAllowance | null {
    const limit = current(known[resource], now())
    if (!limit) return null
    return {
      limit: limit.limit,
      used: limit.used,
      remaining: limit.remaining,
      resets: limit.reset,
      share: { limit: shareOf(limit.limit), used: spendOf(resource).used },
      floor: floorOf(limit.limit),
    }
  }

  /** The account as `traffic.read` says it (protocol 2.24.0), or null when gh is not signed in or nothing is known yet. */
  function account(): TrafficAccount | null {
    if (known.signedIn === false) return null
    if (known.at === null && !kept.backoff) return null
    const at = now()
    let paused: Extract<Decision, { go: false }> | null = null
    for (const resource of ['core', 'graphql'] as const) {
      const said = decide({ resource, urgency: 'background', now: at, limit: known[resource], spend: spendOf(resource), backoff: kept.backoff })
      if (!said.go) {
        paused = said
        break
      }
    }
    return {
      login: known.login,
      core: allowance('core'),
      graphql: allowance('graphql'),
      paused: paused !== null,
      why: paused?.why ?? '',
      until: paused?.until ?? null,
      at: known.at,
    }
  }

  /** GitLab's limit as the headers of its answers said it, or null when none was seen this hour. */
  function gitlabAccount(): TrafficAccount | null {
    const limit = current(gitlab.core, now())
    if (!limit || gitlab.at === null || now() - gitlab.at > WINDOW_MS) return null
    return {
      login: gitlab.login,
      core: { limit: limit.limit, used: limit.used, remaining: limit.remaining, resets: limit.reset, share: null, floor: null },
      graphql: null,
      paused: false,
      why: '',
      until: null,
      at: gitlab.at,
    }
  }

  return { run, watch, watched, read, refreshIfDue, account, gitlabAccount }
}

export type GitHubAccount = ReturnType<typeof githubAccount>

/* ------------------------------------------------------------------------ *
 * The budgets as `traffic.read` lists them.
 * ------------------------------------------------------------------------ */

/** The gateway's budget for reading GitHub without an account (`github.ts`), as one row. */
export function anonymousBudget(said: Stats & { spent: number; budget: number; frees: number | null }): TrafficBudget {
  return {
    name: 'GitHub without an account',
    used: said.spent,
    limit: said.budget,
    left: Math.max(0, said.budget - said.spent),
    resets: said.frees,
    note: "Kehikot's own hourly budget for reading GitHub when gh isn't signed in.",
  }
}

/**
 * `budgets`, the list a reader before protocol 2.24.0 shows: Kehikot's share of each of the
 * account's limits, with what the account has left in the note, and the budget without an account
 * only when it was used this hour or there is no account to show.
 */
export function budgetRows(account: TrafficAccount | null, anonymous: TrafficBudget): TrafficBudget[] {
  const rows: TrafficBudget[] = []
  const who = account?.login ? `GitHub as ${account.login}` : 'your GitHub account'
  for (const [key, label] of [['core', ''], ['graphql', ' (GraphQL points)']] as const) {
    const limit = account?.[key]
    if (!limit?.share) continue
    rows.push({
      name: `Kehikot's share of ${who}${label}`,
      used: limit.share.used,
      limit: limit.share.limit,
      left: Math.max(0, limit.share.limit - limit.share.used),
      resets: limit.resets,
      note: `The account has ${number(limit.remaining)} of ${number(limit.limit)} left this hour, shared with your own gh, CI and other apps.${account?.paused ? ` Paused: ${account.why}.` : ''}`.slice(0, LIMITS.REASON),
    })
  }
  if (anonymous.used > 0 || !rows.length) rows.push(anonymous)
  return rows
}
