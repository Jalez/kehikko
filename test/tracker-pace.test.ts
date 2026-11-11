import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrackerRow } from 'kehikot-module-protocol'

import type { Ran, Runner } from '../server/feedback.ts'
import type { Adapter, Read } from '../server/trackers/common.ts'
import { trouble } from '../server/trackers/common.ts'
import { githubAdapter } from '../server/trackers/github.ts'
import { gitlabAdapter } from '../server/trackers/gitlab.ts'
import { BASE_MS, MAX_MS, Pace, SELF_HOSTED_MS } from '../server/trackers/pace.ts'
import { Trackers } from '../server/trackers/reading.ts'
import type { Source } from '../server/trackers/sources.ts'
import { isTimedOutSaid, timedOutSaid } from '../src/host/trackerSources.ts'

/**
 * Jalez/kehikko#317: a slow tracker host is given longer and asked for less at
 * a time, a read that stops part way keeps what it read, and a timeout says so.
 * Fake CLIs only.
 */

const NOW = new Date('2026-10-05T12:00:00.000Z')
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }
const ok = (out: unknown, code = 0): Ran => ({ code, out: JSON.stringify(out), err: '' })
const killed = (): Ran => ({ code: null, out: '', err: 'Post "https://gitlab.example.org/api/graphql": terminated signal received', timedOut: true })

type Answer = (argv: string[], timeout: number | undefined) => Ran
function runner(answer: Answer): Runner & { timeouts: Array<number | undefined> } {
  const timeouts: Array<number | undefined> = []
  const run = (async (argv: string[], options?: { timeout?: number }) => {
    timeouts.push(options?.timeout)
    return answer(argv, options?.timeout)
  }) as Runner & { timeouts: Array<number | undefined> }
  run.timeouts = timeouts
  return run
}

const iidsIn = (argv: string[], what: string): number[] => {
  const q = argv.find((a) => a.startsWith('query=')) ?? ''
  const m = q.match(new RegExp(`${what}\\(iids: \\[([^\\]]*)\\]`))
  return m ? [...m[1]!.matchAll(/"(\d+)"/g)].map((x) => Number(x[1])) : []
}
const issueNodes = (issues: number[]) => ({ data: { project: { issues: { nodes: issues.map((iid) => ({ iid: String(iid), state: 'opened', title: `t${iid}`, webUrl: `w${iid}` })) } } } })

describe('a host is given what it needs', () => {
  test('a public host starts at 30 s, a self-hosted one at 90 s', () => {
    const pace = new Pace()
    expect(pace.limitMs('gitlab.com')).toBe(BASE_MS)
    expect(pace.limitMs('github.com')).toBe(BASE_MS)
    expect(pace.limitMs('gitlab.example.org')).toBe(SELF_HOSTED_MS)
  })

  test('a timeout doubles the limit, up to the most, and halves what is asked', () => {
    const pace = new Pace()
    pace.heard('gitlab.com', 30_000, true)
    expect(pace.limitMs('gitlab.com')).toBe(60_000)
    expect(pace.size('gitlab.com', 22)).toBe(11)
    for (let i = 0; i < 10; i += 1) pace.heard('gitlab.com', 1, true)
    expect(pace.limitMs('gitlab.com')).toBe(MAX_MS)
    expect(pace.size('gitlab.com', 22)).toBe(1)
  })

  test('a slow answer asks for less next time and gives more time; fast answers let both settle back', () => {
    const pace = new Pace()
    pace.heard('gitlab.com', 27_000, false)
    expect(pace.size('gitlab.com', 100)).toBe(50)
    expect(pace.limitMs('gitlab.com')).toBe(81_000)
    for (let i = 0; i < 40; i += 1) pace.heard('gitlab.com', 1_000, false)
    expect(pace.size('gitlab.com', 100)).toBe(100)
    expect(pace.limitMs('gitlab.com')).toBe(BASE_MS)
  })

  test('a held call teaches nothing', async () => {
    const pace = new Pace()
    const timed = pace.runner(async () => ({ code: 1, out: '', err: 'held', held: true }), () => 0)
    await timed(['gh', 'api'], 'github.com')
    expect(pace.limitMs('github.com')).toBe(BASE_MS)
  })
})

