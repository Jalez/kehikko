import { describe, expect, test } from 'bun:test'
import { trackerRowSchema, type TrackerRow } from 'kehikot-module-protocol'

import type { Ran, Runner } from '../server/feedback.ts'
import { trackerLine } from '../server/mcp.ts'
import { activityOf as ghActivityOf, githubAdapter, listQuery, PAGE, refsQuery as ghRefsQuery } from '../server/trackers/github.ts'
import { activityOf as glActivityOf, gitlabAdapter, NOTES, noteKind, refsQuery as glRefsQuery } from '../server/trackers/gitlab.ts'
import { withRoles } from '../server/trackers/roles.ts'
import { withStacks } from '../server/trackers/stacks.ts'
import type { Source } from '../server/trackers/sources.ts'

/**
 * Protocol 2.8.0 on the host: a change's branches, the stacks they make across
 * the reading, and the last activity on an item with whether it was the
 * person. The answers below are in the shapes GitHub and GitLab gave
 * read-only queries (Jalez/kehikko, gitlab-org/cli); nothing here reaches either.
 */

const NOW = '2026-10-21T12:00:00.000Z'
const ok = (out: unknown, code = 0): Ran => ({ code, out: JSON.stringify(out), err: '' })
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }
const runner = (answer: (argv: string[]) => Ran): Runner => (async (argv: string[]) => answer(argv)) as Runner

const change = (number: number, over: Partial<TrackerRow> = {}): TrackerRow =>
  trackerRowSchema.parse({
    ref: `gh#${number}`,
    tracker: 'github',
    host: 'github.com',
    repo: 'Jalez/kehikko',
    number,
    kind: 'change',
    state: 'open',
    title: `Change ${number}`,
    url: `https://github.com/Jalez/kehikko/pull/${number}`,
    readAt: NOW,
    ...over,
  })

const pull = (over: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest',
  number: 42,
  state: 'OPEN',
  title: 'On top',
  url: 'https://github.com/Jalez/kehikko/pull/42',
  createdAt: '2026-10-20T10:00:00Z',
  author: { login: 'Jalez' },
  labels: { nodes: [] },
  assignees: { nodes: [] },
  baseRefName: 'feat/one',
  headRefName: 'feat/two',
  isCrossRepository: false,
  timelineItems: { nodes: [{ __typename: 'PullRequestReview', submittedAt: '2026-10-21T09:00:00Z', createdAt: '2026-10-21T08:00:00Z', author: { login: 'mona' } }] },
  ...over,
})

