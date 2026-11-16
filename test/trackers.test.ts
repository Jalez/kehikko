import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, methodResults, trackerReadingResult, type TrackerRow, type TrackerSignal } from 'kehikot-module-protocol'
import { dispositionOf, facetsOf } from 'kehikot-module-protocol/facets'

import { answer, answerCall } from '../server/answers.ts'
import { createCanvas, open } from '../server/canvases.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import { call, type Door } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject, forgetProject } from '../server/projects.ts'
import type { Adapter, Wanted } from '../server/trackers/common.ts'
import { githubAdapter } from '../server/trackers/github.ts'
import { BATCH, contributedIssues, declaredIssues, detailQuery, gitlabAdapter, refsQuery } from '../server/trackers/gitlab.ts'
import { readingFile, refsInEpic, Trackers } from '../server/trackers/reading.ts'
import { readConfig, sourceFor, sourceOfRemote, sourcesOf, type Source } from '../server/trackers/sources.ts'
import { toWireContext } from '../src/host/context.ts'

/**
 * Jalez/kehikko#23: one tracker reading per project, read by the host and
 * shared with every module. Real folders for the reading, fake CLIs for the
 * trackers — nothing here reaches GitHub or GitLab.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-trackers-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const NOW = new Date('2026-10-05T12:00:00.000Z')
const ok = (out: unknown, code = 0): Ran => ({ code, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' })
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }

/** A runner that answers by the first words of the argv, and records what it was asked. */
function runner(answers: Array<[string, Ran | ((argv: string[]) => Ran)]>): Runner & { asked: string[][] } {
  const asked: string[][] = []
  const run = (async (argv: string[]) => {
    asked.push(argv)
    const line = argv.join(' ')
    for (const [start, ran] of answers) if (line.startsWith(start)) return typeof ran === 'function' ? ran(argv) : ran
    return { code: 1, out: '', err: `nothing answers ${line}` }
  }) as Runner & { asked: string[][] }
  run.asked = asked
  return run
}

describe('which sources a project reads', () => {
  test('a GitHub origin is the default and is listed', () => {
    expect(sourceOfRemote('git@github.com:Jalez/kehikko.git')).toEqual({ tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko' })
    expect(sourceOfRemote('https://gitlab.example.org/group/sub/project.git')).toEqual({
      tracker: 'gitlab',
      host: 'gitlab.example.org',
      repo: 'group/sub/project',
    })
    expect(sourceOfRemote('https://bitbucket.org/a/b.git')).toBeNull()
    const config = readConfig(folder)
    expect(config.ok).toBe(true)
    const sources = sourcesOf(config.ok ? config.config : (null as never), ['https://github.com/Jalez/kehikko.git'])
    expect(sources).toEqual([{ ...gh }])
  })

  test('the file adds a GitLab default and an extra repository; a ref names one outright', () => {
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(
      join(folder, '.kehikot', 'host', 'trackers.json'),
      JSON.stringify({ version: 1, sources: [{ tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, list: true }] }),
    )
    const read = readConfig(folder)
    if (!read.ok) throw new Error(read.why)
    const sources = sourcesOf(read.config, ['git@github.com:Jalez/kehikko.git'], ['gh:Jalez/kehikko-protocol#6'])
    expect(sources.map((s) => [s.tracker, s.repo, s.default, s.listed])).toEqual([
      ['github', 'Jalez/kehikko', true, true],
      ['gitlab', 'group/project', true, true],
      ['github', 'Jalez/kehikko-protocol', false, false],
    ])
    expect(sourceFor(sources, '#12')?.repo).toBe('group/project')
    expect(sourceFor(sources, '!7')?.repo).toBe('group/project')
    expect(sourceFor(sources, 'gh#41')?.repo).toBe('Jalez/kehikko')
    expect(sourceFor(sources, 'gh:Jalez/kehikko-protocol#6')?.default).toBe(false)
  })

  test('a broken file says why rather than reading as defaults', () => {
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'host', 'trackers.json'), '{"version": 1, "sources": [{"tracker": "jira", "repo": "x/y"}]}')
    const read = readConfig(folder)
    expect(read.ok).toBe(false)
  })
})

