import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methodResults, trackerReadingResult, type TrackerRow, type TrackerSignal } from 'roadmap-module-protocol'
import { dispositionOf, facetsOf } from 'roadmap-module-protocol/facets'

import { answer, answerCall } from '../server/answers.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import type { Adapter, Wanted } from '../server/trackers/common.ts'
import { githubAdapter } from '../server/trackers/github.ts'
import { declaredIssues, gitlabAdapter } from '../server/trackers/gitlab.ts'
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
    mkdirSync(join(folder, '.kehikot', 'kehikko'), { recursive: true })
    writeFileSync(
      join(folder, '.kehikot', 'kehikko', 'trackers.json'),
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
    mkdirSync(join(folder, '.kehikot', 'kehikko'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'kehikko', 'trackers.json'), '{"version": 1, "sources": [{"tracker": "jira", "repo": "x/y"}]}')
    const read = readConfig(folder)
    expect(read.ok).toBe(false)
  })
})

describe('GitHub through gh', () => {
  const issues = [
    { number: 1, state: 'CLOSED', stateReason: 'NOT_PLANNED', title: 'Never', url: 'u1', labels: [{ name: 'bug' }], assignees: [], author: { login: 'a' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: '2026-01-02T00:00:00Z' },
    { number: 2, state: 'CLOSED', stateReason: '', title: 'Done by a PR', url: 'u2', labels: [], assignees: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: '2026-01-02T00:00:00Z' },
  ]
  const prs = [
    { number: 3, state: 'MERGED', title: 'Fix', url: 'u3', labels: [], assignees: [], author: { login: 'b', name: 'Bee' }, isDraft: false, reviewDecision: 'APPROVED', closingIssuesReferences: [{ number: 2 }], statusCheckRollup: [{ conclusion: 'SUCCESS' }], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', closedAt: '2026-01-02T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z' },
  ]

  test('a listing is rows the facets read as they are', async () => {
    const run = runner([['gh issue list', ok(issues)], ['gh pr list', ok(prs)]])
    const read = await githubAdapter(run).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    const [never, done, fix] = read.rows as [TrackerRow, TrackerRow, TrackerRow]
    expect(never.stateReason).toBe('NOT_PLANNED')
    expect(facetsOf(never)).toEqual(['issue:closed', 'closed:wont-do'])
    expect(dispositionOf(never.ref, never, []).source).toBe('tracker')
    expect(done.links).toEqual([{ ref: 'gh#3', relation: 'closed-by' }])
    expect(done.closedByMerge).toBe(true)
    expect('stateReason' in done).toBe(false)
    expect(fix).toMatchObject({ ref: 'gh#3', kind: 'change', state: 'merged', pipeline: 'success', review: 'approved', author: 'Bee' })
    expect(run.asked[0]).toContain('--repo')
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
    const run = runner([['gh issue list', { code: 4, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login' }], ['gh pr list', ok([])]])
    const read = await githubAdapter(run).list(gh, 400, NOW.toISOString())
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.why).toContain('gh auth login')
  })
})

describe('GitLab through glab', () => {
  test('a merge request delivers what its own description declares', () => {
    expect(declaredIssues('Closes #12 and #13. Part of #2274; mentions #99 in passing')).toEqual([12, 13, 2274])
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
  test('a ref nobody has read is pending, a read starts, and the module is told when it lands', async () => {
    const told: TrackerSignal[] = []
    const adapter = fake(() => [ghRow(41, { state: 'closed', stateReason: 'COMPLETED' })])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, told: (_root, signal) => told.push(signal), now: () => NOW })
    const first = trackers.get(folder, { refs: ['gh#41'] })
    if ('refused' in first) throw new Error(first.refused)
    expect(first.missing).toEqual([{ ref: 'gh#41', reason: 'pending' }])
    await settle()
    expect(told.at(-1)).toEqual({ at: NOW.toISOString(), refreshing: false })
    const second = trackers.get(folder, { refs: ['gh#41'] })
    if ('refused' in second) throw new Error(second.refused)
    expect(trackerReadingResult.safeParse(second).success).toBe(true)
    expect(second.rows.map((r) => [r.ref, r.state, r.stateReason])).toEqual([['gh#41', 'closed', 'COMPLETED']])
    expect(second.sources[0]).toMatchObject({ repo: 'Jalez/kehikko', default: true, at: NOW.toISOString(), error: null })
  })

  test('a row answers to the spelling it was asked by', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(41)]) }, now: () => NOW })
    await trackers.refresh(folder, { refs: ['gh:Jalez/kehikko#41'] })
    const got = trackers.get(folder, { refs: ['gh#41', 'gh:Jalez/kehikko#41'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.map((r) => r.ref)).toEqual(['gh#41', 'gh:Jalez/kehikko#41'])
  })

  test('it is kept under .kehikot/kehikko/, with an ignore line beside it', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(1)]) }, now: () => NOW })
    await trackers.refresh(folder, { project: true })
    expect(readingFile(folder)).toBe(join(folder, '.kehikot', 'kehikko', 'tracker-reading.json'))
    expect(existsSync(readingFile(folder)!)).toBe(true)
    expect(readFileSync(join(folder, '.kehikot', 'kehikko', '.gitignore'), 'utf8')).toContain('tracker-reading.json')
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
    expect((await trackers.refresh(folder, { project: true })).outcome).toBe('read')
    down = true
    const failed = await trackers.refresh(folder, { project: true })
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
    const [a, b] = await Promise.all([trackers.refresh(folder, { project: true }), trackers.refresh(folder, { project: true })])
    expect(a).toEqual(b)
    expect(adapter.reads).toBe(1)
  })

  test('a ref the tracker will not answer for is not-found after one read, not asked forever', async () => {
    const adapter = fake(() => [])
    const trackers = new Trackers({ run: remotes, adapters: { github: adapter }, now: () => NOW })
    trackers.get(folder, { refs: ['gh#404'] })
    await settle()
    const reads = adapter.reads
    const got = trackers.get(folder, { refs: ['gh#404'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.missing).toEqual([{ ref: 'gh#404', reason: 'not-found' }])
    await settle()
    expect(adapter.reads).toBe(reads)
  })

  test('a spelling for a tracker the project does not read is no-tracker', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => []) }, now: () => NOW })
    await trackers.refresh(folder, { project: true })
    const got = trackers.get(folder, { refs: ['#12', 'nonsense'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.missing).toEqual([{ ref: '#12', reason: 'no-tracker' }, { ref: 'nonsense', reason: 'no-tracker' }])
  })

  test('detail is read when asked for by refs, and kept', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(5)]) }, now: () => NOW })
    await trackers.refresh(folder, { refs: ['gh#5'] })
    const first = trackers.get(folder, { refs: ['gh#5'] }, 'detail')
    if ('refused' in first) throw new Error(first.refused)
    expect(first.rows[0]!.detail).toBeUndefined()
    await settle()
    const second = trackers.get(folder, { refs: ['gh#5'] }, 'detail')
    if ('refused' in second) throw new Error(second.refused)
    expect(second.rows[0]!.detail?.body).toBe('body of gh#5')
    const summary = trackers.get(folder, { refs: ['gh#5'] })
    if ('refused' in summary) throw new Error(summary.refused)
    expect(summary.rows[0]!.detail).toBeUndefined()
  })

  test('an epic’s refs, and live.get’s four bags over the same reading', async () => {
    mkdirSync(join(folder, '.kehikot', 'roadmap', 'epics'), { recursive: true })
    const epic = { slug: 'one', title: 'One', umbrella: 'gh#9', steps: [{ title: 's', refs: ['gh#1', 'gh#3', 'not a ref'] }] }
    writeFileSync(join(folder, '.kehikot', 'roadmap', 'epics', 'one.json'), JSON.stringify(epic))
    expect(refsInEpic(epic).sort()).toEqual(['gh#1', 'gh#3', 'gh#9'])
    const trackers = new Trackers({
      run: remotes,
      adapters: { github: fake(() => [ghRow(1), ghRow(3, { kind: 'change', state: 'merged' }), ghRow(9)]) },
      now: () => NOW,
    })
    await trackers.refresh(folder, { epic: 'one' })
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

describe('the methods, answered', () => {
  const known = () => true
  test('tracker.get is answered from the reading, in the protocol’s shape', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(1)]) }, now: () => NOW })
    await trackers.refresh(folder, { project: true })
    const given = answer('example.notes', 'tracker.get', { refs: ['gh#1'] }, known, undefined, folder, undefined, trackers)
    expect(given.ok).toBe(true)
    if (given.ok) expect(methodResults['tracker.get']!.parse(given.data).rows[0].ref).toBe('gh#1')
    const refused = answer('example.notes', 'tracker.get', { refs: ['gh#1'], project: true }, known, undefined, folder, undefined, trackers)
    expect(refused.ok).toBe(false)
    const nowhere = answer('example.notes', 'tracker.get', { project: true }, known, undefined, null, undefined, trackers)
    expect(nowhere.ok).toBe(false)
  })

  test('tracker.refresh answers when the read lands', async () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake(() => [ghRow(1)]) }, now: () => NOW })
    const given = await answerCall('example.notes', 'tracker.refresh', { project: true }, known, () => {}, folder, () => ({ ok: false, why: '' }), trackers)
    expect(given).toEqual({ ok: true, data: { outcome: 'read', at: NOW.toISOString(), why: '' } })
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
