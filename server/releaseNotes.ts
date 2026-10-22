import { githubGateway, PRIORITY, type GitHubGateway, type Priority } from './github.ts'
import { isVersionTag } from './versions.ts'

/**
 * Release notes, read from GitHub for the repositories this host knows.
 *
 * ## What is asked, and of whom
 *
 * `GET https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>` for one
 * release, and `…/releases?per_page=…` for a repository's list. Every request
 * goes through the gateway (`github.ts`): the person's own `gh` when it is
 * logged in, otherwise anonymously within a budget, with conditional requests
 * (a 304 costs nothing) and the last good answer kept. This file is what is
 * asked and what the answers mean.
 *
 * ## Which repositories
 *
 * Only ones this host already knows: the desktop app's own (`APP_REPO`), and
 * the repositories of official and registered modules (`allowed`, given by the
 * server). The page names a repository, and one that is not on that list is
 * refused before anything is asked.
 *
 * ## An empty list is a claim
 *
 * "No releases are published yet" is said only when GitHub answered 200 with
 * an empty list. A 404, an error, a limit, a wait for budget or a non-list
 * is a failure and says so — and when there is a last good list it is shown,
 * marked old (`old`). Failures and empty answers are cached for a minute
 * (`FAILED_MS`, `MISSING_MS`), a good one for `FRESH_MS`.
 *
 * The notes are returned as GitHub has them — markdown, untrusted. The page
 * renders them as text through `src/host/markdown.ts` and never as markup.
 */

/** The desktop app: where Kehikot's own releases are published. */
export const APP_REPO = 'Jalez/kehikko-desktop'

export const FRESH_MS = 30 * 60_000
export const MISSING_MS = 60_000
export const FAILED_MS = 60_000
/** The longest a rate limit holds the cache, whatever reset GitHub names. */
/** How many releases a list reads: one page, enough history to pick from. */
export const LIST_SIZE = 30
/** The most of one release's notes that is passed on. */
export const BODY_MAX = 100_000

const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/

export interface Release {
  repo: string
  tag: string
  name: string | null
  body: string
  url: string
  publishedAt: string | null
  prerelease: boolean
}

/** One row of a repository's releases: everything but the notes. */
export type ReleaseSummary = Omit<Release, 'body'>

export type Got<T> =
  | {
      ok: true
      value: T
      /** Why this is the last good answer and not a new one; absent for a fresh one. */
      old?: string
    }
  | { ok: false; why: string; status: number; url: string; waiting?: boolean }

export interface Deps {
  /** Whether `owner/repo` is one this host knows. `APP_REPO` is always known. */
  allowed(repo: string): boolean | Promise<boolean>
  /** Where every GitHub request goes (`github.ts`). Made from `fetch` and `gh` when not given. */
  gateway?: GitHubGateway
  /** For a test or a caller with no gateway: `gh api <path>`'s JSON, or null when gh is not there, not logged in, or says no. */
  gh?(path: string): Promise<unknown | null>
  fetch?: typeof fetch
  now?(): number
}

/** The release page on GitHub, for "Open on GitHub" whatever else happened. */
export function releasePage(repo: string, tag?: string): string {
  return tag ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}` : `https://github.com/${repo}/releases`
}

/** Whether `repo` is spelled as `owner/name`, and nothing that could be read as a path. */
export function isRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && REPO.test(repo) && !repo.includes('..')
}

type Asked = { ok: true; value: unknown; until: number } | { ok: false; why: string; status: number; url: string; until: number; waiting?: boolean }

type Kept<T> = { at: number; until: number; got: Got<T> }