describe('GitHub: branches and last activity', () => {
  test('the queries ask for both branches, whether it is a fork, and the newest timeline item', () => {
    for (const q of [ghRefsQuery(gh, [42]), listQuery(gh, { issues: null, pulls: null })]) {
      expect(q).toContain('baseRefName headRefName isCrossRepository')
      expect(q).toContain('timelineItems(last: 1, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, PULL_REQUEST_COMMIT')
      expect(q).toContain('timelineItems(last: 1, itemTypes: [ISSUE_COMMENT, CLOSED_EVENT, REOPENED_EVENT])')
    }
  })
  test('a listing page is fifty and fifty, which GitHub answers in time', () => {
    expect(PAGE).toBe(50)
    expect(listQuery(gh, { issues: null, pulls: null })).toContain('first: 50,')
  })

  test('a pull request carries its branches and its last review', async () => {
    const read = await githubAdapter(runner(() => ok({ data: { repository: { n42: pull() } } }))).refs(gh, [{ number: 42, kind: null }], NOW)
    if (!read.ok) throw new Error(read.why)
    const pr = read.rows[0]!
    expect(pr.baseBranch).toBe('feat/one')
    expect(pr.headBranch).toBe('feat/two')
    expect(pr.lastActivity).toEqual({ login: 'mona', at: '2026-10-21T09:00:00.000Z', kind: 'review' })
  })

  test('a pull request from a fork has a base and no head branch', async () => {
    const read = await githubAdapter(runner(() => ok({ data: { repository: { n42: pull({ isCrossRepository: true }) } } }))).refs(gh, [{ number: 42, kind: null }], NOW)
    if (!read.ok) throw new Error(read.why)
    expect(read.rows[0]!.baseBranch).toBe('feat/one')
    expect(read.rows[0]!.headBranch).toBeUndefined()
  })

  test('each kind of timeline item, and the opening when there is none', () => {
    expect(ghActivityOf({ nodes: [{ __typename: 'IssueComment', createdAt: '2026-10-21T01:00:00Z', author: { login: 'a' } }] }, null, null)?.kind).toBe('comment')
    expect(ghActivityOf({ nodes: [{ __typename: 'ClosedEvent', createdAt: '2026-10-21T01:00:00Z', actor: { login: 'a' } }] }, null, null)?.kind).toBe('state')
    expect(ghActivityOf({ nodes: [{ __typename: 'HeadRefForcePushedEvent', createdAt: '2026-10-21T01:00:00Z', actor: { login: 'a' } }] }, null, null)?.kind).toBe('commit')
    expect(
      ghActivityOf({ nodes: [{ __typename: 'PullRequestCommit', commit: { committedDate: '2026-10-21T01:00:00Z', author: { user: { login: 'b' } } } }] }, null, null),
    ).toEqual({ login: 'b', at: '2026-10-21T01:00:00.000Z', kind: 'commit' })
    expect(ghActivityOf({ nodes: [] }, { login: 'Jalez' }, '2026-10-19T12:30:56Z')).toEqual({ login: 'Jalez', at: '2026-10-19T12:30:56.000Z', kind: 'state' })
  })

  test('a commit by nobody GitHub knows is not put on anybody, and no older one stands in', () => {
    expect(ghActivityOf({ nodes: [{ __typename: 'PullRequestCommit', commit: { committedDate: '2026-10-21T01:00:00Z', author: { user: null } } }] }, { login: 'Jalez' }, '2026-10-19T00:00:00Z')).toBeUndefined()
  })

  test('an answer without the timeline has no last activity', async () => {
    const { timelineItems: _gone, ...without } = pull()
    const read = await githubAdapter(runner(() => ok({ data: { repository: { n42: without } } }))).refs(gh, [{ number: 42, kind: null }], NOW)
    if (!read.ok) throw new Error(read.why)
    expect(read.rows[0]!.lastActivity).toBeUndefined()
  })
})

/** Notes as GitLab's GraphQL gives them (gitlab-org/cli, read-only): oldest first. */
const note = (body: string, username: string, createdAt: string, system = true) => ({ system, body, createdAt, author: { username } })

const merge = (over: Record<string, unknown> = {}) => ({
  iid: '4170',
  state: 'opened',
  title: 'Upstream',
  webUrl: 'https://gitlab.example.org/group/project/-/merge_requests/4170',
  createdAt: '2026-10-21T12:53:41Z',
  author: { username: 'arpit' },
  assignees: { nodes: [] },
  labels: { nodes: [] },
  sourceBranch: 'df-go-4-upstream',
  targetBranch: 'df-go-3-command',
  sourceProjectId: 34675721,
  targetProjectId: 34675721,
  notes: {
    nodes: [
      note('assigned to @arpit', 'arpit', '2026-10-21T12:53:41Z'),
      note('Looks good, one question', 'mona', '2026-10-21T13:00:00Z', false),
      note('added 1 commit\n\n* abc - Fix', 'arpit', '2026-10-21T13:10:00Z'),
      note('started session [981](https://x) triggered by @arpit', 'duo-bot', '2026-10-21T13:11:00Z'),
      note('mentioned in merge request !4171', 'arpit', '2026-10-21T13:12:00Z'),
    ],
  },
  ...over,
})

