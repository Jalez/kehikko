import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { trafficAccountSchema, trafficReadResult } from 'kehikot-module-protocol'

import type { Ran } from '../server/feedback.ts'
import {
  anonymousBudget,
  budgetRows,
  classify,
  decide,
  floorOf,
  githubAccount,
  githubHeaders,
  gitlabHeaders,
  parseRateLimit,
  pressed,
  pressedRequest,
  shareOf,
  splitIncluded,
  takeCost,
  withCost,
  withInclude,
  type Limit,
  type Spend,
} from '../server/githubAccount.ts'
import { noteHeld, TrafficRecord, trafficDoor } from '../server/traffic.ts'

/**
 * Kehikot's own budget for the person's signed-in GitHub calls (`server/githubAccount.ts`). Every
 * `gh` here is a stub: nothing reaches GitHub and no credential is read.
 */

const T0 = Date.UTC(2026, 9, 26, 10, 0, 0)
const RESET = T0 + 30 * 60_000
const secs = (ms: number) => String(Math.floor(ms / 1000))

const limit = (remaining: number, total = 5000, reset: number | null = RESET): Limit => ({ limit: total, used: total - remaining, remaining, reset })
const spent = (used: number): Spend => ({ used, reset: RESET, started: T0 })

describe('the share and the floor', () => {
  test('are 20% and 10% of the hourly limit', () => {
    expect(shareOf(5000)).toBe(1000)
    expect(floorOf(5000)).toBe(500)
    expect(shareOf(15000)).toBe(3000)
  })

  test('a background read goes under the share and is held at it, until the reset', () => {
    const base = { resource: 'core' as const, urgency: 'background' as const, now: T0, limit: limit(4800), backoff: null }
    expect(decide({ ...base, spend: spent(999) })).toEqual({ go: true })
    const held = decide({ ...base, spend: spent(1000) })
    expect(held.go).toBe(false)
    if (held.go) return
    expect(held.kind).toBe('share')
    expect(held.until).toBe(RESET)
    expect(held.why).toMatch(/^Kehikot's share of your GitHub limit is used until \d{1,2}[:.]\d{2}/)
    expect(decide({ ...base, resource: 'graphql', spend: spent(1000) })).toMatchObject({ go: false, why: expect.stringContaining('GraphQL') })
  })

  test('a pressed read may go past the share', () => {
    expect(decide({ resource: 'core', urgency: 'pressed', now: T0, limit: limit(4000), spend: spent(1500), backoff: null })).toEqual({ go: true })
  })

  test('near the floor: a pressed read and a background read are both held; a write is not', () => {
    const base = { resource: 'core' as const, now: T0, limit: limit(499), spend: spent(10), backoff: null }
    const background = decide({ ...base, urgency: 'background' })
    const press = decide({ ...base, urgency: 'pressed' })
    expect(background).toMatchObject({ go: false, kind: 'floor', until: RESET })
    expect(press).toMatchObject({ go: false, kind: 'floor' })
    if (!press.go) expect(press.why).toMatch(/^Your GitHub limit is down to 499 of 5,000; Kehikot leaves the last 500 to you until/)
    expect(decide({ ...base, urgency: 'write' })).toEqual({ go: true })
    /* Just above the floor a press goes, while the share still holds a background read. */
    const above = { ...base, limit: limit(500), spend: spent(1000) }
    expect(decide({ ...above, urgency: 'pressed' })).toEqual({ go: true })
    expect(decide({ ...above, urgency: 'background' })).toMatchObject({ go: false, kind: 'share' })
  })

  test('numbers whose window reset no longer hold anything back', () => {
    expect(decide({ resource: 'core', urgency: 'background', now: RESET + 1, limit: limit(10), spend: spent(5000), backoff: null })).toEqual({ go: true })
  })

  test('a wait GitHub asked for holds everything, writes included', () => {
    const backoff = { resource: 'all' as const, until: T0 + 60_000, why: 'GitHub asked Kehikot to slow down' }
    for (const urgency of ['background', 'pressed', 'write'] as const) {
      expect(decide({ resource: 'core', urgency, now: T0, limit: limit(4000), spend: spent(0), backoff })).toMatchObject({ go: false, kind: 'slowed' })
    }
    const graphql = { resource: 'graphql' as const, until: T0 + 60_000, why: 'used up' }
    expect(decide({ resource: 'core', urgency: 'background', now: T0, limit: limit(4000), spend: spent(0), backoff: graphql })).toEqual({ go: true })
    expect(decide({ resource: 'graphql', urgency: 'write', now: T0, limit: limit(4000), spend: spent(0), backoff: graphql })).toMatchObject({ go: false, kind: 'limited' })
  })

  test('which requests are a person pressing', () => {
    const at = (path: string) => new URL(`http://127.0.0.1${path}`)
    expect(pressedRequest('POST', at('/host/tracker/refresh'))).toBe(true)
    expect(pressedRequest('GET', at('/host/updates?fetch=1'))).toBe(true)
    expect(pressedRequest('GET', at('/host/updates?fetch=1&quiet=1'))).toBe(false)
    expect(pressedRequest('POST', at('/host/updates'))).toBe(true)
    expect(pressedRequest('GET', at('/host/tracker'))).toBe(false)
    expect(pressedRequest('GET', at('/host/releases'))).toBe(false)
    expect(pressedRequest('POST', at('/host/mine/add'))).toBe(true)
  })
})

describe('reading what GitHub says', () => {
  test('rate_limit: core and graphql, reset in ms', () => {
    const text = JSON.stringify({ resources: { core: { limit: 5000, used: 11, remaining: 4989, reset: 1793012281 }, graphql: { limit: 5000, used: 63, remaining: 4937, reset: 1793011742 } } })
    expect(parseRateLimit(text)).toEqual({
      core: { limit: 5000, used: 11, remaining: 4989, reset: 1793012281000 },
      graphql: { limit: 5000, used: 63, remaining: 4937, reset: 1793011742000 },
    })
    expect(parseRateLimit('not json')).toBeNull()
    expect(parseRateLimit('{}')).toBeNull()
  })

  test('an answer printed with --include: status, headers and body, whatever the line endings', () => {
    const out = 'HTTP/2.0 200 OK\nContent-Type: application/json\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 4936\r\nX-Ratelimit-Reset: 1793011742\r\nX-Ratelimit-Resource: graphql\r\nX-Ratelimit-Used: 64\r\n\r\n{"data":{"viewer":{"login":"someone"}}}'
    const said = splitIncluded(out)!
    expect(said.status).toBe(200)
    expect(said.body).toBe('{"data":{"viewer":{"login":"someone"}}}')
    expect(githubHeaders(said.headers)).toEqual({ resource: 'graphql', limit: { limit: 5000, remaining: 4936, used: 64, reset: 1793011742000 } })
    expect(splitIncluded('{"plain":true}')).toBeNull()
    expect(splitIncluded('HTTP/2.0 204 No Content\r\nX-A: 1')).toEqual({ status: 204, headers: new Map([['x-a', '1']]), body: '' })
  })

  test('GitLab’s RateLimit headers', () => {
    const said = splitIncluded('HTTP/2.0 200 OK\r\nRateLimit-Limit: 2000\r\nRateLimit-Observed: 3\r\nRateLimit-Remaining: 1997\r\nRateLimit-Reset: 1793011742\r\n\r\n{}')!
    expect(gitlabHeaders(said.headers)).toEqual({ limit: 2000, used: 3, remaining: 1997, reset: 1793011742000 })
  })

  test('which runs count, against which limit', () => {
    expect(classify(['gh', 'api', 'repos/a/b/releases'])).toMatchObject({ forge: 'github', resource: 'core', write: false, include: true })
    expect(classify(['gh', 'api', 'rate_limit'])).toMatchObject({ resource: null })
    expect(classify(['gh', 'api', 'graphql', '-f', 'query=query { viewer { login } }'])).toMatchObject({ resource: 'graphql', graphql: true, write: false })
    expect(classify(['gh', 'api', 'graphql', '-f', 'query=mutation { x }'])).toMatchObject({ resource: 'graphql', write: true })
    expect(classify(['gh', 'issue', 'list', '--repo', 'a/b'])).toMatchObject({ resource: 'graphql', write: false, include: false })
    expect(classify(['gh', 'issue', 'create', '--repo', 'a/b'])).toMatchObject({ write: true })
    expect(classify(['gh', 'api', 'user', '--hostname', 'ghe.example.com'])).toBeNull()
    expect(classify(['gh', 'auth', 'status'])).toBeNull()
    expect(classify(['git', 'fetch', 'origin'])).toBeNull()
    expect(classify(['glab', 'api', '--hostname', 'gitlab.com', 'user'])).toMatchObject({ forge: 'gitlab', include: true })
    expect(classify(['glab', 'api', '--hostname', 'gitlab.com', 'graphql', '-f', 'query={x}'])).toMatchObject({ forge: 'gitlab', include: false })
  })

  test('a query asks its own cost, and the answer is handed back as it would have been', () => {
    expect(withInclude(['gh', 'api', 'repos/a/b'])).toEqual(['gh', 'api', '--include', 'repos/a/b'])
    const asked = withCost(['gh', 'api', 'graphql', '-f', 'query=query { repository(owner:"a",name:"b") { id } }'])!
    expect(asked[4]).toBe('query=query { kehikotCost: rateLimit { cost }  repository(owner:"a",name:"b") { id } }')
    expect(withCost(['gh', 'api', 'graphql', '-f', 'query=mutation { x }'])).toBeNull()
    expect(takeCost('{"data":{"kehikotCost":{"cost":3},"repository":{"id":"R"}}}')).toEqual({ cost: 3, body: '{"data":{"repository":{"id":"R"}}}' })
    expect(takeCost('{"data":{"repository":null}}')).toEqual({ cost: null, body: '{"data":{"repository":null}}' })
  })
})

/* ------------------------------------------------------------------------ *
 * The runner, against a stubbed gh.
 * ------------------------------------------------------------------------ */

const headers = (status: string, fields: Record<string, string | number>, body: string) =>
  `HTTP/2.0 ${status}\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('')}\r\n${body}`

function stubbed(options: { remaining?: number; graphqlRemaining?: number; signedIn?: boolean; answer?: (argv: string[]) => Ran | null; file?: string } = {}) {
  let now = T0
  const calls: string[][] = []
  const held: { argv: readonly string[]; why: string }[] = []
  const rateLimit = () =>
    JSON.stringify({
      resources: {
        core: { limit: 5000, used: 5000 - (options.remaining ?? 4800), remaining: options.remaining ?? 4800, reset: Number(secs(RESET)) },
        graphql: { limit: 5000, used: 5000 - (options.graphqlRemaining ?? 4900), remaining: options.graphqlRemaining ?? 4900, reset: Number(secs(RESET)) },
      },
    })
  const account = githubAccount({
    now: () => now,
    file: options.file,
    held: (argv, why) => held.push({ argv, why }),
    run: async (argv) => {
      calls.push(argv)
      if (argv[1] === 'api' && argv[2] === 'rate_limit') {
        return options.signedIn === false
          ? { code: 4, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login' }
          : { code: 0, out: rateLimit(), err: '' }
      }
      if (argv[1] === 'config') return { code: 0, out: 'someone', err: '' }
      return options.answer?.(argv) ?? { code: 0, out: headers('200 OK', { 'X-Ratelimit-Limit': 5000, 'X-Ratelimit-Remaining': 4700, 'X-Ratelimit-Reset': secs(RESET), 'X-Ratelimit-Resource': 'core', 'X-Ratelimit-Used': 300 }, '[]'), err: '' }
    },
  })
  return { account, calls, held, tick: (ms: number) => (now += ms), at: () => now }
}

describe('the runner', () => {
  test('reads the account once (free), asks with --include, takes the headers off and learns from them', async () => {
    const { account, calls } = stubbed()
    const ran = await account.run(['gh', 'api', 'repos/a/b/releases'])
    expect(ran).toEqual({ code: 0, out: '[]', err: '' })
    expect(calls).toEqual([
      ['gh', 'api', 'rate_limit'],
      ['gh', 'config', 'get', 'user', '-h', 'github.com'],
      ['gh', 'api', '--include', 'repos/a/b/releases'],
    ])
    const said = trafficAccountSchema.parse(account.account())
    expect(said.login).toBe('someone')
    expect(said.core).toEqual({ limit: 5000, used: 300, remaining: 4700, resets: RESET, share: { limit: 1000, used: 1 }, floor: 500 })
    expect(said.graphql?.remaining).toBe(4900)
    expect(said.paused).toBe(false)
    /* The next call does not read the account again: the headers said it. */
    await account.run(['gh', 'api', 'repos/a/b/releases'])
    expect(calls.filter((argv) => argv[2] === 'rate_limit')).toHaveLength(1)
  })

  test('charges a GraphQL query what it cost, and hands back the answer without the cost', async () => {
    const { account, calls } = stubbed({
      answer: (argv) =>
        argv.includes('graphql')
          ? { code: 0, out: headers('200 OK', { 'X-Ratelimit-Limit': 5000, 'X-Ratelimit-Remaining': 4890, 'X-Ratelimit-Reset': secs(RESET), 'X-Ratelimit-Resource': 'graphql' }, '{"data":{"kehikotCost":{"cost":4},"repository":{"id":"R"}}}'), err: '' }
          : null,
    })
    const ran = await account.run(['gh', 'api', 'graphql', '-f', 'query=query { repository(owner:"a",name:"b") { id } }'])
    expect(JSON.parse(ran.out)).toEqual({ data: { repository: { id: 'R' } } })
    expect(calls.at(-1)?.slice(0, 3)).toEqual(['gh', 'api', '--include'])
    expect(calls.at(-1)?.[5]).toContain('kehikotCost: rateLimit { cost }')
    expect(account.account()?.graphql?.share).toEqual({ limit: 1000, used: 4 })
  })

  test('a background read past the share is held, recorded with its reason, and never run; a pressed one goes', async () => {
    const { account, calls, held } = stubbed()
    await account.run(['gh', 'api', 'repos/a/b'])
    for (let i = 1; i < 1000; i++) await account.run(['gh', 'api', 'repos/a/b'])
    const before = calls.length
    const ran = await account.run(['gh', 'api', 'repos/a/b'])
    expect(ran.held).toBe(true)
    expect(ran.code).toBe(1)
    expect(ran.err).toMatch(/^Kehikot's share of your GitHub limit is used until/)
    expect(calls.length).toBe(before)
    expect(held).toHaveLength(1)
    expect(held[0]!.argv).toEqual(['gh', 'api', 'repos/a/b'])
    const press = await pressed(() => account.run(['gh', 'api', 'repos/a/b']))
    expect(press.held).toBeUndefined()
    expect(calls.length).toBe(before + 1)
    const said = account.account()!
    expect(said.paused).toBe(true)
    expect(said.why).toContain("Kehikot's share")
    expect(said.until).toBe(RESET)
  })

  test('near the floor a pressed read is held too, and the account is read again each minute', async () => {
    const { account, calls, tick } = stubbed({
      remaining: 600,
      answer: () => ({ code: 0, out: headers('200 OK', { 'X-Ratelimit-Limit': 5000, 'X-Ratelimit-Remaining': 450, 'X-Ratelimit-Reset': secs(RESET), 'X-Ratelimit-Resource': 'core' }, '{}'), err: '' }),
    })
    expect((await pressed(() => account.run(['gh', 'api', 'repos/a/b']))).held).toBeUndefined()
    const press = await pressed(() => account.run(['gh', 'api', 'repos/a/b']))
    expect(press.held).toBe(true)
    expect(press.err).toMatch(/^Your GitHub limit is down to 450 of 5,000/)
    expect((await account.run(['gh', 'api', 'repos/a/b'])).held).toBe(true)
    expect(calls.filter((argv) => argv[2] === 'rate_limit')).toHaveLength(1)
    /* A minute on, it is near the floor: the account is read again (it says 600, above the floor) before deciding. */
    tick(61_000)
    expect((await pressed(() => account.run(['gh', 'api', 'repos/a/b']))).held).toBeUndefined()
    expect(calls.filter((argv) => argv[2] === 'rate_limit')).toHaveLength(2)
  })

  test('a write the person asked for goes under the floor', async () => {
    const { account } = stubbed({ remaining: 100, graphqlRemaining: 100 })
    expect((await account.run(['gh', 'issue', 'create', '--repo', 'a/b', '--title=x', '--body-file', '-'])).held).toBeUndefined()
    expect((await account.run(['gh', 'issue', 'list', '--repo', 'a/b'])).held).toBe(true)
  })

  test('403 with nothing remaining waits until the reset, for that limit only', async () => {
    let first = true
    const { account, tick } = stubbed({
      answer: (argv) => {
        if (argv.includes('graphql')) return { code: 0, out: '{"data":{}}', err: '' }
        if (!first) return null
        first = false
        return { code: 1, out: headers('403 Forbidden', { 'X-Ratelimit-Limit': 5000, 'X-Ratelimit-Remaining': 0, 'X-Ratelimit-Reset': secs(RESET), 'X-Ratelimit-Resource': 'core' }, '{"message":"API rate limit exceeded"}'), err: 'gh: API rate limit exceeded (HTTP 403)' }
      },
    })
    const ran = await account.run(['gh', 'api', 'repos/a/b'])
    expect(ran.out).toBe('{"message":"API rate limit exceeded"}')
    const after = await pressed(() => account.run(['gh', 'api', 'repos/a/b']))
    expect(after.held).toBe(true)
    expect(after.err).toMatch(/^Your GitHub limit is used up until .+; Kehikot waits$/)
    expect((await account.run(['gh', 'api', 'graphql', '-f', 'query={ viewer { login } }'])).held).toBeUndefined()
    tick(RESET - T0 + 1000)
    expect((await account.run(['gh', 'api', 'repos/a/b'])).held).toBeUndefined()
  })

  test('429 with retry-after waits that long, for everything', async () => {
    let first = true
    const { account, tick } = stubbed({
      answer: () => {
        if (!first) return null
        first = false
        return { code: 1, out: headers('429 Too Many Requests', { 'Retry-After': 120 }, '{"message":"You have exceeded a secondary rate limit"}'), err: 'gh: HTTP 429' }
      },
    })
    await account.run(['gh', 'api', 'repos/a/b'])
    const held = await account.run(['gh', 'issue', 'create', '--repo', 'a/b'])
    expect(held.held).toBe(true)
    expect(held.err).toMatch(/^GitHub asked Kehikot to slow down; it waits until/)
    tick(119_000)
    expect((await account.run(['gh', 'api', 'repos/a/b'])).held).toBe(true)
    tick(2_000)
    expect((await account.run(['gh', 'api', 'repos/a/b'])).held).toBeUndefined()
  })

  test('a secondary limit named only in words waits a minute, then two', async () => {
    let refuse = true
    const { account, tick } = stubbed({
      answer: (argv) => (refuse && argv[1] === 'issue' ? { code: 1, out: '', err: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } : null),
    })
    await account.run(['gh', 'issue', 'list', '--repo', 'a/b'])
    tick(59_000)
    expect((await account.run(['gh', 'issue', 'list', '--repo', 'a/b'])).held).toBe(true)
    tick(2_000)
    await account.run(['gh', 'issue', 'list', '--repo', 'a/b'])
    tick(119_000)
    expect((await account.run(['gh', 'issue', 'list', '--repo', 'a/b'])).held).toBe(true)
    refuse = false
    tick(2_000)
    expect((await account.run(['gh', 'issue', 'list', '--repo', 'a/b'])).held).toBeUndefined()
  })

  test('an answer that came back fine is never read for limit words', async () => {
    const { account } = stubbed({
      answer: () => ({ code: 0, out: headers('200 OK', {}, '[{"title":"API rate limit exceeded, secondary rate limit"}]'), err: '' }),
    })
    await account.run(['gh', 'api', 'repos/a/b/issues'])
    expect((await account.run(['gh', 'api', 'repos/a/b/issues'])).held).toBeUndefined()
  })

  test('gh not signed in: nothing is budgeted and no account is said', async () => {
    const { account, calls } = stubbed({ signedIn: false, answer: () => ({ code: 4, out: '', err: 'gh auth login' }) })
    const ran = await account.run(['gh', 'api', 'repos/a/b'])
    expect(ran).toEqual({ code: 4, out: '', err: 'gh auth login' })
    expect(calls.at(-1)).toEqual(['gh', 'api', 'repos/a/b'])
    expect(account.account()).toBeNull()
  })

  test('a Monitor reading keeps the account no older than a minute, and reads it no more often', async () => {
    const { account, calls, tick } = stubbed()
    account.watch()
    await account.refreshIfDue()
    account.watch()
    account.watch()
    await account.refreshIfDue()
    expect(calls.filter((argv) => argv[2] === 'rate_limit')).toHaveLength(1)
    tick(60_000)
    account.watch()
    await account.refreshIfDue()
    expect(calls.filter((argv) => argv[2] === 'rate_limit')).toHaveLength(2)
    expect(account.watched()).toBe(true)
  })

  test('what the share spent is kept across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kehikot-account-'))
    try {
      const file = join(dir, 'github-account.json')
      const first = stubbed({ file })
      await first.account.run(['gh', 'api', 'repos/a/b'])
      await first.account.run(['gh', 'api', 'repos/a/b'])
      const second = stubbed({ file })
      await second.account.run(['gh', 'api', 'repos/a/b'])
      expect(second.account.account()?.core?.share?.used).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('GitLab’s limit is read from the headers of glab api calls, and taken off the output', async () => {
    const { account } = stubbed({
      answer: (argv) =>
        argv[0] === 'glab'
          ? { code: 0, out: headers('200 OK', { 'RateLimit-Limit': 2000, 'RateLimit-Remaining': 1990, 'RateLimit-Reset': secs(RESET), 'RateLimit-Observed': 10 }, '{"username":"me"}'), err: '' }
          : null,
    })
    const ran = await account.run(['glab', 'api', '--hostname', 'gitlab.com', 'user'])
    expect(ran.out).toBe('{"username":"me"}')
    expect(trafficAccountSchema.parse(account.gitlabAccount())).toMatchObject({ login: 'me', core: { limit: 2000, remaining: 1990, share: null, floor: null }, graphql: null })
  })
})

describe('in the record of traffic, and on traffic.read', () => {
  test('a held call is a refused row whose reason says why, then what it was for', () => {
    const record = new TrafficRecord()
    noteHeld(record, ['gh', 'api', 'graphql', '-f', 'query=x'], "Kehikot's share of your GitHub limit is used until 11:00", () => T0)
    const row = record.read(0, 10).calls[0]!
    expect(row).toMatchObject({ cache: 'refused', ok: false, kind: 'gh api', host: 'api.github.com', path: '/graphql' })
    expect(row.reason).toBe("held: Kehikot's share of your GitHub limit is used until 11:00")
  })

  test('the account and the anonymous budget, apart; the old list still filled', async () => {
    const { account } = stubbed()
    await account.run(['gh', 'api', 'repos/a/b'])
    const anonymous = anonymousBudget({ anonymous: 0, unchanged: 0, gh: 0, raw: 0, waited: 0, spent: 0, budget: 30, frees: null })
    let read = 0
    const door = trafficDoor({
      record: new TrafficRecord(),
      budgets: () => budgetRows(account.account(), anonymous),
      limits: () => ({ github: { account: account.account(), anonymous } }),
      read: () => read++,
      processes: () => null,
    })
    const answer = trafficReadResult.parse(door.read({ since: 0, limit: 10, sample: false }))
    expect(read).toBe(1)
    expect(answer.limits?.github?.account?.core?.share).toEqual({ limit: 1000, used: 1 })
    expect(answer.limits?.github?.anonymous?.used).toBe(0)
    /* An older Monitor sees Kehikot's share of the account; the unused anonymous budget is left out. */
    expect(answer.budgets.map((one) => one.name)).toEqual(["Kehikot's share of GitHub as someone", "Kehikot's share of GitHub as someone (GraphQL points)"])
    expect(answer.budgets[0]).toMatchObject({ used: 1, limit: 1000, left: 999 })
    expect(answer.budgets[0]!.note).toContain('4,700 of 5,000 left')
    /* Used this hour, or no account: it is listed. */
    expect(budgetRows(account.account(), { ...anonymous, used: 3 }).at(-1)?.name).toBe('GitHub without an account')
    expect(budgetRows(null, anonymous).map((one) => one.name)).toEqual(['GitHub without an account'])
  })
})
