import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_ASK_PATH, SERVER_PASS_PATH, serverAskResult, trackerReadingResult, type TrackerRow } from 'kehikot-module-protocol'
import { writeHoldings } from 'kehikot-module-protocol/serve'

import { answer } from '../server/answers.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import { editParts } from '../server/holdings.ts'
import { serverAskDesk, SERVER_ASK_SAYS, type ServerAskDeps } from '../server/serverAsk.ts'
import type { Adapter, Wanted } from '../server/trackers/common.ts'
import { branchUrl as githubBranchUrl, githubAdapter, linkedBranchesOf, listQuery, refsQuery as githubRefsQuery } from '../server/trackers/github.ts'
import { branchesOn, gitlabAdapter, relatedBranches } from '../server/trackers/gitlab.ts'
import { Trackers } from '../server/trackers/reading.ts'
import type { Source } from '../server/trackers/sources.ts'

/**
 * Protocol 2.19.0, what the Kanban module found missing: a module's SERVER reads the tracker
 * (`/host/server-ask`), `tracker.get { epic, parts: true }`, and an issue's linked branches.
 * Real folders for the reading, fake CLIs for the trackers: nothing here reaches a forge.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-server-ask-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const NOW = new Date('2026-10-24T12:00:00.000Z')
const ok = (out: unknown, code = 0): Ran => ({ code, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' })
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }

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

const remotes = runner([['git -C', ok('origin\thttps://github.com/Jalez/kehikko.git (fetch)\norigin\thttps://github.com/Jalez/kehikko.git (push)')]])

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

/** An adapter that answers from rows it was given, and counts its reads. */
function fake(rows: TrackerRow[]): Adapter & { reads: number } {
  const adapter = {
    reads: 0,
    async list(source: Source) {
      adapter.reads += 1
      return { ok: true as const, rows: rows.filter((r) => r.repo === source.repo), notFound: [] }
    },
    async refs(source: Source, wanted: readonly Wanted[]) {
      adapter.reads += 1
      return { ok: true as const, rows: rows.filter((r) => r.repo === source.repo && wanted.some((w) => w.number === r.number)), notFound: [] }
    },
    async detail() {
      return new Map()
    },
  }
  return adapter
}

/** An epic `one` naming gh#1, with a part `ui` that another module filed gh#2 under. */
function epicWithParts(): void {
  mkdirSync(join(folder, '.kehikot', 'host', 'epics'), { recursive: true })
  writeFileSync(join(folder, '.kehikot', 'host', 'epics', 'one.json'), JSON.stringify({ slug: 'one', title: 'One', steps: [{ title: 's', refs: ['gh#1'] }] }))
  const added = editParts(folder, 'one', { add: { name: 'UI' } })
  writeHoldings(folder, 'kehikot.journeys', 'one', { [added.result.id!]: { documents: [], refs: ['gh#2'] } })
}

const settle = () => new Promise((r) => setTimeout(r, 60))

describe('tracker.get { epic, parts: true }', () => {
  test('answers the epic’s refs and its parts’ in one answer', async () => {
    epicWithParts()
    const trackers = new Trackers({ run: remotes, adapters: { github: fake([ghRow(1), ghRow(2), ghRow(3)]) }, now: () => NOW })
    const known = () => true
    /* Asked once with parts, the part's ref is pending and read like any ref asked for. */
    const first = answer('kehikot.kanban', 'tracker.get', { epic: 'one', parts: true }, known, undefined, folder, undefined, trackers)
    expect(first.ok).toBe(true)
    await settle()
    const own = answer('kehikot.kanban', 'tracker.get', { epic: 'one' }, known, undefined, folder, undefined, trackers)
    const both = answer('kehikot.kanban', 'tracker.get', { epic: 'one', parts: true }, known, undefined, folder, undefined, trackers)
    if (!own.ok || !both.ok) throw new Error('not answered')
    expect(trackerReadingResult.parse(own.data).rows.map((r) => r.ref)).toEqual(['gh#1'])
    expect(trackerReadingResult.parse(both.data).rows.map((r) => r.ref).sort()).toEqual(['gh#1', 'gh#2'])
  })

  test('parts without an epic is refused, as the protocol says', () => {
    const trackers = new Trackers({ run: remotes, adapters: { github: fake([]) }, now: () => NOW })
    const refused = answer('kehikot.kanban', 'tracker.get', { refs: ['gh#1'], parts: true }, () => true, undefined, folder, undefined, trackers)
    expect(refused.ok).toBe(false)
  })
})