describe('GitHub through gh', () => {
  const issues = [
    { number: 1, state: 'CLOSED', stateReason: 'NOT_PLANNED', title: 'Never', url: 'u1', labels: { nodes: [{ name: 'bug' }] }, assignees: { nodes: [] }, author: { login: 'a' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: '2026-01-02T00:00:00Z' },
    { number: 2, state: 'CLOSED', stateReason: null, title: 'Done by a PR', url: 'u2', labels: { nodes: [] }, assignees: { nodes: [] }, closedByPullRequestsReferences: { nodes: [] }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: '2026-01-02T00:00:00Z' },
  ]
  const prs = [
    { number: 3, state: 'MERGED', title: 'Fix', url: 'u3', labels: { nodes: [] }, assignees: { nodes: [] }, author: { login: 'b', name: 'Bee' }, isDraft: false, reviewDecision: 'APPROVED', closingIssuesReferences: { nodes: [{ number: 2 }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: '2026-01-02T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z' },
  ]

  const page = (nodes: unknown[]) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes })

  test('a listing is rows the facets read as they are', async () => {
    const run = runner([['gh api graphql', ok({ data: { repository: { issues: page(issues), pullRequests: page(prs) } } })]])
    const read = await githubAdapter(run).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    const [never, done, fix] = read.rows as [TrackerRow, TrackerRow, TrackerRow]
    expect(never.stateReason).toBe('NOT_PLANNED')
    expect(facetsOf(never)).toEqual(['issue:closed', 'closed:wont-do'])
    expect(dispositionOf(never.ref, never, []).source).toBe('tracker')
    expect(done.links).toEqual([{ ref: 'gh#3', relation: 'closed-by', state: 'merged' }])
    expect(done.closedByMerge).toBe(true)
    expect('stateReason' in done).toBe(false)
    expect(fix).toMatchObject({ ref: 'gh#3', kind: 'change', state: 'merged', pipeline: 'success', review: 'approved', author: 'Bee' })
    expect(run.asked).toHaveLength(1)
    expect(run.asked[0]!.join(' ')).toContain('repository(owner: "Jalez", name: "kehikko")')
    expect(run.asked.flat().join(' ')).not.toContain(';')
  })

  test('a named number GitHub does not have is not-found; the rest still read', async () => {
    const run = runner([
      ['gh api graphql', ok({ data: { repository: { n1: { __typename: 'Issue', ...issues[0] }, n9999: null } }, errors: [{ type: 'NOT_FOUND' }] }, 1)],
    ])
    const wanted: Wanted[] = [{ number: 1, kind: null }, { number: 9999, kind: null }]
    const read = await githubAdapter(run).refs(gh, wanted, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows.map((r) => r.ref)).toEqual(['gh#1'])
    expect(read.notFound).toEqual([{ number: 9999, kind: null }])
  })

  test('a logged-out gh is a sentence that says so', async () => {
    const run = runner([['gh api graphql', { code: 4, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login' }]])
    const read = await githubAdapter(run).list(gh, 400, NOW.toISOString())
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.why).toContain('gh auth login')
  })
})

describe('GitLab through glab', () => {
  test('a merge request delivers what its own description says it closes, and only that (Jalez/kehikko#187)', () => {
    expect(declaredIssues('Closes #12 and #13. Part of #2274; mentions #99 in passing')).toEqual([12, 13])
    expect(contributedIssues('Closes #12 and #13. Part of #2274; mentions #99 in passing')).toEqual([2274])
  })

  test('issues and merge requests list together, spelled #N and !N, and a merged declarer closes its issue', async () => {
    const run = runner([
      ['glab api --hostname gitlab.example.org projects/group%2Fproject/issues', ok([
        { iid: 12, state: 'closed', title: 'Read it', web_url: 'w12', labels: ['x'], assignees: [{ name: 'Ann' }], created_at: '2026-01-01T00:00:00.000+02:00', updated_at: '2026-01-02T00:00:00Z', closed_at: '2026-01-02T00:00:00Z' },
        { iid: 13, state: 'opened', title: 'Still', web_url: 'w13', labels: [], assignees: [] },
      ])],
      ['glab api --hostname gitlab.example.org projects/group%2Fproject/merge_requests', ok([
        { iid: 7, state: 'merged', title: 'Do it', description: 'Closes #12', web_url: 'w7', draft: false, merged_at: '2026-01-02T00:00:00Z' },
        { iid: 8, state: 'opened', title: 'More', description: '', web_url: 'w8', draft: true },
      ])],
      ['glab api --hostname gitlab.example.org graphql', ok({ data: { project: { mergeRequests: { nodes: [
        { iid: '8', state: 'opened', title: 'More', webUrl: 'w8', draft: true, description: '', approved: false, headPipeline: { status: 'RUNNING' } },
      ] } } } })],
    ])
    const read = await gitlabAdapter(run).list(gl, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    const byRef = new Map(read.rows.map((r) => [r.ref, r]))
    expect([...byRef.keys()].sort()).toEqual(['!7', '!8', '#12', '#13'])
    expect(byRef.get('#12')).toMatchObject({ state: 'closed', closedByMerge: true, links: [{ ref: '!7', relation: 'closed-by' }] })
    expect(facetsOf(byRef.get('#12')!)).toEqual(['issue:closed', 'closed:done'])
    expect(byRef.get('!7')!.links).toEqual([{ ref: '#12', relation: 'closes' }])
    expect(byRef.get('!8')).toMatchObject({ draft: true, pipeline: 'running', review: 'required' })
    expect('stateReason' in byRef.get('#12')!).toBe(false)
    expect('closedByMerge' in byRef.get('#13')!).toBe(false)
  })

  test('both by-iid queries carry first: equal to the iid count (GitLab costs a connection without it at a page of 100)', () => {
    const issues = [1, 2, 3]
    const merges = [4, 5]
    for (const query of [refsQuery(gl, issues, merges), detailQuery(gl, issues, merges)]) {
      expect(query).toMatch(/issues\(iids: \[[^\]]*\], first: 3\)/)
      expect(query).toMatch(/mergeRequests\(iids: \[[^\]]*\], first: 2\)/)
    }
  })

  /** A glab that answers each by-iid query from the iids in it. */
  const graphql = (answerFor: (issues: number[], merges: number[]) => Ran) =>
    runner([
      ['glab api --hostname gitlab.example.org graphql', (argv) => {
        const q = argv.find((a) => a.startsWith('query=')) ?? ''
        const iids = (what: string) => {
          const m = q.match(new RegExp(`${what}\\(iids: \\[([^\\]]*)\\]`))
          return m ? [...m[1]!.matchAll(/"(\d+)"/g)].map((x) => Number(x[1])) : []
        }
        return answerFor(iids('issues'), iids('mergeRequests'))
      }],
    ])
  const nodesOf = (issues: number[]) => ({ data: { project: { issues: { nodes: issues.map((iid) => ({ iid: String(iid), state: 'opened', title: `t${iid}`, webUrl: `w${iid}` })) } } } })
  const refusal = ok({ errors: [{ message: 'Query has complexity of 397, which exceeds max complexity of 250' }] }, 1)

  test('a complexity refusal halves the batch and recovers', async () => {
    const sizes: number[] = []
    const run = graphql((issues) => {
      sizes.push(issues.length)
      return issues.length > 5 ? refusal : ok(nodesOf(issues))
    })
    const wanted: Wanted[] = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, kind: 'issue' as const }))
    const read = await gitlabAdapter(run).refs(gl, wanted, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows.map((r) => r.number).sort((a, b) => a - b)).toEqual(wanted.map((w) => w.number))
    expect(read.unread).toBeUndefined()
    expect(sizes).toEqual([20, 10, 5, 5, 10, 5, 5])
  })

  test('batches are BATCH (22) iids, and one permanently refused batch costs only its refs', async () => {
    const run = graphql((issues) => (issues.includes(30) || issues.length === 1 && issues[0] === 30 ? refusal : ok(nodesOf(issues))))
    const wanted: Wanted[] = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, kind: 'issue' as const }))
    const read = await gitlabAdapter(run).refs(gl, wanted, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    /* 1..22 in one batch; 23..30 refused, halved down to the lone 30. */
    expect(read.rows.map((r) => r.number)).toHaveLength(29)
    expect(read.unread?.refs).toEqual([{ number: 30, kind: 'issue' }])
    expect(read.unread?.why).toContain('Query has complexity of 397')
    expect(read.notFound).toEqual([])
    expect(Math.max(...run.asked.map((a) => (a.find((x) => x.startsWith('query='))?.match(/"\d+"/g) ?? []).length))).toBeLessThanOrEqual(BATCH)
    expect(BATCH).toBe(22)
  })

  test('a failing batch marks only its refs failed in the shared reading, keeping the other rows', async () => {
    const bad = (issues: number[]) => issues.includes(30)
    const run = graphql((issues) => (bad(issues) ? ok({ errors: [{ message: 'boom' }] }, 1) : ok(nodesOf(issues))))
    const adapter = gitlabAdapter(run)
    const wanted: Wanted[] = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, kind: 'issue' as const }))
    const read = await adapter.refs(gl, wanted, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows).toHaveLength(BATCH)
    expect(read.unread?.refs.map((r) => r.number)).toEqual([23, 24, 25, 26, 27, 28, 29, 30])
    expect(read.unread?.why).toContain('boom')
    expect(read.notFound).toEqual([])
  })

  test('a host behind a VPN is a sentence about the network, not about the project', async () => {
    const run = runner([['glab api', { code: 1, out: '', err: 'dial tcp: lookup gitlab.example.org: no such host' }]])
    const read = await gitlabAdapter(run).refs(gl, [{ number: 1, kind: 'issue' }], NOW.toISOString())
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.why).toContain('could not be reached')
  })
})

