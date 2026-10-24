import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The one door this host reads GitHub's API through.
 *
 * Release lists, a release's notes, a module's notes, the works-with files:
 * every one asks here, so there is one place that knows how much of GitHub's
 * allowance is spent. GitHub lets a stranger ask sixty times an hour per
 * address, and a host that is restarted while it is being worked on, or asked
 * about many modules, used up all of it and then showed an empty list.
 *
 * ## What it does
 *
 * - The person's own `gh` first, whenever it is installed and logged in: it
 *   has 5000 an hour and reads private repositories. When it turns out not to
 *   be usable it is left alone for `GH_BACKOFF_MS`, not spawned for every call.
 * - Otherwise anonymously, with a BUDGET of `BUDGET` calls in any hour
 *   (`spent`, kept on disk so a restart does not forget it), well under
 *   sixty. A conditional request (`If-None-Match` with the ETag of the last
 *   answer) that GitHub answers with 304 does not count against GitHub's limit
 *   and is given back to the budget.
 * - When the budget is short, the less important wait. The app's own releases
 *   come first (`PRIORITY.app`), then installed modules' notes, then the
 *   works-with mapping, then anything else; each keeps `RESERVE` calls back for
 *   those above it. A call that has to wait is not dropped and not failed: it
 *   answers `waiting` with the time it can be asked again, and the page says
 *   "will read in a moment".
 * - Every successful answer is kept (memory, and a file in the machine
 *   directory), so when GitHub cannot be reached the last good one is still
 *   there to be shown, marked as old.
 * - `raw.githubusercontent.com` is not part of the API's allowance; `raw` goes
 *   through here only so that it is counted and has one set of manners.
 */

export const BUDGET = 30
export const WINDOW_MS = 60 * 60_000
export const GH_BACKOFF_MS = 5 * 60_000
export const TIMEOUT_MS = 10_000
export const FAILED_MS = 60_000
/** The longest a rate limit holds anything, whatever reset GitHub names. */
export const LIMITED_MAX_MS = 60 * 60_000
/** The most answers kept, and the most one may weigh (the app's list is ~430 KB). */
export const KEEP_MAX = 32
export const KEEP_BYTES = 1_000_000

/** Lower is more important. */
export const PRIORITY = { app: 0, notes: 1, worksWith: 2, other: 3 } as const
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY]
/** How many of the budget's calls are kept back for what matters more. */
export const RESERVE: Record<Priority, number> = { 0: 0, 1: 5, 2: 10, 3: 15 }

export type Fetched =
  | { ok: true; value: unknown; via: 'gh' | 'anonymous' | 'unchanged' }
  | {
      ok: false
      why: string
      /** 404 missing, 502 could not read, 503 limited or waiting. */
      status: number
      /** Short of budget: it will be read when there is room; asking again then works. */
      waiting?: boolean
      /** When asking again is worth it. */
      retryAt: number
    }

/** What the person's `gh` said: the JSON, or why not. `usable: false` is "gh itself is not there or not logged in". */
export type GhRan = { ok: true; value: unknown } | { ok: false; status: number | null; usable: boolean }

export interface GatewayDeps {
  fetch?: typeof fetch
  /** `gh api <path>`; absent where there is no gh. */
  gh?(path: string): Promise<GhRan>
  now?(): number
  /** Where the answers and the spent calls are kept between runs. */
  file?: string
  budget?: number
  log?(line: string): void
  /** A call that did not go out — held back by the budget or a limit — for the record of traffic. */
  held?(url: string): void
}

interface Kept {
  etag: string | null
  value: unknown
  at: number
}

export interface Stats {
  /** Calls that reached api.github.com without an account (counted against GitHub's limit unless `unchanged`). */
  anonymous: number
  /** Of those, answered 304. */
  unchanged: number
  gh: number
  raw: number
  /** Asked and told to wait for budget. */
  waited: number
}

