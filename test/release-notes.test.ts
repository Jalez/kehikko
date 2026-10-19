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