/** A fake adapter that hands back whatever rows it is told to, and counts reads. */
function fake(rows: () => TrackerRow[], fail: () => string | null = () => null): Adapter & { reads: number } {
  const adapter = {
    reads: 0,
    async list(source: Source) {
      adapter.reads += 1
      const why = fail()
      if (why) return { ok: false as const, why }
      return { ok: true as const, rows: rows().filter((r) => r.repo === source.repo), notFound: [] }
    },
    async refs(source: Source, wanted: readonly Wanted[]) {
      adapter.reads += 1
      const why = fail()
      if (why) return { ok: false as const, why }
      const have = rows().filter((r) => r.repo === source.repo && wanted.some((w) => w.number === r.number))
      return { ok: true as const, rows: have, notFound: [] }
    },
    async detail(_source: Source, asked: readonly TrackerRow[]) {
      return new Map(asked.map((r) => [r.ref, { body: `body of ${r.ref}`, bodyClipped: false, files: [], filesClipped: false, readAt: NOW.toISOString() }]))
    },
  }
  return adapter
}

const ghRow = (number: number, over: Partial<TrackerRow> = {}): TrackerRow => ({
  ref: `gh#${number}`,
  tracker: 'github',
  host: 'github.com',
  repo: 'Jalez/kehikko',
  number,
  kind: 'issue',
  state: 'open',
  title: `issue ${number}`,
  url: `https://github.com/Jalez/kehikko/issues/${number}`,
  labels: [],
  assignees: [],
  links: [],
  readAt: NOW.toISOString(),
  ...over,
})

const remotes = runner([['git -C', ok('origin\thttps://github.com/Jalez/kehikko.git (fetch)\norigin\thttps://github.com/Jalez/kehikko.git (push)')]])
const settle = () => new Promise((r) => setTimeout(r, 60))