export function githubGateway(deps: GatewayDeps = {}) {
  const now = deps.now ?? Date.now
  const get = deps.fetch ?? fetch
  const budget = deps.budget ?? BUDGET
  const kept = new Map<string, Kept>()
  let spent: number[] = []
  let limitedUntil = 0
  let limitedWhy = ''
  let ghBackoffUntil = 0
  const stats: Stats = { anonymous: 0, unchanged: 0, gh: 0, raw: 0, waited: 0 }

  if (deps.file) {
    try {
      const file = JSON.parse(readFileSync(deps.file, 'utf8')) as { spent?: unknown; answers?: unknown }
      if (Array.isArray(file.spent)) spent = file.spent.filter((one): one is number => typeof one === 'number')
      if (file.answers && typeof file.answers === 'object') {
        for (const [path, one] of Object.entries(file.answers as Record<string, Partial<Kept>>)) {
          if (one && typeof one.at === 'number' && 'value' in one) kept.set(path, { etag: typeof one.etag === 'string' ? one.etag : null, value: one.value, at: one.at })
        }
      }
    } catch {
      /* No file yet, or not one to use. */
    }
  }

  function persist(): void {
    if (!deps.file) return
    try {
      mkdirSync(dirname(deps.file), { recursive: true })
      const tmp = `${deps.file}.writing-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ spent, answers: Object.fromEntries(kept) }))
      renameSync(tmp, deps.file)
    } catch (error) {
      deps.log?.(`github: could not keep its answers: ${(error as Error).message}`)
    }
  }

  function remember(path: string, value: unknown, etag: string | null): void {
    let size = 0
    try {
      size = JSON.stringify(value).length
    } catch {
      return
    }
    if (size > KEEP_BYTES) return
    kept.delete(path)
    kept.set(path, { etag, value, at: now() })
    while (kept.size > KEEP_MAX) kept.delete(kept.keys().next().value as string)
    persist()
  }

  const prune = () => {
    const from = now() - WINDOW_MS
    if (spent.length && spent[0]! <= from) spent = spent.filter((at) => at > from)
  }

  /** When one more call of this priority may be made, or null if it may be now. */
  function waitFor(priority: Priority): number | null {
    prune()
    const room = budget - RESERVE[priority]
    if (spent.length < room) return null
    /* The call that frees the slot is the (spent - room + 1)th oldest. */
    return spent[spent.length - room]! + WINDOW_MS
  }

  async function viaGh(path: string): Promise<Fetched | null> {
    if (!deps.gh || now() < ghBackoffUntil) return null
    stats.gh++
    const ran = await deps.gh(path).catch((): GhRan => ({ ok: false, status: null, usable: false }))
    if (ran.ok) return { ok: true, value: ran.value, via: 'gh' }
    if (!ran.usable) {
      ghBackoffUntil = now() + GH_BACKOFF_MS
      return null
    }
    /* gh works and GitHub said no: a real answer for the person's account — except a plain 404, which may be anonymous-only knowledge. */
    return null
  }

  /**
   * Ask for `path` (`/repos/…`). `accept` says whether a value is the shape
   * wanted; one that is not is a failure from gh (and then anonymous is tried)
   * and a failure from GitHub.
   */
  async function api(path: string, priority: Priority, accept: (value: unknown) => boolean = () => true): Promise<Fetched> {
    const clean = path.startsWith('/') ? path : `/${path}`
    const through = await viaGh(clean.slice(1))
    if (through?.ok && accept(through.value)) {
      remember(clean, through.value, null)
      return through
    }

    const at = now()
    if (at < limitedUntil) {
      deps.held?.(`https://api.github.com${clean}`)
      return { ok: false, why: limitedWhy, status: 503, retryAt: limitedUntil }
    }
    const until = waitFor(priority)
    if (until !== null) {
      stats.waited++
      deps.held?.(`https://api.github.com${clean}`)
      const retryAt = Math.min(until, at + FAILED_MS)
      return { ok: false, waiting: true, why: 'GitHub is being asked less often to stay within its limit; this will be read in a moment.', status: 503, retryAt }
    }

    const before = kept.get(clean)
    spent.push(at)
    stats.anonymous++
    let response: Response
    try {
      response = await get(`https://api.github.com${clean}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'kehikot-host',
          ...(before?.etag ? { 'if-none-match': before.etag } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      refund(at)
      const timedOut = (error as Error)?.name === 'TimeoutError'
      return {
        ok: false,
        why: timedOut ? `GitHub did not answer within ${TIMEOUT_MS / 1000}s.` : 'GitHub could not be reached — this computer may be offline.',
        status: 502,
        retryAt: at + FAILED_MS,
      }
    }
    if (response.status === 304 && before) {
      refund(at)
      stats.unchanged++
      kept.set(clean, { ...before, at: now() })
      return { ok: true, value: before.value, via: 'unchanged' }
    }
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      const retryAt = Number.isFinite(reset) && reset > at ? Math.min(reset, at + LIMITED_MAX_MS) : at + FAILED_MS
      const when = new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      limitedUntil = retryAt
      limitedWhy = `GitHub's limit for reading without an account is used up until ${when}.`
      return { ok: false, why: limitedWhy, status: 503, retryAt }
    }
    if (response.status === 404) return { ok: false, why: 'GitHub answered 404 (not found).', status: 404, retryAt: at + FAILED_MS }
    if (!response.ok) return { ok: false, why: `GitHub answered ${response.status}.`, status: 502, retryAt: at + FAILED_MS }
    let value: unknown
    try {
      value = await response.json()
    } catch {
      return { ok: false, why: 'GitHub answered with something that is not JSON.', status: 502, retryAt: at + FAILED_MS }
    }
    if (!accept(value)) return { ok: false, why: 'GitHub answered with something other than expected.', status: 502, retryAt: at + FAILED_MS }
    remember(clean, value, response.headers.get('etag'))
    return { ok: true, value, via: 'anonymous' }
  }

  /** A call that GitHub did not count: given back. */
  function refund(at: number): void {
    const i = spent.lastIndexOf(at)
    if (i >= 0) spent.splice(i, 1)
  }

  /** `raw.githubusercontent.com` (outside the API's allowance); counted, and fetched with the same manners. */
  async function raw(url: string, init: RequestInit = {}): Promise<Response> {
    stats.raw++
    return get(url, { ...init, headers: { 'user-agent': 'kehikot-host', ...(init.headers as Record<string, string> | undefined) } })
  }

  /** `gh api` for a caller that wants only the value: null when gh cannot say. Counted against nothing here but `stats.gh`. */
  async function ghValue(path: string): Promise<unknown | null> {
    const through = await viaGh(path.replace(/^\//, ''))
    return through?.ok ? through.value : null
  }

  /** The last good answer for `path`, however old, and when it was read. */
  function last(path: string): { value: unknown; at: number } | null {
    const one = kept.get(path.startsWith('/') ? path : `/${path}`)
    return one ? { value: one.value, at: one.at } : null
  }

  return {
    api,
    raw,
    ghValue,
    last,
    stats: (): Stats & { spent: number; budget: number; frees: number | null } => {
      prune()
      /* When the oldest call spent stops counting: the next slot. */
      return { ...stats, spent: spent.length, budget, frees: spent.length ? spent[0]! + WINDOW_MS : null }
    },
  }
}

export type GitHubGateway = ReturnType<typeof githubGateway>
