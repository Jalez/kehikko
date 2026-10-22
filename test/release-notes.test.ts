import { describe, expect, test } from 'bun:test'

import {
  APP_REPO,
  FAILED_MS,
  FRESH_MS,
  MISSING_MS,
  releaseNotesDesk,
  releasePage,
  type Deps,
} from '../server/releaseNotes.ts'

/* GitHub, stubbed: every request is recorded, and answered by `reply`. */
function world(reply: (url: string) => Response | Promise<Response>, allowed: Deps['allowed'] = () => false) {
  let clock = 1_000_000
  const asked: string[] = []
  const desk = releaseNotesDesk({
    allowed,
    now: () => clock,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input)
      asked.push(url)
      return reply(url)
    }) as typeof fetch,
  })
  return {
    desk,
    asked,
    tick(ms: number) {
      clock += ms
    },
    get clock() {
      return clock
    },
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const release = (tag: string, more: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Kehikot ${tag}`,
  body: `### What's new\n- **${tag}** things`,
  html_url: `https://github.com/${APP_REPO}/releases/tag/${tag}`,
  published_at: '2026-10-19T11:35:41Z',
  draft: false,
  prerelease: false,
  ...more,
})

const get = (desk: ReturnType<typeof releaseNotesDesk>, path: string) =>
  desk.route(new Request(`http://127.0.0.1:4181${path}`), new URL(`http://127.0.0.1:4181${path}`))

describe('which repositories', () => {
  test('the app’s own repository is always known', async () => {
    const w = world(() => json(release('v0.1.24')))
    const got = await w.desk.release(APP_REPO, 'v0.1.24')
    expect(got).toMatchObject({ ok: true, value: { tag: 'v0.1.24', repo: APP_REPO, url: releasePage(APP_REPO, 'v0.1.24') } })
    expect(w.asked).toEqual([`https://api.github.com/repos/${APP_REPO}/releases/tags/v0.1.24`])
  })

  test('a repository the host does not know is refused, and GitHub is never asked', async () => {
    const w = world(() => json(release('v1.0.0')))
    const got = await w.desk.release('someone/else', 'v1.0.0')
    expect(got).toMatchObject({ ok: false, status: 403 })
    expect(await w.desk.releases('someone/else')).toMatchObject({ ok: false, status: 403 })
    expect(w.asked).toEqual([])
    const answered = await get(w.desk, '/host/release-notes?repo=someone/else&tag=v1.0.0')
    expect(answered?.status).toBe(403)
    expect(w.asked).toEqual([])
  })

  test('a module’s repository is known when the server says so', async () => {
    const w = world(
      () => json(release('v2.0.0')),
      (repo) => repo === 'Jalez/kehikko-notes',
    )
    expect(await w.desk.release('Jalez/kehikko-notes', 'v2.0.0')).toMatchObject({ ok: true })
    expect(await w.desk.release('Jalez/kehikko-other', 'v2.0.0')).toMatchObject({ ok: false, status: 403 })
  })

  test('a repository or a tag that could be read as a path is refused before anything', async () => {
    const w = world(() => json(release('v1.0.0')), () => true)
    expect((await get(w.desk, '/host/release-notes?repo=../../etc&tag=v1.0.0'))?.status).toBe(400)
    expect((await get(w.desk, `/host/release-notes?repo=${APP_REPO}&tag=../../x`))?.status).toBe(400)
    expect((await get(w.desk, `/host/release-notes?repo=${APP_REPO}&tag=main`))?.status).toBe(400)
    expect(w.asked).toEqual([])
  })
})