describe('one reading per project', () => {
  test('a ref nobody has read is pending and starts no read; the next read reads it, and the module is told when it lands', async () => {
    const told: TrackerSignal[] = []
    const adapter = fake(() => [ghRow(41, { state: 'closed', stateReason: 'COMPLETED' })])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, told: (_root, signal) => told.push(signal), now: () => NOW })
    const first = trackers.get(folder, { refs: ['gh#41'] })
    if ('refused' in first) throw new Error(first.refused)
    expect(first.missing).toEqual([{ ref: 'gh#41', reason: 'pending' }])
    await settle()
    expect(told).toEqual([])
    await trackers.refresh(folder, { project: true }, 'press')
    expect(told.at(-1)).toEqual({ at: NOW.toISOString(), refreshing: false })
    const second = trackers.get(folder, { refs: ['gh#41'] })
    if ('refused' in second) throw new Error(second.refused)
    expect(trackerReadingResult.safeParse(second).success).toBe(true)
    expect(second.rows.map((r) => [r.ref, r.state, r.stateReason])).toEqual([['gh#41', 'closed', 'COMPLETED']])
    expect(second.sources[0]).toMatchObject({ repo: 'Jalez/kehikko', default: true, at: NOW.toISOString(), error: null })
  })

  test('a row answers to the spelling it was asked by', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(41)]) }, now: () => NOW })
    await trackers.refresh(folder, { refs: ['gh:Jalez/kehikko#41'] }, 'press')
    const got = trackers.get(folder, { refs: ['gh#41', 'gh:Jalez/kehikko#41'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => r.ref)).toEqual(['gh#41', 'gh:Jalez/kehikko#41'])
  })

  test('it is kept under .kehikot/host/, with an ignore line beside it', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(1)]) }, now: () => NOW })
    await trackers.refresh(folder, { project: true }, 'press')
    expect(readingFile(folder)).toBe(join(folder, '.kehikot', 'host', 'tracker-reading.json'))
    expect(existsSync(readingFile(folder)!)).toBe(true)
    expect(readFileSync(join(folder, '.kehikot', 'host', '.gitignore'), 'utf8')).toContain('tracker-reading.json')
    /* And a second host process reads it back. */
    const again = new Trackers({ run: remotes, adapters: { github: fake(() => []) }, now: () => NOW })
    const got = again.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => r.ref)).toEqual(['gh#1'])
  })

  test('a failed source keeps what it gave last time and says why', async () => {
    let down = false
    const trackers = new Trackers({
      run: remotes,
      adapters: { github: fake(() => [ghRow(1)], () => (down ? 'github.com could not be reached.' : null)) },
      now: () => NOW,
    })
    expect((await trackers.refresh(folder, { project: true }, 'press')).outcome).toBe('read')
    down = true
    const failed = await trackers.refresh(folder, { project: true }, 'press')
    expect(failed.outcome).toBe('failed')
    expect(failed.why).toContain('could not be reached')
    const got = trackers.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => r.ref)).toEqual(['gh#1'])
    expect(got.sources[0]!.error).toContain('could not be reached')
    expect(got.sources[0]!.at).toBe(NOW.toISOString())
  })

  test('two presses are one read', async () => {
    const adapter = fake(() => [ghRow(1)])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    const [a, b] = await Promise.all([trackers.refresh(folder, { project: true }, 'press'), trackers.refresh(folder, { project: true }, 'press')])
    expect(a).toEqual(b)
    expect(adapter.reads).toBe(1)
  })

  test('a ref the tracker will not answer for is not-found after one read, not asked forever', async () => {
    const adapter = fake(() => [])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    trackers.get(folder, { refs: ['gh#404'] })
    await trackers.refresh(folder, { project: true }, 'press')
    const reads = adapter.reads
    const got = trackers.get(folder, { refs: ['gh#404'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.missing).toEqual([{ ref: 'gh#404', reason: 'not-found' }])
    await settle()
    expect(adapter.reads).toBe(reads)
  })

  /** A reading already full from its listing, and a tracker that answers any ref asked by name: counts the reads by name. */
  const fullReading = () => {
    const listed = Array.from({ length: LIMITS.TRACKER_ROWS }, (_, i) => ghRow(i + 1, { updatedAt: '2026-10-01T00:00:00.000Z' }))
    const adapter = {
      byName: 0,
      async list() {
        return { ok: true as const, rows: listed, notFound: [] }
      },
      async refs(_source: Source, wanted: readonly Wanted[]) {
        adapter.byName += 1
        return { ok: true as const, rows: wanted.map((w) => ghRow(w.number, { kind: 'change', state: 'merged', updatedAt: '2026-09-01T00:00:00.000Z' })), notFound: [] }
      },
      async detail() {
        return new Map()
      },
    }
    return adapter
  }

  test('a merged change read by name into a full reading is kept, and a module asking on every landing reads nothing (Jalez/kehikko#384)', async () => {
    const adapter = fullReading()
    const asking = (root: string, signal: TrackerSignal) => {
      if (!signal.refreshing) trackers.get(root, { refs: ['gh#5000'] })
    }
    const trackers: Trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW, told: (root, signal) => asking(root, signal) })
    await trackers.refresh(folder, { project: true }, 'press')
    trackers.get(folder, { refs: ['gh#5000'] })
    await new Promise((r) => setTimeout(r, 300))
    expect(adapter.byName).toBe(0)
    await trackers.refresh(folder, { project: true }, 'press')
    await new Promise((r) => setTimeout(r, 300))
    const got = trackers.get(folder, { refs: ['gh#5000'] })
    trackers.forget(folder)
    expect(adapter.byName).toBe(1)
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => [r.ref, r.state])).toEqual([['gh#5000', 'merged']])
  })

  test('on a schedule, a ref nobody has read, asked again and again, reads nothing until the tick or a press (Jalez/kehikko#384)', async () => {
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'host', 'trackers.json'), JSON.stringify({ version: 1, sources: [], remotes: true, every: 60 }))
    const adapter = fullReading()
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    await trackers.refresh(folder, { project: true }, 'schedule')
    for (let i = 0; i < 6; i++) {
      const asked = trackers.get(folder, { refs: ['gh#5000'] }, 'detail')
      if ('refused' in asked) throw new Error(asked.refused)
      expect(asked.missing).toEqual([{ ref: 'gh#5000', reason: 'pending' }])
      await settle()
    }
    expect(adapter.byName).toBe(0)
    trackers.tick(NOW.getTime() + 59 * 60_000)
    await settle()
    expect(adapter.byName).toBe(0)
    trackers.tick(NOW.getTime() + 61 * 60_000)
    await settle()
    const got = trackers.get(folder, { refs: ['gh#5000'] })
    trackers.forget(folder)
    if ('refused' in got) throw new Error(got.refused)
    expect(adapter.byName).toBe(1)
    expect(got.rows.map((r) => [r.ref, r.state])).toEqual([['gh#5000', 'merged']])
  })

  test('a spelling for a tracker the project does not read is no-tracker', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => []) }, now: () => NOW })
    await trackers.refresh(folder, { project: true }, 'press')
    const got = trackers.get(folder, { refs: ['#12', 'nonsense'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.missing).toEqual([{ ref: '#12', reason: 'no-tracker' }, { ref: 'nonsense', reason: 'no-tracker' }])
  })

  test('a detail asked for by refs is read by the next read, and kept', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(5)]) }, now: () => NOW })
    await trackers.refresh(folder, { refs: ['gh#5'] }, 'press')
    const first = trackers.get(folder, { refs: ['gh#5'] }, 'detail')
    if ('refused' in first) throw new Error(first.refused)
    expect(first.rows[0]!.detail).toBeUndefined()
    await settle()
    const unread = trackers.get(folder, { refs: ['gh#5'] }, 'detail')
    if ('refused' in unread) throw new Error(unread.refused)
    expect(unread.rows[0]!.detail).toBeUndefined()
    await trackers.refresh(folder, { project: true }, 'press')
    const second = trackers.get(folder, { refs: ['gh#5'] }, 'detail')
    if ('refused' in second) throw new Error(second.refused)
    expect(second.rows[0]!.detail?.body).toBe('body of gh#5')
    const summary = trackers.get(folder, { refs: ['gh#5'] })
    if ('refused' in summary) throw new Error(summary.refused)
    expect(summary.rows[0]!.detail).toBeUndefined()
  })

  test('an epic’s refs, and live.get’s four bags over the same reading', async () => {
    mkdirSync(join(folder, '.kehikot', 'host', 'epics'), { recursive: true })
    const epic = { slug: 'one', title: 'One', umbrella: 'gh#9', steps: [{ title: 's', refs: ['gh#1', 'gh#3', 'not a ref'] }] }
    writeFileSync(join(folder, '.kehikot', 'host', 'epics', 'one.json'), JSON.stringify(epic))
    expect(refsInEpic(epic).sort()).toEqual(['gh#1', 'gh#3', 'gh#9'])
    const trackers = new Trackers({
      run: remotes,
      adapters: { github: fake(() => [ghRow(1), ghRow(3, { kind: 'change', state: 'merged' }), ghRow(9)]) },
      now: () => NOW,
    })
    await trackers.refresh(folder, { epic: 'one' }, 'press')
    const got = trackers.get(folder, { epic: 'one' })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => r.ref).sort()).toEqual(['gh#1', 'gh#3', 'gh#9'])
    const live = trackers.live(folder, 'one')!
    expect(live.generated).toBe(NOW.toISOString())
    expect(Object.keys(live.ghIssues as object).sort()).toEqual(['gh#1', 'gh#9'])
    expect((live.ghPrs as Record<string, { state: string }>)['gh#3']!.state).toBe('merged')
    expect((live.ghIssues as Record<string, { state: string }>)['gh#1']!.state).toBe('opened')
    expect('refused' in trackers.get(folder, { epic: 'nope' })).toBe(true)
  })
})

