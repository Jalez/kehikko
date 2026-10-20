import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackerColumnsResult, trackerReadingResult, type TrackerRow } from 'kehikot-module-protocol'

import { answer } from '../server/answers.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import { githubAdapter, NEEDS_PROJECT_SCOPE, SCOPE_RECHECK_MS } from '../server/trackers/github.ts'
import { gitlabAdapter } from '../server/trackers/gitlab.ts'
import { Trackers } from '../server/trackers/reading.ts'
import type { Source } from '../server/trackers/sources.ts'
import { listingText } from '../src/host/trackerSources.ts'

/**
 * Board columns: where each issue and change stands on the project's own
 * board — a GitHub Project (v2) or a GitLab issue board. The tracker answers
 * are recorded in `fixtures/board-columns/` in the shapes GitHub and GitLab
 * give them (the no-scope refusal is GitHub's own, word for word); nothing
 * here reaches either.
 */

const FIXTURES = join(import.meta.dir, 'fixtures', 'board-columns')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-boards-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const NOW = new Date('2026-10-21T12:00:00.000Z')
const ok = (out: unknown, code = 0): Ran => ({ code, out: JSON.stringify(out), err: '' })
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }

function runner(answer: (argv: string[]) => Ran): Runner & { asked: string[][] } {
  const asked: string[][] = []
  const run = (async (argv: string[]) => {
    asked.push(argv)
    return answer(argv)
  }) as Runner & { asked: string[][] }
  run.asked = asked
  return run
}

const queryOf = (argv: string[]) => argv.find((a) => a.startsWith('query=')) ?? ''
const byRef = (rows: readonly TrackerRow[]) => new Map(rows.map((r) => [r.ref, r]))

/** GitHub as a token WITH `read:project` answers. */
const withScope = () => runner(() => ok(fixture('github-with-scope')))
/** GitHub as a token WITHOUT it answers: the query with project fields refused whole, the one without answered. */
const withoutScope = () =>
  runner((argv) =>
    queryOf(argv).includes('projectItems') ? ok(fixture('github-no-scope'), 1) : ok(fixture('github-without-boards')),
  )

describe('GitHub Projects, with read:project', () => {
  test('the listing carries each item’s column in the same query', async () => {
    const run = withScope()
    const read = await githubAdapter(run).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(run.asked).toHaveLength(1)
    expect(queryOf(run.asked[0]!)).toContain('projectItems')
    expect(queryOf(run.asked[0]!)).toContain('fieldValueByName(name: "Status")')
    const rows = byRef(read.rows)
    expect(rows.get('gh#45')!.column).toEqual({ name: 'Done', board: 'Roadmap', boardUrl: 'https://github.com/users/Jalez/projects/3' })
    expect('columns' in rows.get('gh#45')!).toBe(false)
    for (const row of read.rows) expect(trackerReadingResult.safeParse({ rows: [row] }).success).toBe(true)
  })

  test('an item on several boards has every column, the first as column', async () => {
    const read = await githubAdapter(withScope()).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    const many = byRef(read.rows).get('gh#41')!
    expect(many.column).toEqual({ name: 'In progress', board: 'Roadmap', boardUrl: 'https://github.com/users/Jalez/projects/3' })
    /* Bugs has no Status field: its column is the first single-select field the item has. */
    expect(many.columns).toEqual([many.column!, { name: 'Triage', board: 'Bugs', boardUrl: 'https://github.com/users/Jalez/projects/5' }])
  })

  test('no Status value, no board, an archived item and a closed project are no column', async () => {
    const read = await githubAdapter(withScope()).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    const rows = byRef(read.rows)
    for (const ref of ['gh#42', 'gh#43', 'gh#44']) {
      expect('column' in rows.get(ref)!).toBe(false)
      expect('columns' in rows.get(ref)!).toBe(false)
    }
  })

  test('the read hands back the boards it saw, with their columns in order', async () => {
    const read = await githubAdapter(withScope()).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.boards).toEqual({
      boards: [
        { board: 'Roadmap', boardUrl: 'https://github.com/users/Jalez/projects/3', columns: ['Todo', 'In progress', 'Done'] },
        { board: 'Bugs', boardUrl: 'https://github.com/users/Jalez/projects/5', columns: ['Triage', 'Fixing'] },
      ],
    })
  })

  test('refs read by name carry their columns too', async () => {
    const answerFor = fixture('github-with-scope') as { data: { repository: { issues: { nodes: unknown[] } } } }
    const issue41 = answerFor.data.repository.issues.nodes[0] as Record<string, unknown>
    const run = runner(() => ok({ data: { repository: { n41: { __typename: 'Issue', ...issue41 } } } }))
    const read = await githubAdapter(run).refs(gh, [{ number: 41, kind: null }], NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(queryOf(run.asked[0]!)).toContain('projectItems')
    expect(read.rows[0]!.column?.name).toBe('In progress')
    expect(read.rows[0]!.columns).toHaveLength(2)
  })
})