describe('GitLab: branches and last activity', () => {
  test('the by-iid query asks for both branches, both projects and the newest notes', () => {
    const q = glRefsQuery(gl, [1], [8])
    expect(q).toContain('sourceBranch targetBranch sourceProjectId targetProjectId')
    expect(q.match(new RegExp(`notes\\(last: ${NOTES}\\)`, 'g'))).toHaveLength(2)
    expect(glRefsQuery(gl, [1], [8], false)).not.toContain('notes(')
  })

  test('which notes are somebody acting on the item', () => {
    expect(noteKind({ system: false, body: 'a comment' })).toBe('comment')
    expect(noteKind({ system: true, body: 'approved this merge request' })).toBe('review')
    expect(noteKind({ system: true, body: 'requested changes' })).toBe('review')
    expect(noteKind({ system: true, body: 'added 3 commits\n\n* …' })).toBe('commit')
    expect(noteKind({ system: true, body: 'added 1 new commit' })).toBe('commit')
    expect(noteKind({ system: true, body: 'merged' })).toBe('state')
    expect(noteKind({ system: true, body: 'closed via merge request !3' })).toBe('state')
    expect(noteKind({ system: true, body: 'reopened' })).toBe('state')
    for (const body of ['assigned to @a', 'added ~bug label', 'mentioned in issue #2', 'set status to **New**', 'requested review from @b']) {
      expect(noteKind({ system: true, body })).toBeNull()
    }
  })

  test('a merge request carries its branches, and its last activity passes over the noise', async () => {
    const read = await gitlabAdapter(runner(() => ok({ data: { project: { mergeRequests: { nodes: [merge()] } } } }))).refs(gl, [{ number: 4170, kind: 'change' }], NOW)
    if (!read.ok) throw new Error(read.why)
    const mr = read.rows[0]!
    expect(mr.baseBranch).toBe('df-go-3-command')
    expect(mr.headBranch).toBe('df-go-4-upstream')
    expect(mr.lastActivity).toEqual({ login: 'arpit', at: '2026-10-21T13:10:00.000Z', kind: 'commit' })
  })

  test('a merge request from a fork has no head branch', async () => {
    const read = await gitlabAdapter(runner(() => ok({ data: { project: { mergeRequests: { nodes: [merge({ sourceProjectId: 1 })] } } } }))).refs(gl, [{ number: 4170, kind: 'change' }], NOW)
    if (!read.ok) throw new Error(read.why)
    expect(read.rows[0]!.headBranch).toBeUndefined()
    expect(read.rows[0]!.baseBranch).toBe('df-go-3-command')
  })

  test('only noise among fewer notes than asked: the opening; among a full page: not known', () => {
    const noise = (n: number) => ({ nodes: Array.from({ length: n }, (_, i) => note(`added ~l${i} label`, 'x', '2026-10-21T00:00:00Z')) })
    expect(glActivityOf(noise(2), { username: 'ann' }, '2026-10-20T00:00:00Z')).toEqual({ login: 'ann', at: '2026-10-20T00:00:00.000Z', kind: 'state' })
    expect(glActivityOf(noise(NOTES), { username: 'ann' }, '2026-10-20T00:00:00Z')).toBeUndefined()
    /* Not asked (REST) is not "none". */
    expect(glActivityOf(undefined, { username: 'ann' }, '2026-10-20T00:00:00Z')).toBeUndefined()
  })

  test('the listing reads the open issues again beside the open merge requests, for their notes', async () => {
    const asked: string[] = []
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (line.includes('/issues?')) return ok([{ iid: 3, state: 'opened', title: 'I', web_url: 'w3', author: { username: 'ann' } }, { iid: 4, state: 'closed', title: 'J', web_url: 'w4' }])
      if (line.includes('/merge_requests?')) {
        return ok([{ iid: 4170, state: 'opened', title: 'M', web_url: 'w', source_branch: 'a', target_branch: 'main', source_project_id: 5, target_project_id: 5 }])
      }
      asked.push(argv.find((a) => a.startsWith('query=')) ?? '')
      return ok({
        data: {
          project: {
            issues: { nodes: [{ iid: '3', state: 'opened', title: 'I', webUrl: 'w3', author: { username: 'ann' }, notes: { nodes: [note('Me too', 'bob', '2026-10-21T02:00:00Z', false)] } }] },
            mergeRequests: { nodes: [merge()] },
          },
        },
      })
    })
    const read = await gitlabAdapter(run).list(gl, 400, NOW)
    if (!read.ok) throw new Error(read.why)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('issues(iids: ["3"]')
    const rows = new Map(read.rows.map((r) => [r.ref, r]))
    expect(rows.get('#3')!.lastActivity).toEqual({ login: 'bob', at: '2026-10-21T02:00:00.000Z', kind: 'comment' })
    expect(rows.get('#4')!.lastActivity).toBeUndefined()
    expect(rows.get('!4170')!.headBranch).toBe('df-go-4-upstream')
  })

  test('the REST listing gives branches too', async () => {
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (line.includes('/issues?')) return ok([])
      if (line.includes('/merge_requests?')) {
        return ok([{ iid: 9, state: 'merged', title: 'M', web_url: 'w', source_branch: 'a', target_branch: 'main', source_project_id: 5, target_project_id: 5 }])
      }
      return ok({ data: { project: {} } })
    })
    const read = await gitlabAdapter(run).list(gl, 400, NOW)
    if (!read.ok) throw new Error(read.why)
    expect(read.rows[0]).toMatchObject({ baseBranch: 'main', headBranch: 'a' })
  })
})