describe('the person decides when the trackers are read (Jalez/kehikko#384)', () => {
  const setMode = (file: Record<string, unknown>) => {
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'host', 'trackers.json'), JSON.stringify({ version: 1, sources: [], remotes: true, ...file }))
  }
  /** Every read that started, as the containers are told of it. */
  const counted = () => {
    const started: number[] = []
    return { started, told: (_root: string, signal: TrackerSignal) => void (signal.refreshing && started.push(1)) }
  }

  test('manual: a module asking for a known and an unknown ref, again and again, starts no read; the person’s press starts exactly one', async () => {
    const reads = counted()
    const adapter = fake(() => [ghRow(1), ghRow(2)])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW, told: reads.told })
    await trackers.refresh(folder, { refs: ['gh#1'] }, 'press')
    setMode({ reading: 'manual' })
    reads.started.length = 0
    const before = adapter.reads
    for (let i = 0; i < 5; i++) {
      const got = trackers.get(folder, { refs: ['gh#1', 'gh#2'] }, 'detail')
      if ('refused' in got) throw new Error(got.refused)
      expect(got.rows.map((r) => r.ref)).toEqual(['gh#1'])
      expect(got.missing).toEqual([{ ref: 'gh#2', reason: 'pending' }])
      trackers.signal(folder)
      trackers.columns(folder)
      await settle()
    }
    expect((await trackers.refresh(folder, { refs: ['gh#2'] }, 'asked')).outcome).toBe('declined')
    trackers.tick(NOW.getTime() + 24 * 60 * 60_000)
    await settle()
    expect(reads.started).toEqual([])
    expect(adapter.reads).toBe(before)

    expect((await trackers.refresh(folder, { project: true }, 'press')).outcome).toBe('read')
    await settle()
    expect(reads.started).toHaveLength(1)
    const after = trackers.get(folder, { refs: ['gh#2'] })
    if ('refused' in after) throw new Error(after.refused)
    expect(after.rows.map((r) => r.ref)).toEqual(['gh#2'])
  })

  test('off: nothing reads, the person’s press included; what was read is still answered', async () => {
    const reads = counted()
    const adapter = fake(() => [ghRow(1)])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW, told: reads.told })
    await trackers.refresh(folder, { refs: ['gh#1'] }, 'press')
    setMode({ reading: 'off' })
    reads.started.length = 0
    const before = adapter.reads
    const pressed = await trackers.refresh(folder, { project: true }, 'press')
    expect(pressed.outcome).toBe('declined')
    expect(pressed.why).toContain('off')
    const checked = await trackers.check(folder, gh)
    expect(checked.ok).toBe(false)
    const got = trackers.get(folder, { refs: ['gh#1', 'gh#9'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => r.ref)).toEqual(['gh#1'])
    expect(got.missing).toEqual([{ ref: 'gh#9', reason: 'pending' }])
    await settle()
    expect(reads.started).toEqual([])
    expect(adapter.reads).toBe(before)
  })

  test('on a schedule: nothing is read before the interval is up, and the tick reads once it is', async () => {
    setMode({ every: 60 })
    const reads = counted()
    const adapter = fake(() => [ghRow(1)])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW, told: reads.told })
    await trackers.refresh(folder, { project: true }, 'press')
    reads.started.length = 0
    for (let i = 0; i < 3; i++) {
      trackers.get(folder, { refs: ['gh#1', 'gh#2'] }, 'detail')
      trackers.get(folder, { project: true })
      trackers.signal(folder)
      trackers.columns(folder)
      await settle()
    }
    const moduleAsked = await trackers.refresh(folder, { refs: ['gh#2'] }, 'asked')
    expect(moduleAsked.outcome).toBe('declined')
    expect(moduleAsked.why).toContain('on a schedule')
    trackers.sourcesChanged(folder, ['https://github.com/Jalez/kehikko.git'])
    await settle()
    expect(reads.started).toEqual([])
    trackers.tick(NOW.getTime() + 59 * 60_000)
    await settle()
    expect(reads.started).toEqual([])
    trackers.tick(NOW.getTime() + 61 * 60_000)
    await settle()
    expect(reads.started).toHaveLength(1)
    trackers.forget(folder)
  })

  test('on a schedule, the first look at a project nobody has read is read by the tick a moment later, not by the look', async () => {
    const reads = counted()
    const adapter = fake(() => [ghRow(1)])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW, told: reads.told })
    trackers.signal(folder)
    trackers.get(folder, { project: true })
    trackers.columns(folder)
    await settle()
    expect(reads.started).toEqual([])
    await new Promise((r) => setTimeout(r, 1300))
    expect(reads.started).toHaveLength(1)
    trackers.forget(folder)
  })

  test('no way past the gate: with reading off, every entry into the reading runs no gh, no glab and no adapter', async () => {
    mkdirSync(join(folder, '.kehikot', 'host', 'epics'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'host', 'epics', 'one.json'), JSON.stringify({ slug: 'one', title: 'One', steps: [{ title: 's', refs: ['gh#1'] }] }))
    const called: string[] = []
    const spy: Adapter = {
      list: async () => (called.push('list'), { ok: true as const, rows: [], notFound: [] }),
      refs: async (_source, wanted) => (called.push('refs'), { ok: true as const, rows: wanted.map((w) => ghRow(w.number)), notFound: [] }),
      detail: async () => (called.push('detail'), new Map()),
      boards: async () => (called.push('boards'), null),
      branches: async () => (called.push('branches'), null),
      me: async () => (called.push('me'), { login: 'me' }),
    }
    const run = runner([['git -C', ok('origin\thttps://github.com/Jalez/kehikko.git (fetch)')]])
    const fetched: string[] = []
    const trackers = new Trackers({
      run,
      adapters: { github: spy, gitlab: spy },
      now: () => NOW,
      images: { token: async () => 'token', fetch: async (url) => (fetched.push(String(url)), new Response('')) },
    })
    await trackers.refresh(folder, { refs: ['gh#1'] }, 'press')
    setMode({ reading: 'off' })
    called.length = 0
    run.asked.length = 0
    trackers.signal(folder)
    trackers.get(folder, { project: true })
    trackers.get(folder, { refs: ['gh#1', 'gh#2'] }, 'detail')
    trackers.get(folder, { epic: 'one' }, 'detail')
    trackers.columns(folder)
    trackers.live(folder, 'one')
    for (const by of ['asked', 'schedule', 'press'] as const) await trackers.refresh(folder, { project: true }, by)
    await trackers.refresh(folder, { refs: ['gh#3'] }, 'press')
    await trackers.refresh(folder, { epic: 'one' }, 'press')
    await trackers.check(folder, gh)
    await trackers.image(folder, 'gh#1', 'https://github.com/user-attachments/assets/x.png')
    trackers.sourcesChanged(folder, ['https://github.com/Jalez/kehikko.git'])
    trackers.tick(NOW.getTime() + 24 * 60 * 60_000)
    await settle()
    trackers.forget(folder)
    expect(called).toEqual([])
    expect(fetched).toEqual([])
    expect(run.asked.filter((argv) => argv[0] === 'gh' || argv[0] === 'glab')).toEqual([])
  })

  test('every read of the reading starts in refresh, after the gate', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'server', 'trackers', 'reading.ts'), 'utf8')
    expect(source.split('this.#read(').length - 1).toBe(1)
    const refresh = source.slice(source.indexOf('  refresh(root: string, scope: Scope, by: ReadBy'), source.indexOf('this.#read('))
    expect(refresh).toContain('const refused = this.refusal(root, by)')
    expect(refresh.indexOf('this.refusal(root, by)')).toBeLessThan(refresh.indexOf('if (held.running)'))
  })
})

