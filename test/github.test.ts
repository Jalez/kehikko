import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BUDGET, GH_BACKOFF_MS, githubGateway, PRIORITY, RESERVE, WINDOW_MS, type GhRan } from '../server/github.ts'

/* GitHub, stubbed: every request recorded with the headers it carried. */
function world(
  reply: (url: string, headers: Record<string, string>, n: number) => Response,
  more: Partial<Parameters<typeof githubGateway>[0]> = {},
) {
  let clock = 5_000_000
  const asked: { url: string; headers: Record<string, string> }[] = []
  const gateway = githubGateway({
    now: () => clock,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      asked.push({ url: String(input), headers })
      return reply(String(input), headers, asked.length)
    }) as typeof fetch,
    ...more,
  })
  return { gateway, asked, tick: (ms: number) => void (clock += ms), now: () => clock }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('conditional requests', () => {
  test('the ETag of the last answer is sent back, and a 304 is the kept value and costs nothing of the budget', async () => {
    const w = world((_url, headers) => (headers['if-none-match'] === '"v1"' ? new Response(null, { status: 304 }) : json([1, 2], 200, { etag: '"v1"' })))
    expect(await w.gateway.api('/repos/a/b/releases', PRIORITY.app)).toMatchObject({ ok: true, value: [1, 2], via: 'anonymous' })
    expect(w.gateway.stats().spent).toBe(1)
    expect(await w.gateway.api('/repos/a/b/releases', PRIORITY.app)).toMatchObject({ ok: true, value: [1, 2], via: 'unchanged' })
    expect(w.asked[1]!.headers['if-none-match']).toBe('"v1"')
    expect(w.gateway.stats()).toMatchObject({ spent: 1, anonymous: 2, unchanged: 1 })
  })

  test('answers and the spent calls survive a restart: the new run asks conditionally and remembers the hour', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'github-'))
    try {
      const file = join(dir, 'github-cache.json')
      const first = world(() => json([1], 200, { etag: '"e"' }), { file })
      await first.gateway.api('/repos/a/b/releases', PRIORITY.app)
      const second = world((_u, h) => (h['if-none-match'] === '"e"' ? new Response(null, { status: 304 }) : json([9])), { file })
      expect(second.gateway.stats().spent).toBe(1)
      expect(await second.gateway.api('/repos/a/b/releases', PRIORITY.app)).toMatchObject({ value: [1], via: 'unchanged' })
      expect(JSON.parse(readFileSync(file, 'utf8')).answers['/repos/a/b/releases'].etag).toBe('"e"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the budget', () => {
  test('anonymous calls stop at the budget, well under GitHub’s sixty', async () => {
    expect(BUDGET).toBeLessThanOrEqual(30)
    const w = world(() => json({}))
    for (let i = 0; i < BUDGET; i++) expect((await w.gateway.api(`/repos/a/b/releases/tags/v${i}`, PRIORITY.app)).ok).toBe(true)
    const over = await w.gateway.api('/repos/a/b/releases/tags/vX', PRIORITY.app)
    expect(over).toMatchObject({ ok: false, waiting: true, status: 503 })
    expect(w.asked).toHaveLength(BUDGET)
  })

  test('what matters less waits first: each priority keeps its calls back for those above', async () => {
    const w = world(() => json({}))
    const fill = async (n: number) => {
      for (let i = 0; i < n; i++) await w.gateway.api(`/repos/a/b/x${w.asked.length}`, PRIORITY.app)
    }
    await fill(BUDGET - RESERVE[PRIORITY.other])
    expect(await w.gateway.api('/repos/o/o/other', PRIORITY.other)).toMatchObject({ ok: false, waiting: true })
    expect((await w.gateway.api('/repos/o/o/works', PRIORITY.worksWith)).ok).toBe(true)
    await fill(RESERVE[PRIORITY.other] - RESERVE[PRIORITY.worksWith] - 1)
    expect(await w.gateway.api('/repos/o/o/works2', PRIORITY.worksWith)).toMatchObject({ ok: false, waiting: true })
    expect((await w.gateway.api('/repos/o/o/notes', PRIORITY.notes)).ok).toBe(true)
    await fill(RESERVE[PRIORITY.worksWith] - RESERVE[PRIORITY.notes] - 1)
    expect(await w.gateway.api('/repos/o/o/notes2', PRIORITY.notes)).toMatchObject({ ok: false, waiting: true })
    expect((await w.gateway.api('/repos/a/b/app', PRIORITY.app)).ok).toBe(true)
  })

  test('a waiting call is told when to come back, is not dropped, and is read once the hour frees room', async () => {
    const w = world(() => json({ v: 1 }))
    for (let i = 0; i < BUDGET; i++) await w.gateway.api(`/repos/a/b/${i}`, PRIORITY.app)
    const waiting = await w.gateway.api('/repos/o/o/other', PRIORITY.app)
    expect(waiting).toMatchObject({ ok: false, waiting: true })
    expect(waiting.ok ? 0 : waiting.retryAt).toBeGreaterThan(w.now())
    w.tick(WINDOW_MS + 1)
    expect(await w.gateway.api('/repos/o/o/other', PRIORITY.app)).toMatchObject({ ok: true })
  })

  test('GitHub saying the limit is used up holds every anonymous call until its reset', async () => {
    const w = world(() => json({ message: 'rate' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor((5_000_000 + 600_000) / 1000)) }))
    expect(await w.gateway.api('/repos/a/b/x', PRIORITY.app)).toMatchObject({ ok: false, status: 503 })
    expect(await w.gateway.api('/repos/a/b/y', PRIORITY.app)).toMatchObject({ ok: false, status: 503 })
    expect(w.asked).toHaveLength(1)
  })
})

describe('the person’s gh', () => {
  const ok = (value: unknown): GhRan => ({ ok: true, value })

  test('gh is asked first, and GitHub is not asked at all when it answers', async () => {
    const seen: string[] = []
    const w = world(() => json({}), { gh: async (p) => (seen.push(p), ok([1])) })
    expect(await w.gateway.api('/repos/a/b/releases', PRIORITY.other)).toMatchObject({ ok: true, via: 'gh', value: [1] })
    expect(seen).toEqual(['repos/a/b/releases'])
    expect(w.asked).toHaveLength(0)
    expect(w.gateway.stats()).toMatchObject({ gh: 1, anonymous: 0, spent: 0 })
  })

  test('gh with no budget cost answers even when the anonymous budget is spent', async () => {
    let usable = false
    const w = world(() => json({}), { gh: async () => (usable ? ok({}) : { ok: false, status: null, usable: false }) })
    for (let i = 0; i < BUDGET; i++) await w.gateway.api(`/repos/a/b/${i}`, PRIORITY.app)
    w.tick(GH_BACKOFF_MS + 1)
    usable = true
    expect(await w.gateway.api('/repos/a/b/late', PRIORITY.other)).toMatchObject({ ok: true, via: 'gh' })
  })

  test('a gh that is not logged in is left alone for a while, not spawned for every call', async () => {
    let spawned = 0
    const w = world(() => json({}), { gh: async () => (spawned++, { ok: false, status: null, usable: false }) })
    await w.gateway.api('/repos/a/b/1', PRIORITY.app)
    await w.gateway.api('/repos/a/b/2', PRIORITY.app)
    expect(spawned).toBe(1)
    w.tick(GH_BACKOFF_MS + 1)
    await w.gateway.api('/repos/a/b/3', PRIORITY.app)
    expect(spawned).toBe(2)
  })

  test('a value of the wrong shape from gh (an error object where a list is wanted) is not taken: anonymous is asked', async () => {
    const w = world(() => json([1, 2]), { gh: async () => ok({ message: 'Not Found' }) })
    expect(await w.gateway.api('/repos/a/b/releases', PRIORITY.app, Array.isArray)).toMatchObject({ ok: true, via: 'anonymous', value: [1, 2] })
  })

  test('the last good answer is kept however it was read', async () => {
    const w = world(() => json({}), { gh: async () => ok(['kept']) })
    await w.gateway.api('/repos/a/b/releases', PRIORITY.app)
    expect(w.gateway.last('/repos/a/b/releases')?.value).toEqual(['kept'])
  })
})

describe('raw reads', () => {
  test('raw.githubusercontent is counted and does not spend the API budget', async () => {
    const w = world(() => new Response('{}'))
    await w.gateway.raw('https://raw.githubusercontent.com/a/b/c/package.json')
    expect(w.gateway.stats()).toMatchObject({ raw: 1, spent: 0, anonymous: 0 })
  })
})