describe('linked branches on GitHub', () => {
  test('are asked in the same query as the issue, never in one of their own', () => {
    expect(githubRefsQuery(gh, [1, 2])).toContain('linkedBranches(first: 10)')
    expect(listQuery(gh, { issues: null, pulls: null })).toContain('linkedBranches(first: 10)')
    expect(githubRefsQuery(gh, [1], true, false)).not.toContain('linkedBranches')
  })

  test('each branch with its page, in another repository too', () => {
    expect(
      linkedBranchesOf({
        nodes: [
          { ref: { name: '12-fix/the thing', repository: { url: 'https://github.com/Jalez/kehikko' } } },
          { ref: { name: 'elsewhere', repository: { url: 'https://github.com/someone/fork' } } },
          { ref: { name: '', repository: { url: 'https://github.com/x/y' } } },
          { ref: { name: 'no-link', repository: { url: 'http://insecure.example/x/y' } } },
        ],
      }),
    ).toEqual([
      { name: '12-fix/the thing', url: 'https://github.com/Jalez/kehikko/tree/12-fix/the%20thing' },
      { name: 'elsewhere', url: 'https://github.com/someone/fork/tree/elsewhere' },
      { name: 'no-link' },
    ])
    expect(githubBranchUrl('https://github.com/a/b/', 'x')).toBe('https://github.com/a/b/tree/x')
  })

  const issue = {
    number: 12, state: 'OPEN', title: 'Linked', url: 'u12', labels: { nodes: [] }, assignees: { nodes: [] },
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
  }

  test('an issue read with them carries them; one with none carries an empty list', async () => {
    const run = runner([['gh api graphql', ok({ data: { repository: {
      n12: { __typename: 'Issue', ...issue, linkedBranches: { nodes: [{ ref: { name: '12-linked', repository: { url: 'https://github.com/Jalez/kehikko' } } }] } },
      n13: { __typename: 'Issue', ...issue, number: 13, linkedBranches: { nodes: [] } },
    } } })]])
    const read = await githubAdapter(run).refs(gh, [{ number: 12, kind: null }, { number: 13, kind: null }], NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows.map((r) => [r.ref, r.branches])).toEqual([
      ['gh#12', [{ name: '12-linked', url: 'https://github.com/Jalez/kehikko/tree/12-linked' }]],
      ['gh#13', []],
    ])
    expect(run.asked).toHaveLength(1)
  })

  test('an Enterprise Server without the field is asked again without it, and not again for a while', async () => {
    let calls = 0
    const run = runner([['gh api graphql', (argv) => {
      calls += 1
      const query = argv.find((a) => a.startsWith('query=')) ?? ''
      if (query.includes('linkedBranches')) return ok({ errors: [{ message: "Field 'linkedBranches' doesn't exist on type 'Issue'" }] }, 1)
      return ok({ data: { repository: { n12: { __typename: 'Issue', ...issue } } } })
    }]])
    const ghe: Source = { ...gh, host: 'github.example.org' }
    const adapter = githubAdapter(run, () => NOW.getTime())
    const first = await adapter.refs(ghe, [{ number: 12, kind: null }], NOW.toISOString())
    if (!first.ok) throw new Error(first.why)
    /* Not read is not none: absent. */
    expect('branches' in first.rows[0]!).toBe(false)
    const before = calls
    await adapter.refs(ghe, [{ number: 12, kind: null }], NOW.toISOString())
    expect(calls - before).toBe(1)
  })
})