describe('a project removed from the list', () => {
  test('is not read or written by the schedule again', async () => {
    const adapter = fake(() => [ghRow(1)])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    await trackers.refresh(folder, { project: true }, 'press')
    const reads = adapter.reads
    /* The person removes the folder from the list, then deletes its .kehikot/. */
    trackers.forget(folder)
    rmSync(join(folder, '.kehikot'), { recursive: true })
    trackers.tick(Date.now() + 20 * 60_000)
    await settle()
    expect(adapter.reads).toBe(reads)
    expect(existsSync(join(folder, '.kehikot'))).toBe(false)
  })

  test('a read already running when it is removed lands in memory, not in the folder', async () => {
    let release = () => {}
    const held = new Promise<void>((done) => (release = done))
    const adapter = fake(() => [ghRow(1)])
    const list = adapter.list
    adapter.list = async (...args) => {
      await held
      return list(...args)
    }
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    const read = trackers.refresh(folder, { project: true }, 'press')
    await settle()
    trackers.forget(folder)
    release()
    await read
    await settle()
    expect(existsSync(join(folder, '.kehikot'))).toBe(false)
    const reads = adapter.reads
    trackers.tick(Date.now() + 20 * 60_000)
    await settle()
    expect(adapter.reads).toBe(reads)
    expect(existsSync(join(folder, '.kehikot'))).toBe(false)
  })

  test('the route that removes a project tells the reading, and the watch, after it is forgotten', () => {
    const server = readFileSync(join(import.meta.dir, '..', 'server', 'server.ts'), 'utf8')
    const route = server.indexOf("url.pathname === '/host/projects' && request.method === 'DELETE'")
    expect(route).toBeGreaterThan(-1)
    const body = server.slice(route, server.indexOf('\n    }\n', route))
    const forgotten = body.indexOf('forgetProject(db, body.id)')
    expect(forgotten).toBeGreaterThan(-1)
    expect(body.indexOf('trackers.forget(said.project.path)')).toBeGreaterThan(forgotten)
    expect(body.indexOf('watchOpenProjects()')).toBeGreaterThan(forgotten)
  })

  test('an agent\'s read that refreshes reads nothing, and a project removed after it is not read or written again (Jalez/kehikko#384)', async () => {
    const adapter = fake(() => [ghRow(1)])
    const db = open(':memory:')
    const added = addProject(db, folder, 'p')
    if (!added.ok) throw new Error(added.why)
    const made = createCanvas(db, 'k', added.project.id)
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    const door: Door = { db, which: () => new Openness().open(), wake: () => {}, epicsChanged: () => {}, dispositionsChanged: () => {}, seen: async () => [], trackers }
    const said = await call('read_tracker', { kehikko: made.id, refresh: true }, door)
    expect(said.text).toContain('Refreshed: declined')
    expect(said.text).toContain('Refresh all')
    expect(adapter.reads).toBe(0)
    expect(forgetProject(db, added.project.id).ok).toBe(true)
    trackers.forget(folder)
    rmSync(join(folder, '.kehikot'), { recursive: true, force: true })
    trackers.tick(Date.now() + 20 * 60_000)
    await settle()
    expect(adapter.reads).toBe(0)
    expect(existsSync(join(folder, '.kehikot'))).toBe(false)
    db.close()
  })

  test('a refresh waiting behind a running read when it is removed is not read at all', async () => {
    let release = () => {}
    const held = new Promise<void>((done) => (release = done))
    const adapter = fake(() => [ghRow(1)])
    const refs = adapter.refs
    adapter.refs = async (...args) => {
      await held
      return refs(...args)
    }
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    /* A narrower read is running, and a whole-project read waits behind it. */
    const narrow = trackers.refresh(folder, { refs: ['gh#1'] }, 'press')
    await settle()
    const waiting = trackers.refresh(folder, { project: true }, 'press')
    trackers.forget(folder)
    release()
    await narrow
    expect((await waiting).outcome).toBe('declined')
    await settle()
    expect(existsSync(join(folder, '.kehikot'))).toBe(false)
    const reads = adapter.reads
    trackers.tick(Date.now() + 20 * 60_000)
    await settle()
    expect(adapter.reads).toBe(reads)
    expect(existsSync(join(folder, '.kehikot'))).toBe(false)
  })
})

/**
 * Jalez/kehikko#38: which change delivers which issue is worked out over the
 * whole reading, so it does not matter which read brought either side in.
 */