describe('a timeout says so', () => {
  test('after how long, and what to do — not glab’s "terminated signal received"', () => {
    const said = trouble({ ...killed(), waitedMs: 90_000 }, 'glab', 'gitlab.example.org')
    expect(said).toBe(timedOutSaid('gitlab.example.org', 90))
    expect(said).toContain('timed out after 90 s')
    expect(said).not.toContain('terminated')
    expect(isTimedOutSaid(said)).toBe(true)
    expect(isTimedOutSaid(`group/project: ${said} (3 of 9 references not read)`)).toBe(true)
    expect(isTimedOutSaid('gitlab.example.org could not be reached from this machine')).toBe(false)
    expect(isTimedOutSaid(null)).toBe(false)
  })
})

describe('GitLab, slow', () => {
  test('a self-hosted GitLab is given 90 s; a batch that runs over is halved and asked with longer', async () => {
    const sizes: number[] = []
    const run = runner((argv, timeout) => {
      const issues = iidsIn(argv, 'issues')
      sizes.push(issues.length)
      return issues.length > 6 ? killed() : ok(issueNodes(issues))
    })
    const wanted = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, kind: 'issue' as const }))
    const read = await gitlabAdapter(run, () => 0).refs(gl, wanted, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows.map((r) => r.number).sort((a, b) => a - b)).toEqual(wanted.map((w) => w.number))
    expect(read.unread).toBeUndefined()
    expect(run.timeouts[0]).toBe(SELF_HOSTED_MS)
    expect(run.timeouts[1]).toBe(SELF_HOSTED_MS * 2)
    expect(sizes[0]).toBe(20)
    expect(Math.max(...sizes.slice(1))).toBeLessThan(20)
  })

  test('the next read starts smaller, having learned', async () => {
    const pace = new Pace()
    const sizes: number[] = []
    const run = runner((argv) => {
      const issues = iidsIn(argv, 'issues')
      sizes.push(issues.length)
      return issues.length > 11 ? killed() : ok(issueNodes(issues))
    })
    const adapter = gitlabAdapter(run, () => 0, pace)
    const wanted = Array.from({ length: 22 }, (_, i) => ({ number: i + 1, kind: 'issue' as const }))
    await adapter.refs(gl, wanted, NOW.toISOString())
    sizes.length = 0
    await adapter.refs(gl, wanted, NOW.toISOString())
    expect(sizes[0]).toBeLessThan(22)
  })

  test('one reference that still runs over is unread, with the timeout sentence', async () => {
    const run = runner((argv) => (iidsIn(argv, 'issues').includes(3) ? killed() : ok(issueNodes(iidsIn(argv, 'issues')))))
    const wanted = Array.from({ length: 4 }, (_, i) => ({ number: i + 1, kind: 'issue' as const }))
    const read = await gitlabAdapter(run, () => 0).refs(gl, wanted, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows.map((r) => r.number).sort()).toEqual([1, 2, 4])
    expect(read.unread?.refs).toEqual([{ number: 3, kind: 'issue' }])
    expect(read.unread?.why).toMatch(/^Reading gitlab\.example\.org timed out after \d+ s\. Try again/)
  })

  test('a later page that fails keeps the pages read, and says the read is partial', async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ iid: (n - 1) * 100 + i + 1, state: 'closed', title: 't', web_url: 'w' }))
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (line.includes('/issues?')) return /page=1(&|$)/.test(line) ? ok(page(1)) : killed()
      if (line.includes('/merge_requests?')) return ok([])
      return ok({ data: { project: {} } })
    })
    const read = await gitlabAdapter(run, () => 0).list(gl, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows).toHaveLength(100)
    expect(read.partial).toContain('timed out after')
    expect(read.partial).toContain('The newest 100 were read')
  })

  test('open items whose deeper read runs over come back as unread, not silently thinner', async () => {
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (line.includes('/issues?')) return ok([{ iid: 1, state: 'opened', title: 't', web_url: 'w' }])
      if (line.includes('/merge_requests?')) return ok([{ iid: 2, state: 'opened', title: 'm', web_url: 'w', description: '' }])
      return killed()
    })
    const read = await gitlabAdapter(run, () => 0).list(gl, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows).toHaveLength(2)
    expect(read.unread?.refs.map((r) => `${r.kind}:${r.number}`).sort()).toEqual(['change:2', 'issue:1'])
    expect(read.unread?.why).toContain('timed out after')
  })
})

