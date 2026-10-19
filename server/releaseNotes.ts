import { isVersionTag } from './versions.ts'

/**
 * Release notes, read from GitHub for the repositories this host knows.
 *
 * ## What is asked, and of whom
 *
 * `GET https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>` for one
 * release, and `…/releases?per_page=…` for a repository's list. Unauthenticated:
 * release notes are public, a public repository needs no token, and this host
 * holds none. (The person's `gh` is for what is theirs — the issues they file
 * — and spawning it to read a public page would make the notes depend on a
 * login they do not need.)
 *
 * ## Which repositories
 *
 * Only ones this host already knows: the desktop app's own (`APP_REPO`), and
 * the repositories of official and registered modules (`allowed`, given by the
 * server). The page names a repository, and one that is not on that list is
 * refused before anything is asked — a page that could name any repository
 * could make this host fetch whatever it liked.
 *
 * ## Cached, and failing gently
 *
 * Answers are kept in memory: a release for `FRESH_MS`, "there is no such
 * release" for `MISSING_MS`, a failure for `FAILED_MS` — so a person who comes
 * back online is not told "unreachable" for long. GitHub allows sixty
 * unauthenticated requests an hour per address; when it says they are used up
 * (403 or 429 with `x-ratelimit-remaining: 0`), that is said, and nothing is
 * asked again until the reset it names. Every failure carries the release
 * page's address, so "Open on GitHub" always works.
 *
 * The notes are returned as GitHub has them — markdown, untrusted. The page
 * renders them as text through `src/host/markdown.ts` and never as markup.
 */

/** The desktop app: where Kehikot's own releases are published. */
export const APP_REPO = 'Jalez/kehikko-desktop'

export const FRESH_MS = 30 * 60_000
export const MISSING_MS = 10 * 60_000
export const FAILED_MS = 60_000
/** The longest a rate limit holds the cache, whatever reset GitHub names. */
export const LIMITED_MAX_MS = 60 * 60_000
export const TIMEOUT_MS = 10_000
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

export type Got<T> = { ok: true; value: T } | { ok: false; why: string; status: number; url: string }

export interface Deps {
  /** Whether `owner/repo` is one this host knows. `APP_REPO` is always known. */
  allowed(repo: string): boolean | Promise<boolean>
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

type Kept<T> = { at: number; until: number; got: Got<T> }

export function releaseNotesDesk(deps: Deps) {
  const now = deps.now ?? Date.now
  const get = deps.fetch ?? fetch
  const notes = new Map<string, Kept<Release>>()
  const lists = new Map<string, Kept<ReleaseSummary[]>>()
  /** Until when GitHub said not to ask (its limit is per address, not per repository). */
  let limitedUntil = 0
  let limitedWhy = ''

  const key = (repo: string, tag = '') => `${repo.toLowerCase()}@${tag}`

  async function known(repo: string): Promise<boolean> {
    if (!isRepo(repo)) return false
    if (repo.toLowerCase() === APP_REPO.toLowerCase()) return true
    try {
      return await deps.allowed(repo)
    } catch {
      return false
    }
  }

  /** Ask GitHub; a JSON value, or a failure in words. */
  async function ask(path: string, page: string, missing: string): Promise<Got<unknown> & { until: number }> {
    const at = now()
    if (at < limitedUntil) return { ok: false, why: limitedWhy, status: 503, url: page, until: limitedUntil }
    let response: Response
    try {
      response = await get(`https://api.github.com${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'kehikot-host',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      const timedOut = (error as Error)?.name === 'TimeoutError'
      return {
        ok: false,
        why: timedOut ? `GitHub did not answer within ${TIMEOUT_MS / 1000}s.` : 'GitHub could not be reached — this computer may be offline.',
        status: 502,
        url: page,
        until: at + FAILED_MS,
      }
    }
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
      const until = Number.isFinite(reset) && reset > at ? Math.min(reset, at + LIMITED_MAX_MS) : at + FAILED_MS
      const when = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      limitedUntil = until
      limitedWhy = `GitHub's limit for reading without an account is used up until ${when}.`
      return { ok: false, why: limitedWhy, status: 503, url: page, until }
    }
    if (response.status === 404) return { ok: false, why: missing, status: 404, url: page, until: at + MISSING_MS }
    if (!response.ok) {
      return { ok: false, why: `GitHub answered ${response.status}.`, status: 502, url: page, until: at + FAILED_MS }
    }
    try {
      return { ok: true, value: await response.json(), until: at + FRESH_MS }
    } catch {
      return { ok: false, why: 'GitHub answered with something that is not JSON.', status: 502, url: page, until: at + FAILED_MS }
    }
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
    const asked = await ask(
      `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      page,
      `No release notes were published for ${tag}.`,
    )
    let got: Got<Release>
    if (asked.ok) {
      const read = readRelease(repo, asked.value)
      got = read ? { ok: true, value: read } : { ok: false, why: `No release notes were published for ${tag}.`, status: 404, url: page }
    } else {
      got = { ok: false, why: asked.why, status: asked.status, url: asked.url }
    }
    notes.set(key(repo, tag), { at: now(), until: asked.until, got })
    return got
  }

  /** A repository's releases, newest first. Each one's notes are kept as well, so opening one asks nothing more. */
  async function releases(repo: string): Promise<Got<ReleaseSummary[]>> {
    const page = releasePage(repo)
    if (!(await known(repo))) return { ok: false, why: `${repo} is not a repository this host knows.`, status: 403, url: page }
    const kept = fresh(lists, key(repo))
    if (kept) return kept
    const asked = await ask(`/repos/${repo}/releases?per_page=${LIST_SIZE}`, page, `${repo} has no releases.`)
    let got: Got<ReleaseSummary[]>
    if (asked.ok && Array.isArray(asked.value)) {
      const read = asked.value.map((one) => readRelease(repo, one)).filter((one): one is Release => one !== null)
      for (const one of read) notes.set(key(repo, one.tag), { at: now(), until: asked.until, got: { ok: true, value: one } })
      got = { ok: true, value: read.map(({ body: _body, ...summary }) => summary) }
    } else if (asked.ok) {
      got = { ok: false, why: 'GitHub answered with something that is not a list of releases.', status: 502, url: page }
    } else if (asked.status === 404) {
      got = { ok: true, value: [] }
    } else {
      got = { ok: false, why: asked.why, status: asked.status, url: asked.url }
    }
    lists.set(key(repo), { at: now(), until: asked.until, got })
    return got
  }

  /** The tags of a repository that have a release, or null when that could not be read. Never throws. */
  async function released(repo: string): Promise<ReadonlySet<string> | null> {
    const got = await releases(repo).catch(() => null)
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
      return got.ok ? reply(got.value) : reply({ error: got.why, url: got.url }, got.status)
    }
    if (url.pathname === '/host/releases') {
      const repo = url.searchParams.get('repo') ?? ''
      if (!isRepo(repo)) return reply({ error: 'Name a repository as owner/name.' }, 400)
      const got = await releases(repo)
      return got.ok ? reply({ repo, url: releasePage(repo), releases: got.value }) : reply({ error: got.why, url: got.url }, got.status)
    }
    return null
  }

  return { release, releases, released, route }
}

export type ReleaseNotesDesk = ReturnType<typeof releaseNotesDesk>