describe('the cache', () => {
  test('a release is asked for once, and again once it is stale', async () => {
    const w = world(() => json(release('v0.1.24')))
    await w.desk.release(APP_REPO, 'v0.1.24')
    await w.desk.release(APP_REPO, 'v0.1.24')
    expect(w.asked).toHaveLength(1)
    w.tick(FRESH_MS + 1)
    await w.desk.release(APP_REPO, 'v0.1.24')
    expect(w.asked).toHaveLength(2)
  })

  test('the list keeps each release’s notes, so opening one asks nothing more; drafts are left out', async () => {
    const w = world(() => json([release('v0.1.24'), release('v0.1.25', { draft: true }), release('v0.1.23')]))
    const list = await w.desk.releases(APP_REPO)
    expect(list.ok && list.value.map((one) => one.tag)).toEqual(['v0.1.24', 'v0.1.23'])
    expect(list.ok && 'body' in list.value[0]!).toBe(false)
    expect(await w.desk.release(APP_REPO, 'v0.1.23')).toMatchObject({ ok: true, value: { body: expect.stringContaining('v0.1.23') } })
    expect(w.asked).toEqual([`https://api.github.com/repos/${APP_REPO}/releases?per_page=30`])
    expect([...((await w.desk.released(APP_REPO)) ?? [])]).toEqual(['v0.1.24', 'v0.1.23'])
    expect(w.asked).toHaveLength(1)
  })

  test('no such release is said, kept for a while, and asked again after', async () => {
    const w = world(() => json({ message: 'Not Found' }, 404))
    const got = await w.desk.release(APP_REPO, 'v9.9.9')
    expect(got).toEqual({ ok: false, why: 'No release notes were published for v9.9.9.', status: 404, url: releasePage(APP_REPO, 'v9.9.9') })
    await w.desk.release(APP_REPO, 'v9.9.9')
    expect(w.asked).toHaveLength(1)
    w.tick(MISSING_MS + 1)
    await w.desk.release(APP_REPO, 'v9.9.9')
    expect(w.asked).toHaveLength(2)
  })
})

describe('when GitHub cannot answer', () => {
  test('offline: a sentence and the release page, briefly kept, then asked again', async () => {
    let offline = true
    const w = world(() => {
      if (offline) throw new TypeError('fetch failed')
      return json(release('v0.1.24'))
    })
    const got = await w.desk.release(APP_REPO, 'v0.1.24')
    expect(got).toMatchObject({ ok: false, status: 502, url: releasePage(APP_REPO, 'v0.1.24') })
    expect(!got.ok && got.why).toContain('could not be reached')
    offline = false
    await w.desk.release(APP_REPO, 'v0.1.24')
    expect(w.asked).toHaveLength(1)
    w.tick(FAILED_MS + 1)
    expect(await w.desk.release(APP_REPO, 'v0.1.24')).toMatchObject({ ok: true })
  })

  test('rate limited: said, and nothing at all is asked until the reset it names', async () => {
    const w = world(() =>
      json({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor((w.clock + 15 * 60_000) / 1000)),
      }),
    )
    const got = await w.desk.release(APP_REPO, 'v0.1.24')
    expect(got).toMatchObject({ ok: false, status: 503 })
    expect(!got.ok && got.why).toContain('limit')
    /* Another release, and the list: the limit is the address's, so neither is asked. */
    expect(await w.desk.release(APP_REPO, 'v0.1.23')).toMatchObject({ ok: false, status: 503 })
    expect(await w.desk.releases(APP_REPO)).toMatchObject({ ok: false, status: 503 })
    expect(w.asked).toHaveLength(1)
    expect(await w.desk.released(APP_REPO)).toBeNull()
  })

  test('any other failure says the status, and the route hands back the release page', async () => {
    const w = world(() => json({}, 500))
    const answered = await get(w.desk, `/host/release-notes?repo=${APP_REPO}&tag=v0.1.24`)
    expect(answered?.status).toBe(502)
    expect(await answered?.json()).toEqual({ error: 'GitHub answered 500.', url: releasePage(APP_REPO, 'v0.1.24') })
  })
})

describe('the routes', () => {
  test('notes and the list, as JSON; anything else is not theirs', async () => {
    const w = world((url) => (url.includes('/tags/') ? json(release('v0.1.24')) : json([release('v0.1.24')])))
    const one = await get(w.desk, `/host/release-notes?repo=${APP_REPO}&tag=v0.1.24`)
    expect(one?.status).toBe(200)
    expect(await one?.json()).toMatchObject({ tag: 'v0.1.24', name: 'Kehikot v0.1.24', body: expect.stringContaining("What's new") })
    const list = await get(w.desk, `/host/releases?repo=${APP_REPO}`)
    expect(await list?.json()).toMatchObject({ repo: APP_REPO, releases: [{ tag: 'v0.1.24' }] })
    expect(await get(w.desk, '/host/health')).toBeNull()
    expect(await w.desk.route(new Request('http://x/host/releases', { method: 'POST' }), new URL('http://x/host/releases'))).toBeNull()
  })

  test('a release page that is not on github.com is replaced by the one this host spells', async () => {
    const w = world(() => json(release('v0.1.24', { html_url: 'javascript:alert(1)' })))
    const got = await w.desk.release(APP_REPO, 'v0.1.24')
    expect(got.ok && got.value.url).toBe(releasePage(APP_REPO, 'v0.1.24'))
  })
})