describe('an issue carries every held change that declares it', () => {
  const glRemotes = runner([['git -C', ok('origin\thttps://gitlab.example.org/group/project.git (fetch)')]])
  const glRow = (kind: 'issue' | 'change', number: number, over: Partial<TrackerRow> = {}): TrackerRow => ({
    ref: `${kind === 'change' ? '!' : '#'}${number}`,
    tracker: 'gitlab',
    host: 'gitlab.example.org',
    repo: 'group/project',
    number,
    kind,
    state: 'open',
    title: `${kind} ${number}`,
    url: `https://gitlab.example.org/group/project/-/${kind}/${number}`,
    labels: [],
    assignees: [],
    links: [],
    readAt: NOW.toISOString(),
    ...over,
  })
  /** An adapter whose listing and whose by-ref answers are set apart, as the two reads are. */
  function twoReads(listed: () => TrackerRow[], named: () => TrackerRow[]): Adapter {
    return {
      async list() {
        return { ok: true as const, rows: listed(), notFound: [] }
      },
      async refs(_source: Source, wanted: readonly Wanted[]) {
        const rows = named().filter((r) => wanted.some((w) => w.number === r.number && (w.kind === null || w.kind === r.kind)))
        return { ok: true as const, rows, notFound: [] }
      },
      async detail() {
        return new Map()
      },
    }
  }
  const closes12 = { links: [{ ref: '#12', relation: 'closes' as const }] }
  const rowOf = (trackers: Trackers, ref: string) => {
    const got = trackers.get(folder, { refs: [ref] })
    if ('refused' in got) throw new Error(got.refused)
    return got.rows[0]!
  }
  /** A clock that moves, so a later read is later. */
  const clock = () => {
    let at = NOW.getTime()
    return () => new Date((at += 60_000))
  }

  test('an issue read by ref after its merge request was listed keeps the back-link', async () => {
    /* The listing, as the GitLab adapter hands it over: the issue already linked. */
    const listed = [
      glRow('change', 7, { state: 'merged', ...closes12 }),
      glRow('issue', 12, { state: 'closed', closedByMerge: true, links: [{ ref: '!7', relation: 'closed-by' }] }),
    ]
    const trackers = new Trackers({
      run: glRemotes,
      adapters: { gitlab: twoReads(() => listed, () => [glRow('issue', 12, { state: 'closed' })]) },
      now: () => NOW,
    })
    await trackers.refresh(folder, { project: true }, 'press')
    await trackers.refresh(folder, { refs: ['#12'] }, 'press')
    expect(rowOf(trackers, '#12')).toMatchObject({ closedByMerge: true, links: [{ ref: '!7', relation: 'closed-by' }] })
    expect(facetsOf(rowOf(trackers, '#12'))).toEqual(['issue:closed', 'closed:done'])
  })

  test('and the reverse: a merge request listed after its issue was read by ref', async () => {
    let listed: TrackerRow[] = []
    const trackers = new Trackers({
      run: glRemotes,
      adapters: { gitlab: twoReads(() => listed, () => [glRow('issue', 12, { state: 'closed' })]) },
      now: () => NOW,
    })
    await trackers.refresh(folder, { refs: ['#12'] }, 'press')
    expect(rowOf(trackers, '#12').links).toEqual([])
    /* The issue is too old for the listing; only its merge request is in it. */
    listed = [glRow('change', 7, { state: 'merged', ...closes12 })]
    await trackers.refresh(folder, { project: true }, 'press')
    expect(rowOf(trackers, '#12')).toMatchObject({ closedByMerge: true, links: [{ ref: '!7', relation: 'closed-by' }] })
    /* And a second host process reads it back linked. */
    const again = new Trackers({ run: glRemotes, adapters: { gitlab: twoReads(() => [], () => []) }, now: () => NOW })
    expect(rowOf(again, '#12').links).toEqual([{ ref: '!7', relation: 'closed-by', state: 'merged' }])
  })

  test('a change that merged after the issue was listed says merged on the issue\'s link', async () => {
    const listed = [
      glRow('change', 7, { state: 'open', ...closes12 }),
      glRow('issue', 12, { state: 'open', links: [{ ref: '!7', relation: 'closed-by', state: 'open' }] }),
    ]
    const trackers = new Trackers({
      run: glRemotes,
      adapters: { gitlab: twoReads(() => listed, () => [glRow('change', 7, { state: 'merged', ...closes12 })]) },
      now: clock(),
    })
    await trackers.refresh(folder, { project: true }, 'press')
    expect(rowOf(trackers, '#12').links).toEqual([{ ref: '!7', relation: 'closed-by', state: 'open' }])
    await trackers.refresh(folder, { refs: ['!7'] }, 'press')
    expect(rowOf(trackers, '#12')).toMatchObject({ closedByMerge: true, links: [{ ref: '!7', relation: 'closed-by', state: 'merged' }] })
  })

  test('a merge request read by ref alone links the issue already held', async () => {
    const named = [glRow('issue', 12), glRow('change', 7, closes12), glRow('change', 8, closes12)]
    const trackers = new Trackers({ run: glRemotes, adapters: { gitlab: twoReads(() => [], () => named) }, now: () => NOW })
    await trackers.refresh(folder, { refs: ['#12'] }, 'press')
    await trackers.refresh(folder, { refs: ['!7'] }, 'press')
    await trackers.refresh(folder, { refs: ['!8'] }, 'press')
    expect(rowOf(trackers, '#12').links).toEqual([{ ref: '!7', relation: 'closed-by', state: 'open' }, { ref: '!8', relation: 'closed-by', state: 'open' }])
    /* Open declarers say nothing about how it closed. */
    expect('closedByMerge' in rowOf(trackers, '#12')).toBe(false)
  })

  test('a merge request that stops declaring an issue drops off it', async () => {
    const now = clock()
    let declares = true
    const merge = () => glRow('change', 7, { state: 'merged', readAt: now().toISOString(), ...(declares ? closes12 : {}) })
    const trackers = new Trackers({
      run: glRemotes,
      adapters: { gitlab: twoReads(() => [], () => [glRow('issue', 12, { state: 'closed', readAt: now().toISOString() }), merge()]) },
      now,
    })
    await trackers.refresh(folder, { refs: ['#12', '!7'] }, 'press')
    expect(rowOf(trackers, '#12')).toMatchObject({ closedByMerge: true, links: [{ ref: '!7', relation: 'closed-by' }] })
    declares = false
    await trackers.refresh(folder, { refs: ['!7'] }, 'press')
    expect(rowOf(trackers, '#12').links).toEqual([])
    expect('closedByMerge' in rowOf(trackers, '#12')).toBe(false)
  })

  test('a reading stored before this is linked when it is loaded', () => {
    const file = readingFile(folder)!
    mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
    writeFileSync(file, JSON.stringify({
      version: 1,
      at: NOW.toISOString(),
      fullAt: NOW.toISOString(),
      sources: [{ ...gl, at: NOW.toISOString(), error: null }],
      rows: [glRow('change', 7, { state: 'merged', ...closes12 }), glRow('issue', 12, { state: 'closed' })],
      asked: ['#12'],
      detailed: [],
      notFound: [],
    }))
    const trackers = new Trackers({ run: glRemotes, adapters: { gitlab: twoReads(() => [], () => []) }, now: () => NOW })
    expect(rowOf(trackers, '#12')).toMatchObject({ closedByMerge: true, links: [{ ref: '!7', relation: 'closed-by' }] })
  })

  test('GitHub the same: a listed issue is linked to a pull request read by ref, and keeps closers nobody holds', async () => {
    /* GitHub's own word for #2, read by ref: closed by a pull request the reading does not hold. */
    const named = [
      ghRow(2, { state: 'closed', closedByMerge: false, links: [{ ref: 'gh#90', relation: 'closed-by' }] }),
      ghRow(3, { kind: 'change', state: 'merged', links: [{ ref: 'gh#1', relation: 'closes' }, { ref: 'gh#2', relation: 'closes' }] }),
    ]
    const trackers = new Trackers({
      run: remotes,
      adapters: { github: twoReads(() => [ghRow(1, { state: 'closed' })], () => named) },
      now: () => NOW,
    })
    await trackers.refresh(folder, { project: true }, 'press')
    await trackers.refresh(folder, { refs: ['gh#2', 'gh#3'] }, 'press')
    const got = trackers.get(folder, { refs: ['gh#1', 'gh#2'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows[0]).toMatchObject({ closedByMerge: true, links: [{ ref: 'gh#3', relation: 'closed-by' }] })
    expect(got.rows[1]).toMatchObject({
      closedByMerge: true,
      links: [{ ref: 'gh#90', relation: 'closed-by' }, { ref: 'gh#3', relation: 'closed-by' }],
    })
  })
})

/**
 * Jalez/kehikko#36: `live.get` says which change delivers which issue from the
 * same reading, as the old refresher's `links` and `ghLinks` did.
 */
describe('live.get folds changes under their issues from the reading', () => {
  const known = () => true
  const epicFile = (epic: object) => {
    mkdirSync(join(folder, '.kehikot', 'host', 'epics'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'host', 'epics', 'one.json'), JSON.stringify({ slug: 'one', title: 'One', ...epic }))
  }
  const closes = (...refs: string[]) => ({ links: refs.map((ref) => ({ ref, relation: 'closes' as const })) })

  test('GitHub: under the issue as the epic spells it, by the pull request’s number', async () => {
    epicFile({ steps: [{ title: 's', refs: ['gh:Jalez/kehikko#2', 'gh#3', 'gh#5', 'gh#6'] }] })
    const rows = [
      ghRow(2),
      ghRow(3, { kind: 'change', state: 'merged', ...closes('gh#2') }),
      /* Named by the epic, for an issue the epic does not name. */
      ghRow(5, { kind: 'change', ...closes('gh#70') }),
      /* Closed by a pull request the epic does not name, and by one nobody holds. */
      ghRow(6, { links: [{ ref: 'gh#90', relation: 'closed-by' }] }),
      ghRow(8, { kind: 'change', ...closes('gh#6') }),
    ]
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => rows) }, now: () => NOW })
    await trackers.refresh(folder, { project: true }, 'press')
    const live = trackers.live(folder, 'one')!
    expect(live.ghLinks).toEqual({ 'gh:Jalez/kehikko#2': [3], 'gh#70': [5], 'gh#6': [90, 8] })
    expect(live.links).toEqual({})
  })

  test('GitLab: under the issue’s number, and a merge request that declares nothing folds nowhere', async () => {
    const glRemotes = runner([['git -C', ok('origin\thttps://gitlab.example.org/group/project.git (fetch)')]])
    const glRow = (kind: 'issue' | 'change', number: number, over: Partial<TrackerRow> = {}): TrackerRow => ({
      ...ghRow(number),
      ref: `${kind === 'change' ? '!' : '#'}${number}`,
      tracker: 'gitlab',
      host: 'gitlab.example.org',
      repo: 'group/project',
      kind,
      ...over,
    })
    epicFile({ steps: [{ title: 's', refs: ['#2252', '!3053', '!3058', '!3070'] }] })
    const rows = [
      glRow('issue', 2252),
      glRow('change', 3053, closes('#2252')),
      glRow('change', 3058, closes('#2252')),
      glRow('change', 3070),
    ]
    const trackers = new Trackers({ run: glRemotes, adapters: { gitlab: fake(() => rows) }, now: () => NOW })
    await trackers.refresh(folder, { epic: 'one' }, 'press')
    const live = trackers.live(folder, 'one')!
    expect(live.links).toEqual({ '2252': [3053, 3058] })
    expect(live.ghLinks).toEqual({})
    expect(Object.keys(live.mrs as object).sort()).toEqual(['3053', '3058', '3070'])
  })

  test('and the answer merges them with the links a state file already had', async () => {
    epicFile({ steps: [{ title: 's', refs: ['gh#2', 'gh#3'] }] })
    mkdirSync(join(folder, '.kehikot', 'host', 'state'), { recursive: true })
    writeFileSync(
      join(folder, '.kehikot', 'host', 'state', 'one.json'),
      JSON.stringify({
        generated: '2026-10-01T00:00:00.000Z',
        ghIssues: {},
        ghPrs: {},
        ghLinks: { 'gh#2': [1, 3], 'gh#4': [9] },
        ghPartOf: { 'gh#2': [11] },
        links: { '12': [7] },
      }),
    )
    const rows = [ghRow(2), ghRow(3, { kind: 'change', ...closes('gh#2') }), ghRow(20, { kind: 'change', ...closes('gh#2') })]
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => rows) }, now: () => NOW })
    await trackers.refresh(folder, { project: true }, 'press')
    const given = answer('example.notes', 'live.get', { epic: 'one' }, known, undefined, folder, undefined, trackers)
    if (!given.ok) throw new Error(given.error)
    const live = given.data as Record<string, unknown>
    expect(live.ghLinks).toEqual({ 'gh#2': [1, 3, 20], 'gh#4': [9] })
    expect(live.links).toEqual({ '12': [7] })
    expect(live.ghPartOf).toEqual({ 'gh#2': [11] })
  })
})