describe('stacks across the reading', () => {
  const bottom = change(41, { baseBranch: 'main', headBranch: 'one' })
  const middle = change(42, { baseBranch: 'one', headBranch: 'two' })
  const top = change(43, { baseBranch: 'two', headBranch: 'three' })
  const alone = change(50, { baseBranch: 'main', headBranch: 'alone' })

  test('each change in a stack names the one below and those above; one in none has no stack', () => {
    const rows = new Map(withStacks([top, alone, bottom, middle]).map((r) => [r.ref, r]))
    expect(rows.get('gh#41')!.stack).toEqual({ above: ['gh#42'] })
    expect(rows.get('gh#42')!.stack).toEqual({ below: 'gh#41', above: ['gh#43'] })
    expect(rows.get('gh#43')!.stack).toEqual({ below: 'gh#42', above: [] })
    expect(rows.get('gh#50')!.stack).toBeUndefined()
    for (const r of rows.values()) expect(trackerRowSchema.safeParse(r).success).toBe(true)
  })

  test('a fork in the stack: both above, in number order', () => {
    const other = change(44, { baseBranch: 'one', headBranch: 'side' })
    const rows = new Map(withStacks([bottom, other, middle]).map((r) => [r.ref, r]))
    expect(rows.get('gh#41')!.stack!.above).toEqual(['gh#42', 'gh#44'])
  })

  test('closed and merged changes, issues and other repositories are not in it', () => {
    const merged = change(41, { baseBranch: 'main', headBranch: 'one', state: 'merged' })
    expect(withStacks([merged, middle]).find((r) => r.ref === 'gh#42')!.stack).toBeUndefined()
    const elsewhere = change(41, { repo: 'Jalez/other', ref: 'gh:Jalez/other#41', baseBranch: 'main', headBranch: 'one' })
    expect(withStacks([elsewhere, middle]).find((r) => r.ref === 'gh#42')!.stack).toBeUndefined()
  })

  test('two open changes from one branch: what sits on it has no below, never a guess', () => {
    const twin = change(45, { baseBranch: 'release', headBranch: 'one' })
    const got = withStacks([bottom, twin, middle]).find((r) => r.ref === 'gh#42')!
    expect(got.stack).toBeUndefined()
  })

  test('a stack held from an earlier read is taken off once it no longer holds', () => {
    const was = change(42, { baseBranch: 'main', headBranch: 'two', stack: { below: 'gh#41', above: [] } })
    expect(withStacks([bottom, was]).find((r) => r.ref === 'gh#42')!.stack).toBeUndefined()
  })
})

describe('whether the last activity was mine', () => {
  const acted = (login: string) => change(42, { lastActivity: { login, at: NOW, kind: 'comment' } })
  test('mine when the login is mine, whatever its case; not mine otherwise', () => {
    expect(withRoles(acted('JALEZ'), 'jalez').lastActivity!.mine).toBe(true)
    expect(withRoles(acted('mona'), 'jalez').lastActivity!.mine).toBe(false)
  })
  test('unknown when who I am is not known: the reading does not apply roles, so `mine` stays absent', () => {
    expect(acted('mona').lastActivity!.mine).toBeUndefined()
  })
  test('a row with no last activity gets none', () => {
    expect(withRoles(change(42), 'jalez').lastActivity).toBeUndefined()
  })
})

describe('read_tracker', () => {
  test('a line names the branches, the stack and the last activity', () => {
    const line = trackerLine(
      change(42, {
        baseBranch: 'one',
        headBranch: 'two',
        stack: { below: 'gh#41', above: ['gh#43'] },
        lastActivity: { login: 'mona', at: NOW, kind: 'review', mine: false },
      }),
    )
    expect(line).toContain('base:one head:two')
    expect(line).toContain('stack:on gh#41,under gh#43')
    expect(line).toContain(`last:review by mona (not me) at ${NOW}`)
    expect(trackerLine(change(41, { stack: { above: ['gh#42'] } }))).toContain('stack:bottom,under gh#42')
    expect(trackerLine(change(41))).not.toContain('stack:')
  })
})