describe('related branches on GitLab', () => {
  test('are the project’s branches named <iid>-…, never a stable branch', () => {
    const names = ['12-fix-it', '12-0-stable', '120-other', 'feat/12-x', '12-Second', 'main', '1-one']
    expect(relatedBranches(12, names)).toEqual(['12-fix-it', '12-Second'])
    expect(relatedBranches(1, names)).toEqual(['1-one'])
  })

  test('an issue gets them with its links; a change is left alone', () => {
    const row = { ...ghRow(12), tracker: 'gitlab' as const, host: 'gitlab.example.org', repo: 'group/project', ref: '#12' }
    expect(branchesOn(row, ['12-fix/a b']).branches).toEqual([{ name: '12-fix/a b', url: 'https://gitlab.example.org/group/project/-/tree/12-fix/a%20b' }])
    expect(branchesOn(row, ['main']).branches).toEqual([])
    expect('branches' in branchesOn({ ...row, kind: 'change' }, ['12-x'])).toBe(false)
  })

  test('the names are one listing per source on a whole read; a read by name uses the names held', async () => {
    const issueAt = (iid: number) => ({ iid, state: 'opened', title: `t${iid}`, web_url: `w${iid}`, labels: [], assignees: [] })
    const run = runner([
      ['git -C', ok('origin\thttps://gitlab.example.org/group/project.git (fetch)')],
      ['glab api --hostname gitlab.example.org projects/group%2Fproject/issues', ok([issueAt(12), issueAt(13)])],
      ['glab api --hostname gitlab.example.org projects/group%2Fproject/merge_requests', ok([])],
      ['glab api --hostname gitlab.example.org projects/group%2Fproject/boards', ok([])],
      ['glab api --hostname gitlab.example.org projects/group%2Fproject/repository/branches', ok([{ name: 'main' }, { name: '12-started' }])],
      ['glab api --hostname gitlab.example.org graphql', ok({ data: { project: { issues: { nodes: [
        { iid: '12', state: 'opened', title: 't12', webUrl: 'w12' },
        { iid: '13', state: 'opened', title: 't13', webUrl: 'w13' },
      ] } } } })],
    ])
    const trackers = new Trackers({ run, adapters: { gitlab: gitlabAdapter(run) }, now: () => NOW })
    /* Before any whole read: nobody listed the branches, so nothing is said. */
    await trackers.refresh(folder, { refs: ['#12'] })
    const before = trackers.get(folder, { refs: ['#12'] })
    if ('refused' in before) throw new Error(before.refused)
    expect('branches' in before.rows[0]!).toBe(false)

    await trackers.refresh(folder, { project: true })
    const listings = run.asked.filter((argv) => argv.join(' ').includes('repository/branches'))
    expect(listings).toHaveLength(1)
    const after = trackers.get(folder, { refs: ['#12', '#13'] })
    if ('refused' in after) throw new Error(after.refused)
    expect(after.rows.map((r) => [r.ref, r.branches?.map((b) => b.name)])).toEqual([
      ['#12', ['12-started']],
      ['#13', []],
    ])

    /* A read by name between whole reads asks no branches, and keeps the held names. */
    await trackers.refresh(folder, { refs: ['#12'] })
    expect(run.asked.filter((argv) => argv.join(' ').includes('repository/branches'))).toHaveLength(1)
    const again = trackers.get(folder, { refs: ['#12'] })
    if ('refused' in again) throw new Error(again.refused)
    expect(again.rows[0]!.branches?.map((b) => b.name)).toEqual(['12-started'])
  })
})