export function releaseNotesDesk(deps: Deps) {
  const now = deps.now ?? Date.now
  const gateway =
    deps.gateway ??
    githubGateway({
      fetch: deps.fetch,
      now: deps.now,
      gh: deps.gh
        ? async (path) => {
            const value = await deps.gh!(path)
            return value === null ? { ok: false, status: null, usable: false } : { ok: true, value }
          }
        : undefined,
    })
  const notes = new Map<string, Kept<Release>>()
  const lists = new Map<string, Kept<ReleaseSummary[]>>()

  const key = (repo: string, tag = '') => `${repo.toLowerCase()}@${tag}`
  const isApp = (repo: string) => repo.toLowerCase() === APP_REPO.toLowerCase()
  const priorityOf = (repo: string): Priority => (isApp(repo) ? PRIORITY.app : PRIORITY.notes)

  async function known(repo: string): Promise<boolean> {
    if (!isRepo(repo)) return false
    if (isApp(repo)) return true
    try {
      return await deps.allowed(repo)
    } catch {
      return false
    }
  }

  const isRecord = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value)

  /** Ask through the gateway: a JSON value of the wanted shape, or a failure in words and how long it holds. */
  async function ask(
    path: string,
    page: string,
    priority: Priority,
    accept: (value: unknown) => boolean,
  ): Promise<Asked> {
    const at = now()
    const got = await gateway.api(path, priority, accept)
    if (got.ok) return { ok: true, value: got.value, until: at + FRESH_MS }
    const hold = got.waiting ? Math.max(1000, Math.min(got.retryAt - at, FAILED_MS)) : got.status === 404 ? MISSING_MS : Math.max(1000, got.retryAt - at)
    return { ok: false, why: got.why, status: got.status, url: page, until: at + hold, waiting: got.waiting }
  }

  function readRelease(repo: string, raw: unknown): Release | null {
    if (!raw || typeof raw !== 'object') return null
    const one = raw as Record<string, unknown>
    if (one.draft === true || typeof one.tag_name !== 'string') return null
    const tag = one.tag_name
    const url = typeof one.html_url === 'string' && one.html_url.startsWith('https://github.com/') ? one.html_url : releasePage(repo, tag)
    const body = typeof one.body === 'string' ? one.body : ''
    return {
      repo,
      tag,
      name: typeof one.name === 'string' && one.name.trim() ? one.name.slice(0, 200) : null,
      body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n\n…` : body,
      url,
      publishedAt: typeof one.published_at === 'string' ? one.published_at : null,
      prerelease: one.prerelease === true,
    }
  }

  function fresh<T>(cache: Map<string, Kept<T>>, at: string): Got<T> | null {
    const kept = cache.get(at)
    if (kept && now() < kept.until) return kept.got
    return null
  }

  /** One release's notes. */
  async function release(repo: string, tag: string): Promise<Got<Release>> {
    const page = releasePage(repo, tag)
    if (!(await known(repo))) return { ok: false, why: `${repo} is not a repository this host knows.`, status: 403, url: page }
    if (!isVersionTag(tag)) return { ok: false, why: 'A release is named by a version tag such as v1.2.0.', status: 400, url: page }
    const kept = fresh(notes, key(repo, tag))
    if (kept) return kept
    const asked = await ask(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, page, priorityOf(repo), isRecord)
    const missing = `No release notes were published for ${tag}.`
    let got: Got<Release>
    if (asked.ok) {
      const read = readRelease(repo, asked.value)
      got = read ? { ok: true, value: read } : { ok: false, why: missing, status: 404, url: page }
    } else {
      got = { ok: false, why: asked.status === 404 ? missing : asked.why, status: asked.status, url: asked.url, ...(asked.waiting ? { waiting: true } : {}) }
    }
    notes.set(key(repo, tag), { at: now(), until: asked.until, got })
    return got
  }

  /** What a failed read of a repository's releases is told as. Kehikot's own are never "none". */
  function troubleWith(repo: string, asked: Extract<Asked, { ok: false }>): string {
    const reason = asked.why.replace(/[.\s]+$/, '')
    if (!isApp(repo)) return asked.waiting ? `${repo}'s releases will be read in a moment.` : asked.why
    return asked.waiting
      ? `Kehikot's releases will be read in a moment (${reason.replace(/;.*$/, '')}).`
      : `Couldn't read Kehikot's releases from GitHub (${reason}); try again in a moment.`
  }

  /** A repository's releases, newest first. Each one's notes are kept as well, so opening one asks nothing more. */
  async function releases(repo: string, priority: Priority = priorityOf(repo)): Promise<Got<ReleaseSummary[]>> {
    const page = releasePage(repo)
    if (!(await known(repo))) return { ok: false, why: `${repo} is not a repository this host knows.`, status: 403, url: page }
    const kept = fresh(lists, key(repo))
    if (kept) return kept
    const path = `/repos/${repo}/releases?per_page=${LIST_SIZE}`
    const asked = await ask(path, page, priority, Array.isArray)
    const summaries = (list: unknown[], until: number | null) => {
      const read = list.map((one) => readRelease(repo, one)).filter((one): one is Release => one !== null)
      if (until !== null) for (const one of read) notes.set(key(repo, one.tag), { at: now(), until, got: { ok: true, value: one } })
      return read.map(({ body: _body, ...summary }) => summary)
    }
    let got: Got<ReleaseSummary[]>
    let until = asked.until
    if (asked.ok) {
      /* Only here, a 200, can the list be empty and mean "none". */
      got = { ok: true, value: summaries(asked.value as unknown[], asked.until) }
    } else {
      const last = gateway.last(path)
      const old = last && Array.isArray(last.value) ? summaries(last.value, null) : []
      if (old.length > 0) {
        got = { ok: true, value: old, old: troubleWith(repo, asked) }
      } else if (asked.status === 404 && !isApp(repo)) {
        /* A module's repository GitHub does not show: it has no releases that can be read. */
        got = { ok: true, value: [] }
      } else {
        got = { ok: false, why: troubleWith(repo, asked), status: asked.status === 404 ? 502 : asked.status, url: asked.url, ...(asked.waiting ? { waiting: true } : {}) }
      }
      until = Math.min(until, now() + FAILED_MS)
    }
    lists.set(key(repo), { at: now(), until, got })
    return got
  }

  /** The tags of a repository that have a release, or null when that could not be read. Never throws. */
  async function released(repo: string): Promise<ReadonlySet<string> | null> {
    const got = await releases(repo, isApp(repo) ? PRIORITY.app : PRIORITY.other).catch(() => null)
    return got?.ok ? new Set(got.value.map((one) => one.tag)) : null
  }

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  /** `GET /host/release-notes?repo=&tag=` and `GET /host/releases?repo=`; null for any other request. */
  async function route(request: Request, url: URL): Promise<Response | null> {
    if (request.method !== 'GET') return null
    if (url.pathname === '/host/release-notes') {
      const repo = url.searchParams.get('repo') ?? ''
      const tag = url.searchParams.get('tag') ?? ''
      if (!isRepo(repo)) return reply({ error: 'Name a repository as owner/name.' }, 400)
      const got = await release(repo, tag)
      return got.ok ? reply(got.value) : reply({ error: got.why, url: got.url, ...(got.waiting ? { waiting: true } : {}) }, got.status)
    }
    if (url.pathname === '/host/releases') {
      const repo = url.searchParams.get('repo') ?? ''
      if (!isRepo(repo)) return reply({ error: 'Name a repository as owner/name.' }, 400)
      const got = await releases(repo)
      return got.ok
        ? reply({ repo, url: releasePage(repo), releases: got.value, ...(got.old ? { old: got.old } : {}) })
        : reply({ error: got.why, url: got.url, ...(got.waiting ? { waiting: true } : {}) }, got.status)
    }
    return null
  }

  return { release, releases, released, route }
}

export type ReleaseNotesDesk = ReturnType<typeof releaseNotesDesk>