describe('GitHub Projects, without read:project', () => {
  test('the reading is not failed: asked again without boards, no column, and the reason once', async () => {
    const run = withoutScope()
    const read = await githubAdapter(run).list(gh, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(run.asked).toHaveLength(2)
    expect(queryOf(run.asked[1]!)).not.toContain('projectItems')
    expect(read.rows.map((r) => r.ref).sort()).toEqual(['gh#41', 'gh#42', 'gh#43', 'gh#44', 'gh#45'])
    for (const row of read.rows) expect('column' in row).toBe(false)
    expect(read.boards).toEqual({ unreadable: NEEDS_PROJECT_SCOPE })
    expect(NEEDS_PROJECT_SCOPE).toBe('Board columns need `gh auth refresh -s read:project`.')
  })

  test('the refusal is remembered for a while, so a read does not pay it every time', async () => {
    let now = NOW.getTime()
    const run = withoutScope()
    const adapter = githubAdapter(run, () => now)
    await adapter.list(gh, 400, NOW.toISOString())
    await adapter.list(gh, 400, NOW.toISOString())
    expect(run.asked).toHaveLength(3)
    expect(queryOf(run.asked[2]!)).not.toContain('projectItems')
    now += SCOPE_RECHECK_MS
    await adapter.list(gh, 400, NOW.toISOString())
    expect(queryOf(run.asked[3]!)).toContain('projectItems')
  })

  test('the tracker sources panel says so once, and the read still lands', async () => {
    const sync = runner((argv) => {
      if (argv[0] === 'git') return { code: 0, out: 'origin\thttps://github.com/Jalez/kehikko.git (fetch)', err: '' }
      return queryOf(argv).includes('projectItems') ? ok(fixture('github-no-scope'), 1) : ok(fixture('github-without-boards'))
    })
    const trackers = new Trackers({ run: sync, now: () => NOW })
    const result = await trackers.refresh(folder, { project: true })
    expect(result.outcome).toBe('read')
    const listing = trackers.listing(folder, [{ name: 'origin', url: 'https://github.com/Jalez/kehikko.git' }])
    expect(listing.boardsNote).toBe(NEEDS_PROJECT_SCOPE)
    expect(listing.sources[0]!.error).toBeNull()
    expect(listing.sources[0]!.boards).toEqual([])
    expect(listingText(listing, NOW.getTime()).split(NEEDS_PROJECT_SCOPE)).toHaveLength(2)
    expect(trackers.columns(folder)).toEqual({ boards: [] })
  })
})

describe('GitLab boards', () => {
  const glab = () =>
    runner((argv) => {
      const line = argv.join(' ')
      if (argv[0] === 'git') return { code: 0, out: 'origin\thttps://gitlab.example.org/group/project.git (fetch)', err: '' }
      if (line.includes('/boards')) return ok(fixture('gitlab-boards'))
      if (line.includes('/issues?')) return ok(fixture('gitlab-issues'))
      if (line.includes('/merge_requests?')) return ok([])
      return { code: 1, out: '', err: `nothing answers ${line}` }
    })

  test('an issue is in the list whose scoped label it carries; open without one is Open, closed is Closed', async () => {
    const run = glab()
    const trackers = new Trackers({ run, now: () => NOW })
    expect((await trackers.refresh(folder, { project: true })).outcome).toBe('read')
    /* One call for the boards, beside the listing. */
    expect(run.asked.filter((a) => a.join(' ').includes('/boards'))).toHaveLength(1)
    const got = trackers.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    expect(trackerReadingResult.safeParse(got).success).toBe(true)
    const rows = byRef(got.rows)
    const dev = { board: 'Development', boardUrl: 'https://gitlab.example.org/group/project/-/boards/7' }
    const front = { board: 'Frontend', boardUrl: 'https://gitlab.example.org/group/project/-/boards/8' }
    expect(rows.get('#12')!.column).toEqual({ name: 'workflow::doing', ...dev })
    expect(rows.get('#12')!.columns).toEqual([{ name: 'workflow::doing', ...dev }, { name: 'workflow::doing', ...front }])
    expect(rows.get('#13')!.column).toEqual({ name: 'Open', ...dev })
    expect('columns' in rows.get('#13')!).toBe(false)
    expect(rows.get('#14')!.column).toEqual({ name: 'Closed', ...dev })
    expect(rows.get('#15')!.column).toEqual({ name: 'workflow::review', ...dev })
  })

  test('tracker.columns lists the boards with their lists in board order', async () => {
    const trackers = new Trackers({ run: glab(), now: () => NOW })
    await trackers.refresh(folder, { project: true })
    const columns = trackers.columns(folder)
    expect(trackerColumnsResult.safeParse(columns).success).toBe(true)
    expect(columns).toEqual({
      boards: [
        { board: 'Development', boardUrl: 'https://gitlab.example.org/group/project/-/boards/7', columns: ['Open', 'workflow::doing', 'workflow::review', 'Closed'] },
        { board: 'Frontend', boardUrl: 'https://gitlab.example.org/group/project/-/boards/8', columns: ['workflow::doing', 'Closed'] },
      ],
    })
    /* And the module asking gets the same, under trackers:read. */
    const asked = answer('kehikot.journeys', 'tracker.columns', {}, () => true, undefined, folder, undefined, trackers)
    expect(asked.ok).toBe(true)
    if (asked.ok) expect(asked.data).toEqual(columns)
  })

  test('the boards and the columns survive a second host process reading the cache', async () => {
    const trackers = new Trackers({ run: glab(), now: () => NOW })
    await trackers.refresh(folder, { project: true })
    const again = new Trackers({ run: glab(), now: () => NOW })
    const got = again.get(folder, { refs: ['#12'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows[0]!.column?.name).toBe('workflow::doing')
    expect(again.columns(folder).boards).toHaveLength(2)
  })

  test('a GitLab read of the boards alone parses the REST answer', async () => {
    const adapter = gitlabAdapter(runner(() => ok(fixture('gitlab-boards'))))
    const got = await adapter.boards!(gl)
    if (!got || 'unreadable' in got) throw new Error('no boards')
    expect(got.boards.map((b) => b.board)).toEqual(['Development', 'Frontend'])
  })
})

describe('absent boards', () => {
  test('a GitLab project with no board: no column anywhere, and tracker.columns is empty', async () => {
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (argv[0] === 'git') return { code: 0, out: 'origin\thttps://gitlab.example.org/group/project.git (fetch)', err: '' }
      if (line.includes('/boards')) return ok([])
      if (line.includes('/issues?')) return ok(fixture('gitlab-issues'))
      return ok([])
    })
    const trackers = new Trackers({ run, now: () => NOW })
    await trackers.refresh(folder, { project: true })
    const got = trackers.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows.length).toBeGreaterThan(0)
    for (const row of got.rows) expect('column' in row).toBe(false)
    expect(trackers.columns(folder)).toEqual({ boards: [] })
    expect(trackers.listing(folder, []).boardsNote ?? null).toBeNull()
  })

  test('a GitLab boards call that fails costs nothing but the columns', async () => {
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (argv[0] === 'git') return { code: 0, out: 'origin\thttps://gitlab.example.org/group/project.git (fetch)', err: '' }
      if (line.includes('/boards')) return { code: 1, out: '', err: '403 Forbidden' }
      if (line.includes('/issues?')) return ok(fixture('gitlab-issues'))
      return ok([])
    })
    const trackers = new Trackers({ run, now: () => NOW })
    expect((await trackers.refresh(folder, { project: true })).outcome).toBe('read')
    expect(trackers.columns(folder)).toEqual({ boards: [] })
  })

  test('a GitHub item on no project, with the scope, has no column and the panel says nothing', async () => {
    const empty = fixture('github-without-boards') as { data: { repository: Record<string, { nodes: Array<Record<string, unknown>> }> } }
    for (const half of Object.values(empty.data.repository)) for (const node of half.nodes) node.projectItems = { nodes: [] }
    const run = runner((argv) =>
      argv[0] === 'git' ? { code: 0, out: 'origin\thttps://github.com/Jalez/kehikko.git (fetch)', err: '' } : ok(empty),
    )
    const trackers = new Trackers({ run, now: () => NOW })
    await trackers.refresh(folder, { project: true })
    const got = trackers.get(folder, { project: true })
    if ('refused' in got) throw new Error(got.refused)
    for (const row of got.rows) expect('column' in row).toBe(false)
    expect(trackers.columns(folder)).toEqual({ boards: [] })
    expect(trackers.listing(folder, [{ name: 'origin', url: 'https://github.com/Jalez/kehikko.git' }]).boardsNote).toBeNull()
  })
})