describe('Kehikot’s release list never claims there are none when it could not read them', () => {
  const app = (...tags: string[]) => tags.map((tag) => release(tag))
  const trouble = (why: string) => `Couldn't read Kehikot's releases from GitHub (${why}); try again in a moment.`

  test('only an empty 200 is "none published"', async () => {
    const w = world(() => json([]))
    expect(await w.desk.releases(APP_REPO)).toEqual({ ok: true, value: [] })
  })

  test('a 404 for the app is a failure in one sentence, status 502, not an empty list', async () => {
    const w = world(() => json({ message: 'Not Found' }, 404))
    expect(await w.desk.releases(APP_REPO)).toMatchObject({ ok: false, status: 502, why: trouble('GitHub answered 404 (not found)') })
    const answered = await get(w.desk, `/host/releases?repo=${APP_REPO}`)
    expect(answered?.status).toBe(502)
    expect(await answered!.json()).toMatchObject({ error: trouble('GitHub answered 404 (not found)') })
  })

  test('an error, a non-list and an unreachable GitHub each say what went wrong', async () => {
    expect(await world(() => json({}, 500)).desk.releases(APP_REPO)).toMatchObject({ ok: false, why: trouble('GitHub answered 500') })
    expect(await world(() => json({ message: 'Not Found' })).desk.releases(APP_REPO)).toMatchObject({
      ok: false,
      why: trouble('GitHub answered with something other than expected'),
    })
    const offline = world(() => {
      throw new TypeError('fetch failed')
    })
    expect(await offline.desk.releases(APP_REPO)).toMatchObject({ ok: false, why: trouble('GitHub could not be reached — this computer may be offline') })
  })

  test('the rate limit says so', async () => {
    const w = world(() => json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(2_000_000 / 1000)) }))
    const got = await w.desk.releases(APP_REPO)
    expect(got).toMatchObject({ ok: false, status: 503 })
    expect(!got.ok && got.why).toContain('GitHub’s limit'.replace('’', "'"))
  })

  test('short of budget the app’s list says it will be read in a moment, marked waiting', async () => {
    let clock = 1_000_000
    const desk = releaseNotesDesk({
      allowed: () => false,
      now: () => clock,
      fetch: (async () => json([])) as unknown as typeof fetch,
      gateway: {
        api: async () => ({ ok: false, waiting: true, why: 'GitHub is being asked less often to stay within its limit; this will be read in a moment.', status: 503, retryAt: clock + 20_000 }),
        last: () => null,
      } as never,
    })
    const got = await desk.releases(APP_REPO)
    expect(got).toMatchObject({ ok: false, waiting: true, status: 503 })
    expect(!got.ok && got.why).toMatch(/^Kehikot's releases will be read in a moment/)
  })

  test('the last good list is kept and shown, marked old, when a later reading fails', async () => {
    let fail = false
    const w = world(() => (fail ? json({}, 500) : json(app('v0.1.2', 'v0.1.1'))))
    expect(await w.desk.releases(APP_REPO)).toMatchObject({ ok: true, value: [{ tag: 'v0.1.2' }, { tag: 'v0.1.1' }] })
    fail = true
    w.tick(FRESH_MS + 1)
    const got = await w.desk.releases(APP_REPO)
    expect(got).toMatchObject({ ok: true, value: [{ tag: 'v0.1.2' }, { tag: 'v0.1.1' }], old: trouble('GitHub answered 500') })
    const answered = await (await get(w.desk, `/host/releases?repo=${APP_REPO}`))!.json()
    expect(answered).toMatchObject({ old: trouble('GitHub answered 500') })
  })

  test('failed and empty answers are held for about a minute, a good one for much longer', async () => {
    expect(FAILED_MS).toBeLessThanOrEqual(60_000)
    expect(MISSING_MS).toBeLessThanOrEqual(60_000)
    const failing = world(() => json({}, 500))
    await failing.desk.releases(APP_REPO)
    await failing.desk.releases(APP_REPO)
    expect(failing.asked).toHaveLength(1)
    failing.tick(FAILED_MS + 1)
    await failing.desk.releases(APP_REPO)
    expect(failing.asked).toHaveLength(2)

    const empty = world(() => json({}, 404))
    await empty.desk.releases(APP_REPO)
    empty.tick(MISSING_MS + 1)
    await empty.desk.releases(APP_REPO)
    expect(empty.asked).toHaveLength(2)

    const good = world(() => json(app('v0.1.2')))
    await good.desk.releases(APP_REPO)
    good.tick(FRESH_MS - 1000)
    await good.desk.releases(APP_REPO)
    expect(good.asked).toHaveLength(1)
    good.tick(2000)
    await good.desk.releases(APP_REPO)
    expect(good.asked).toHaveLength(2)
  })

  test('a failed list is read again by itself after the minute, and then the list is back', async () => {
    let fail = true
    const w = world(() => (fail ? json({ message: 'Not Found' }, 404) : json(app('v0.1.2'))))
    expect((await w.desk.releases(APP_REPO)).ok).toBe(false)
    fail = false
    w.tick(FAILED_MS + 1)
    expect(await w.desk.releases(APP_REPO)).toMatchObject({ ok: true, value: [{ tag: 'v0.1.2' }] })
  })

  test('the gh fallback: a list is used, an error object or a non-list from gh is not taken as a list', async () => {
    const withGh = (value: unknown, github: Response) =>
      releaseNotesDesk({ allowed: () => false, gh: async () => value, fetch: (async () => github) as unknown as typeof fetch })
    expect(await withGh(app('v0.1.5'), json({}, 404)).releases(APP_REPO)).toMatchObject({ ok: true, value: [{ tag: 'v0.1.5' }] })
    expect(await withGh({ message: 'Not Found' }, json({}, 404)).releases(APP_REPO)).toMatchObject({ ok: false, status: 502 })
    expect(await withGh({ message: 'Not Found' }, json(app('v0.1.6'))).releases(APP_REPO)).toMatchObject({ ok: true, value: [{ tag: 'v0.1.6' }] })
  })

  test('a module whose repository GitHub does not show keeps its quiet empty list', async () => {
    const w = world(() => json({}, 404), (repo) => repo === 'Jalez/kehikko-notes')
    expect(await w.desk.releases('Jalez/kehikko-notes')).toEqual({ ok: true, value: [] })
  })

  test('nothing is asked until something is: a desk is lazy, and a list is asked once for all its notes', async () => {
    const w = world(() => json(app('v0.1.2', 'v0.1.1')))
    expect(w.asked).toHaveLength(0)
    await w.desk.releases(APP_REPO)
    await w.desk.release(APP_REPO, 'v0.1.2')
    await w.desk.release(APP_REPO, 'v0.1.1')
    expect(w.asked).toHaveLength(1)
  })

  test('after the hold the list is asked with its ETag, and a 304 keeps it without spending the budget', async () => {
    let clock = 1_000_000
    const seen: (string | undefined)[] = []
    const desk = releaseNotesDesk({
      allowed: () => false,
      now: () => clock,
      fetch: (async (_url: string, init: RequestInit) => {
        const tag = (init.headers as Record<string, string>)['if-none-match']
        seen.push(tag)
        return tag ? new Response(null, { status: 304 }) : json(app('v0.1.2'), 200, { etag: '"abc"' })
      }) as unknown as typeof fetch,
    })
    await desk.releases(APP_REPO)
    clock += FRESH_MS + 1
    expect(await desk.releases(APP_REPO)).toMatchObject({ ok: true, value: [{ tag: 'v0.1.2' }] })
    expect(seen).toEqual([undefined, '"abc"'])
  })
})