describe('the methods, answered', () => {
  const known = () => true
  test('tracker.get is answered from the reading, in the protocol’s shape', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(1)]) }, now: () => NOW })
    await trackers.refresh(folder, { project: true }, 'press')
    const given = answer('example.notes', 'tracker.get', { refs: ['gh#1'] }, known, undefined, folder, undefined, trackers)
    expect(given.ok).toBe(true)
    if (given.ok) expect(methodResults['tracker.get']!.parse(given.data).rows[0].ref).toBe('gh#1')
    const refused = answer('example.notes', 'tracker.get', { refs: ['gh#1'], project: true }, known, undefined, folder, undefined, trackers)
    expect(refused.ok).toBe(false)
    const nowhere = answer('example.notes', 'tracker.get', { project: true }, known, undefined, null, undefined, trackers)
    expect(nowhere.ok).toBe(false)
  })

  test('tracker.refresh reads nothing for a module: it is declined with the reason (Jalez/kehikko#384)', async () => {
    const adapter = fake(() => [ghRow(1)])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    const given = await answerCall('example.notes', 'tracker.refresh', { project: true }, known, () => {}, folder, () => ({ ok: false, why: '' }), trackers)
    expect(given.ok && (given.data as { outcome: string; why: string })).toMatchObject({ outcome: 'declined', why: expect.stringContaining('Refresh all') })
    expect(adapter.reads).toBe(0)
    const elsewhere = await answerCall('example.notes', 'tracker.refresh', { project: true }, known, () => {}, null, () => ({ ok: false, why: '' }), trackers)
    expect(elsewhere.ok && (elsewhere.data as { outcome: string }).outcome).toBe('declined')
  })

  test('the signal reaches every module in the context, and nothing else of the reading does', () => {
    const told = toWireContext({ epic: null, project: { id: 1, name: 'p', path: folder } } as never, 'light', [], null, null, [], [], {
      at: NOW.toISOString(),
      refreshing: true,
    })
    expect(told.tracker).toEqual({ at: NOW.toISOString(), refreshing: true })
  })
})

describe('live.get from the shared reading alone', () => {
  const EPIC = { slug: 'one', title: 'One', umbrella: 'gh#9', steps: [{ title: 's', refs: ['gh#1'] }] }
  const put = (folder: string, epic: object) => {
    mkdirSync(join(folder, '.kehikot', 'host', 'epics'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'host', 'epics', 'one.json'), JSON.stringify(epic))
  }

  test('a landed read with nothing live for the epic is an empty reading, not a refusal; unread is null', async () => {
    put(folder, { slug: 'one', title: 'One', steps: [] })
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => []) }, now: () => NOW })
    expect(trackers.live(folder, 'one')).toBeNull()
    await trackers.refresh(folder, { project: true }, 'press')
    const live = trackers.live(folder, 'one')!
    expect(live.generated).toBe(NOW.toISOString())
    expect(live.ghIssues).toEqual({})
    expect(live.issues).toEqual({})
  })

  test('answered through live.get: no state file and a landed read is an empty reading; no read is the refusal', async () => {
    put(folder, { slug: 'one', title: 'One', steps: [] })
    const known = () => true
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => []) }, now: () => NOW })
    const before = answer('example.notes', 'live.get', { epic: 'one' }, known, undefined, folder, undefined, trackers)
    expect(before.ok).toBe(false)
    await trackers.refresh(folder, { project: true }, 'press')
    const after = answer('example.notes', 'live.get', { epic: 'one' }, known, undefined, folder, undefined, trackers)
    if (!after.ok) throw new Error(after.error)
    expect((after.data as Record<string, unknown>).generated).toBe(NOW.toISOString())
  })

  test('an epic whose refs were never read stays a refusal', async () => {
    put(folder, EPIC)
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => []) }, now: () => NOW })
    expect(trackers.live(folder, 'one')).toBeNull()
  })
})