describe('a module’s server asks the host: /host/server-ask', () => {
  const PASS = 'p'.repeat(40)
  const ORIGIN = 'http://127.0.0.1:8060'
  const READING = { at: NOW.toISOString(), refreshing: false, sources: [], rows: [ghRow(1)], missing: [] }

  /** A host's desk over one registered module, `kehikot.kanban`, which minted PASS and declares what it is given. */
  function desk(over: Partial<ServerAskDeps> & { uses?: string[] } = {}) {
    const vouches: string[] = []
    const answered: unknown[] = []
    const deps: ServerAskDeps = {
      known: (id) => id === 'kehikot.kanban',
      originOf: async (id) => (id === 'kehikot.kanban' ? ORIGIN : null),
      may: (_module, capability) => (over.uses ?? ['trackers:read']).includes(capability),
      projectAt: (path) => (path === folder ? folder : null),
      answer: (module, method, params, root) => {
        answered.push({ module, method, params, root })
        return { ok: true, data: READING }
      },
      fetch: (async (url: string | URL | Request) => {
        vouches.push(String(url))
        const pass = new URL(String(url)).searchParams.get('pass')
        return Response.json({ ok: true, minted: pass === PASS })
      }) as typeof fetch,
      ...over,
    }
    return { route: serverAskDesk(deps).route, vouches, answered }
  }

  const ask = async (route: ReturnType<typeof desk>['route'], body: unknown) => {
    const request = new Request(`http://127.0.0.1:4170${SERVER_ASK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const response = await route(request, new URL(request.url))
    return { status: response!.status, body: (await response!.json()) as Record<string, unknown> }
  }
  const question = (over: Record<string, unknown> = {}) => ({ module: 'kehikot.kanban', pass: PASS, project: folder, method: 'tracker.get', params: { epic: 'one', parts: true }, ...over })

  test('answers the reading a page would get, after the module vouched for the pass at its registered origin', async () => {
    const { route, vouches, answered } = desk()
    const said = await ask(route, question())
    expect(said.status).toBe(200)
    expect(serverAskResult.parse(said.body)).toEqual({ ok: true, data: READING })
    expect(vouches).toEqual([`${ORIGIN}${SERVER_PASS_PATH}?pass=${PASS}`])
    expect(answered).toEqual([{ module: 'kehikot.kanban', method: 'tracker.get', params: { epic: 'one', parts: true }, root: folder }])
  })

  test('a module not registered here is not asked about', async () => {
    const { route, vouches } = desk()
    const said = await ask(route, question({ module: 'kehikot.other' }))
    expect(said.body).toEqual({ ok: false, reason: 'unknown-module', error: SERVER_ASK_SAYS.module, refused: 'module' })
    expect(vouches).toEqual([])
  })

  test('a program that only names the module gets nothing: the module did not mint its pass', async () => {
    const { route, answered } = desk()
    const said = await ask(route, question({ pass: 'q'.repeat(40) }))
    expect(said.body).toMatchObject({ ok: false, refused: 'pass' })
    expect(answered).toEqual([])
  })

  test('a module not answering at its origin is not vouched for', async () => {
    const { route } = desk({ fetch: (async () => { throw new Error('refused') }) as unknown as typeof fetch })
    expect((await ask(route, question())).body).toMatchObject({ ok: false, refused: 'pass' })
  })

  test('a module that did not declare trackers:read gets nothing, in the grant’s own sentence', async () => {
    const { route, answered } = desk({ uses: [] })
    const said = await ask(route, question())
    expect(said.body).toMatchObject({ ok: false, refused: 'grant' })
    expect(String(said.body.error)).toContain('trackers:read')
    expect(answered).toEqual([])
  })

  test('a folder that is not a project here is refused', async () => {
    const { route } = desk()
    expect((await ask(route, question({ project: '/nowhere/at/all' }))).body).toEqual({ ok: false, reason: 'failed', error: SERVER_ASK_SAYS.project, refused: 'project' })
  })

  test('only a server method, and only a well-formed question', async () => {
    const { route } = desk()
    expect((await ask(route, question({ method: 'parts.set' }))).status).toBe(400)
    expect((await ask(route, question({ project: 'relative' }))).status).toBe(400)
    expect((await ask(route, { nothing: true })).status).toBe(400)
  })

  test('through the page’s own answer: the same reading, the same refusals', async () => {
    epicWithParts()
    const trackers = new Trackers({ run: remotes, adapters: { github: fake([ghRow(1), ghRow(2)]) }, now: () => NOW })
    await trackers.refresh(folder, { refs: ['gh#1', 'gh#2'] })
    const { route } = desk({
      answer: (module, method, params, root) => answer(module, method, params, () => true, () => {}, root, undefined, trackers, null, null, { may: () => true }),
    })
    const said = await ask(route, question())
    const parsed = serverAskResult.parse(said.body)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(trackerReadingResult.parse(parsed.data).rows.map((r) => r.ref).sort()).toEqual(['gh#1', 'gh#2'])
    const bad = serverAskResult.parse((await ask(route, question({ params: { refs: ['gh#1'], parts: true } }))).body)
    expect(bad.ok).toBe(false)
  })
})