describe('GitHub, slow', () => {
  test('a listing page that runs over is asked again smaller, and a later failure keeps what was read', async () => {
    const sizes: number[] = []
    let calls = 0
    const run = runner((argv) => {
      const q = argv.find((a) => a.startsWith('query=')) ?? ''
      const size = Number(q.match(/first: (\d+)/)?.[1] ?? 0)
      sizes.push(size)
      calls += 1
      if (calls === 1) return { code: null, out: '', err: 'signal: killed', timedOut: true }
      if (calls === 2) {
        return ok({ data: { repository: {
          issues: { pageInfo: { hasNextPage: true, endCursor: 'abc' }, nodes: [{ number: 1, state: 'OPEN', title: 'a', url: 'u' }] },
          pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] },
        } } })
      }
      return { code: 1, out: '', err: 'HTTP 502: Bad Gateway' }
    })
    const read = await githubAdapter(run, () => 0).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(sizes[0]).toBe(50)
    expect(sizes[1]).toBe(25)
    expect(read.rows.map((r) => r.number)).toEqual([1])
    expect(read.partial).toContain('502')
  })
})

describe('the reading keeps what a partial read did not reach', () => {
  let folder: string
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-pace-')))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const remotes: Runner = async (argv) =>
    argv[0] === 'git'
      ? { code: 0, out: 'origin\thttps://gitlab.example.org/group/project.git (fetch)\norigin\thttps://gitlab.example.org/group/project.git (push)', err: '' }
      : { code: 1, out: '', err: '' }

  const row = (number: number, over: Partial<TrackerRow> = {}): TrackerRow => ({
    ref: `!${number}`,
    tracker: 'gitlab',
    host: 'gitlab.example.org',
    repo: 'group/project',
    number,
    kind: 'change',
    state: 'open',
    title: `change ${number}`,
    url: `https://gitlab.example.org/group/project/-/merge_requests/${number}`,
    labels: [],
    assignees: [],
    links: [],
    readAt: NOW.toISOString(),
    ...over,
  })

  function adapter(reads: Read[]): Adapter {
    return {
      async list() {
        return reads.shift()!
      },
      async refs() {
        return { ok: true, rows: [], notFound: [] }
      },
      async detail() {
        return new Map()
      },
    }
  }

  test('a thin row keeps the pipeline it had; a partial listing keeps the rows it did not reach; the source says why', async () => {
    const trackers = new Trackers({
      run: remotes,
      now: () => NOW,
      adapters: {
        gitlab: adapter([
          { ok: true, rows: [row(1, { pipeline: 'success' }), row(2)], notFound: [] },
          {
            ok: true,
            rows: [row(1, { title: 'renamed' })],
            notFound: [],
            unread: { why: timedOutSaid('gitlab.example.org', 90), refs: [{ number: 1, kind: 'change' }] },
            partial: 'stopped part way',
          },
        ]),
      },
    })
    await trackers.refresh(folder, { project: true })
    await trackers.refresh(folder, { project: true })
    const got = trackers.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    const byNumber = new Map(got.rows.map((r) => [r.number, r]))
    expect(byNumber.get(1)).toMatchObject({ title: 'renamed', pipeline: 'success' })
    expect(byNumber.has(2)).toBe(true)
    expect(got.sources[0]!.error).toContain('timed out after 90 s')
  })
})
