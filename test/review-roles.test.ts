import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackerReadingResult, trackerRowSchema, type TrackerRow } from 'kehikot-module-protocol'

import type { Ran, Runner } from '../server/feedback.ts'
import { trackerLine } from '../server/mcp.ts'
import { githubAdapter, listQuery, refsQuery as ghRefsQuery } from '../server/trackers/github.ts'
import { gitlabAdapter, OLD_GITLAB_PEOPLE, refsQuery as glRefsQuery } from '../server/trackers/gitlab.ts'
import { Trackers } from '../server/trackers/reading.ts'
import { rolesFor, withRoles } from '../server/trackers/roles.ts'
import type { Source } from '../server/trackers/sources.ts'
import { listingText } from '../src/host/trackerSources.ts'

/**
 * Review orchestration, contract C3: the tracker reading names a change's
 * people by login, says the person's roles on it, its review discussions and
 * its last push (protocol 2.7.0). The answers below are in the shapes GitHub
 * and GitLab gave read-only queries (cli/cli, gitlab-org/cli); nothing here
 * reaches either.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-roles-')))
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

const row = (over: Partial<TrackerRow> = {}): TrackerRow =>
  trackerRowSchema.parse({
    ref: 'gh#41',
    tracker: 'github',
    host: 'github.com',
    repo: 'Jalez/kehikko',
    number: 41,
    kind: 'change',
    state: 'open',
    title: 'A change',
    url: 'https://github.com/Jalez/kehikko/pull/41',
    readAt: NOW.toISOString(),
    ...over,
  })

describe('my roles on a row', () => {
  test('author, assignee, and a reviewer asked or done', () => {
    const r = row({
      authorLogin: 'Jalez',
      assigneeLogins: ['mona', 'jalez'],
      reviewers: [
        { login: 'jalez', state: 'requested' },
        { login: 'hubot', state: 'approved' },
      ],
    })
    expect(rolesFor(r, 'JALEZ')).toEqual(['reviewer-asked', 'author', 'assignee'])
    expect(rolesFor(r, 'hubot')).toEqual(['reviewer-done'])
    expect(rolesFor(r, 'mona')).toEqual(['assignee'])
    expect(rolesFor(r, 'nobody')).toEqual([])
  })
  test('a review of any kind is done: approved, changes or commented', () => {
    for (const state of ['approved', 'changes', 'commented'] as const) {
      expect(rolesFor(row({ reviewers: [{ login: 'me', state }] }), 'me')).toEqual(['reviewer-done'])
    }
  })
  test('withRoles sets myRoles, [] when there are none, and the row still parses', () => {
    const none = withRoles(row(), 'me')
    expect(none.myRoles).toEqual([])
    expect(trackerRowSchema.safeParse(withRoles(row({ authorLogin: 'me' }), 'me')).success).toBe(true)
  })
})

/** A pull request node as GitHub's GraphQL answers it (cli/cli, read-only). */
const pull = (over: Record<string, unknown> = {}) => ({
  __typename: 'PullRequest',
  number: 41,
  state: 'OPEN',
  title: 'Review roles',
  url: 'https://github.com/Jalez/kehikko/pull/41',
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-21T10:00:00Z',
  closedAt: null,
  mergedAt: null,
  author: { login: 'octocat' },
  labels: { nodes: [] },
  assignees: { nodes: [{ login: 'Jalez', name: 'Jaakko' }] },
  closingIssuesReferences: { nodes: [] },
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: 'User', login: 'Jalez', name: 'Jaakko' } },
      { requestedReviewer: {} },
    ],
  },
  latestReviews: {
    nodes: [
      { state: 'APPROVED', author: { login: 'williammartin', name: 'William Martin' } },
      { state: 'COMMENTED', author: { login: 'copilot-pull-request-reviewer' } },
      { state: 'CHANGES_REQUESTED', author: { login: 'Jalez', name: 'Jaakko' } },
      { state: 'PENDING', author: { login: 'drafty' } },
    ],
  },
  reviewThreads: { totalCount: 3, nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: true }] },
  commits: { nodes: [{ commit: { committedDate: '2026-10-21T09:25:26+03:00', statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...over,
})

const issue = {
  __typename: 'Issue',
  number: 7,
  state: 'OPEN',
  title: 'An issue',
  url: 'https://github.com/Jalez/kehikko/issues/7',
  author: { login: 'Jalez' },
  labels: { nodes: [] },
  assignees: { nodes: [{ login: 'mona', name: '' }] },
}

describe('GitHub: the people of a pull request', () => {
  test('the query asks for requests, reviews, threads and the last commit’s time, and no team', () => {
    for (const q of [ghRefsQuery(gh, [41]), listQuery(gh, { issues: null, pulls: null })]) {
      expect(q).toContain('reviewRequests(first: 32)')
      expect(q).toContain('latestReviews(first: 32)')
      expect(q).toContain('reviewThreads(first: 100) { totalCount nodes { isResolved } }')
      expect(q).toContain('committedDate')
      expect(q).not.toContain('Team')
      expect(q).not.toContain('pushedDate')
    }
  })

  test('a pull request read by number carries its reviewers, logins, discussions and last push', async () => {
    const run = runner(() => ok({ data: { repository: { n41: pull(), n7: issue } } }))
    const read = await githubAdapter(run).refs(gh, [{ number: 41, kind: null }, { number: 7, kind: null }], NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    const rows = byRef(read.rows)
    const pr = rows.get('gh#41')!
    /* Asked again after a review: asked wins. A team request (no login) and a pending draft review are left out. */
    expect(pr.reviewers).toEqual([
      { login: 'Jalez', name: 'Jaakko', state: 'requested' },
      { login: 'williammartin', name: 'William Martin', state: 'approved' },
      { login: 'copilot-pull-request-reviewer', state: 'commented' },
    ])
    expect(pr.authorLogin).toBe('octocat')
    expect(pr.assigneeLogins).toEqual(['Jalez'])
    expect(pr.discussions).toEqual({ resolved: 2, unresolved: 1 })
    expect(pr.lastPushAt).toBe('2026-10-21T06:25:26.000Z')
    expect(pr.myRoles).toBeUndefined()
    const is = rows.get('gh#7')!
    expect(is.authorLogin).toBe('Jalez')
    expect(is.assigneeLogins).toEqual(['mona'])
    expect(is.reviewers).toBeUndefined()
    expect(is.discussions).toBeUndefined()
  })

  test('threads beyond the first hundred: no count rather than a wrong one', async () => {
    const many = pull({ reviewThreads: { totalCount: 140, nodes: Array.from({ length: 100 }, () => ({ isResolved: true })) } })
    const run = runner(() => ok({ data: { repository: { n41: many } } }))
    const read = await githubAdapter(run).refs(gh, [{ number: 41, kind: null }], NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows[0]!.discussions).toBeUndefined()
  })

  test('nobody asked and nobody reviewed is an empty list, not an absent one', async () => {
    const run = runner(() => ok({ data: { repository: { n41: pull({ reviewRequests: { nodes: [] }, latestReviews: { nodes: [] } }) } } }))
    const read = await githubAdapter(run).refs(gh, [{ number: 41, kind: null }], NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows[0]!.reviewers).toEqual([])
  })

  test('me is `gh api user`, with --hostname off github.com', async () => {
    const run = runner(() => ok({ login: 'Jalez', id: 1 }))
    const adapter = githubAdapter(run)
    expect(await adapter.me!('github.com')).toEqual({ login: 'Jalez' })
    expect(await adapter.me!('ghe.example.org')).toEqual({ login: 'Jalez' })
    expect(run.asked).toEqual([
      ['gh', 'api', 'user'],
      ['gh', 'api', 'user', '--hostname', 'ghe.example.org'],
    ])
  })

  test('a gh that cannot say who you are is a sentence', async () => {
    const adapter = githubAdapter(runner(() => ({ code: 4, out: '', err: 'gh auth login' })))
    const me = await adapter.me!('github.com')
    expect('why' in me && me.why).toContain('gh auth login')
  })
})

/** A merge request node as GitLab's GraphQL answers it (gitlab-org/cli, read-only). */
const merge = (over: Record<string, unknown> = {}) => ({
  iid: '8',
  state: 'opened',
  title: 'More',
  webUrl: 'https://gitlab.example.org/group/project/-/merge_requests/8',
  draft: false,
  description: '',
  approved: false,
  headPipeline: { status: 'SUCCESS', createdAt: '2026-10-20T23:29:22Z' },
  author: { username: 'eread', name: 'Evan Read' },
  assignees: { nodes: [{ username: 'eread', name: 'Evan Read' }] },
  labels: { nodes: [] },
  reviewers: {
    nodes: [
      { username: 'jhebden', name: 'James Hebden', mergeRequestInteraction: { approved: false, reviewState: 'UNREVIEWED' } },
      { username: 'GitLabDuo', name: 'GitLab Duo', mergeRequestInteraction: { approved: false, reviewState: 'REQUESTED_CHANGES' } },
      { username: 'ann', name: 'Ann', mergeRequestInteraction: { approved: false, reviewState: 'REVIEWED' } },
      { username: 'bob', name: 'Bob', mergeRequestInteraction: { approved: true, reviewState: 'APPROVED' } },
    ],
  },
  approvedBy: { nodes: [{ username: 'bob', name: 'Bob' }, { username: 'cy', name: 'Cy' }] },
  resolvableDiscussionsCount: 4,
  resolvedDiscussionsCount: 1,
  commits: { nodes: [{ committedDate: '2026-10-21T09:25:26+10:00' }] },
  ...over,
})

describe('GitLab: the people of a merge request', () => {
  test('the by-iid query asks for reviewers, approvers, discussions and times, each connection with first:', () => {
    const q = glRefsQuery(gl, [1], [8, 9])
    expect(q).toContain('reviewers(first: 32) { nodes { username name mergeRequestInteraction { approved reviewState } } }')
    expect(q).toContain('approvedBy(first: 32) { nodes { username name } }')
    expect(q).toContain('resolvableDiscussionsCount resolvedDiscussionsCount')
    expect(q).toContain('commits(first: 1) { nodes { committedDate } }')
    expect(q).toContain('headPipeline { status createdAt }')
    const without = glRefsQuery(gl, [1], [8], false)
    expect(without).not.toContain('reviewers')
    expect(without).not.toContain('resolvableDiscussionsCount')
  })

  test('a merge request carries its reviewers, approvers, discussions and last push', async () => {
    const run = runner(() => ok({ data: { project: { mergeRequests: { nodes: [merge()] } } } }))
    const read = await gitlabAdapter(run).refs(gl, [{ number: 8, kind: 'change' }], NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    const mr = read.rows[0]!
    expect(mr.reviewers).toEqual([
      { login: 'jhebden', name: 'James Hebden', state: 'requested' },
      { login: 'GitLabDuo', name: 'GitLab Duo', state: 'changes' },
      { login: 'ann', name: 'Ann', state: 'commented' },
      { login: 'bob', name: 'Bob', state: 'approved' },
      /* Approved without being asked to review. */
      { login: 'cy', name: 'Cy', state: 'approved' },
    ])
    expect(mr.authorLogin).toBe('eread')
    expect(mr.assigneeLogins).toEqual(['eread'])
    expect(mr.discussions).toEqual({ resolved: 1, unresolved: 3 })
    /* The pipeline was made after the commit (pushed later): the later of the two. */
    expect(mr.lastPushAt).toBe('2026-10-20T23:29:22.000Z')
    expect(read.people).toBeUndefined()
  })

  test('the REST listing gives logins; the open ones get the rest from the GraphQL re-read', async () => {
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (line.includes('/issues?')) return ok([{ iid: 3, state: 'opened', title: 'I', web_url: 'w3', author: { username: 'ann', name: 'Ann' }, assignees: [{ username: 'bob', name: 'Bob' }] }])
      if (line.includes('/merge_requests?')) {
        return ok([
          { iid: 8, state: 'opened', title: 'More', web_url: 'w8', author: { username: 'eread' } },
          /* REST's reviewers say nobody's state: not taken. */
          { iid: 9, state: 'merged', title: 'Done', web_url: 'w9', author: { username: 'eread' }, assignees: [], reviewers: [{ username: 'ann' }] },
        ])
      }
      return ok({ data: { project: { mergeRequests: { nodes: [merge()] } } } })
    })
    const read = await gitlabAdapter(run).list(gl, 400, NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    const rows = byRef(read.rows)
    expect(rows.get('#3')).toMatchObject({ authorLogin: 'ann', assigneeLogins: ['bob'] })
    expect(rows.get('!8')!.reviewers).toHaveLength(5)
    expect(rows.get('!9')).toMatchObject({ authorLogin: 'eread', assigneeLogins: [] })
    expect(rows.get('!9')!.reviewers).toBeUndefined()
  })

  test('an older GitLab that has not these fields: asked again without them, rows still read, said once, remembered', async () => {
    let asked = 0
    const run = runner((argv) => {
      asked += 1
      return queryOf(argv).includes('reviewers')
        ? ok({ errors: [{ message: "Field 'reviewState' doesn't exist on type 'UserMergeRequestInteraction'" }] }, 1)
        : ok({ data: { project: { mergeRequests: { nodes: [merge({ reviewers: undefined, approvedBy: undefined })] } } } })
    })
    const adapter = gitlabAdapter(run)
    const read = await adapter.refs(gl, [{ number: 8, kind: 'change' }], NOW.toISOString())
    if (!read.ok) throw new Error(read.why)
    expect(read.rows).toHaveLength(1)
    expect(read.rows[0]!.reviewers).toBeUndefined()
    expect(read.rows[0]!.authorLogin).toBe('eread')
    expect(read.people).toEqual({ unreadable: OLD_GITLAB_PEOPLE('gitlab.example.org') })
    expect(asked).toBe(2)
    /* The next read does not pay the refusal again. */
    const again = await adapter.refs(gl, [{ number: 8, kind: 'change' }], NOW.toISOString())
    expect(asked).toBe(3)
    if (again.ok) expect(again.people).toEqual({ unreadable: OLD_GITLAB_PEOPLE('gitlab.example.org') })
  })

  test('me is `glab api user` on the source’s host', async () => {
    const run = runner(() => ok({ username: 'jalez', id: 3 }))
    expect(await gitlabAdapter(run).me!('gitlab.example.org')).toEqual({ login: 'jalez' })
    expect(run.asked).toEqual([['glab', 'api', '--hostname', 'gitlab.example.org', 'user']])
  })
})

describe('the reading carries my roles', () => {
  const github = (meAnswer: Ran) =>
    runner((argv) => {
      if (argv[0] === 'git') return { code: 0, out: 'origin\thttps://github.com/Jalez/kehikko.git (fetch)', err: '' }
      if (argv.join(' ') === 'gh api user') return meAnswer
      return ok({ data: { repository: { n41: pull(), n7: issue } } })
    })

  test('each row says my roles, and who I am is asked once per host', async () => {
    const run = github(ok({ login: 'jalez' }))
    const trackers = new Trackers({ run, now: () => NOW })
    await trackers.refresh(folder, { refs: ['gh#41', 'gh#7'] })
    await trackers.refresh(folder, { refs: ['gh#41'] })
    const got = trackers.get(folder, { refs: ['gh#41', 'gh#7'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(trackerReadingResult.safeParse(got).success).toBe(true)
    const rows = byRef(got.rows)
    expect(rows.get('gh#41')!.myRoles).toEqual(['reviewer-asked', 'assignee'])
    expect(rows.get('gh#7')!.myRoles).toEqual(['author'])
    expect(run.asked.filter((a) => a.join(' ') === 'gh api user')).toHaveLength(1)
    expect(trackers.listing(folder, [{ name: 'origin', url: 'https://github.com/Jalez/kehikko.git' }]).peopleNote ?? null).toBeNull()
  })

  test('when gh cannot say who I am: no roles, never guessed, and one sentence in the panel', async () => {
    const trackers = new Trackers({ run: github({ code: 4, out: '', err: 'To get started with GitHub CLI, please run:  gh auth login' }), now: () => NOW })
    expect((await trackers.refresh(folder, { refs: ['gh#41'] })).outcome).toBe('read')
    const got = trackers.get(folder, { refs: ['gh#41'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(got.rows[0]!.myRoles).toBeUndefined()
    expect(got.rows[0]!.reviewers).toHaveLength(3)
    const listing = trackers.listing(folder, [{ name: 'origin', url: 'https://github.com/Jalez/kehikko.git' }])
    expect(listing.peopleNote).toContain('My role')
    expect(listing.peopleNote).toContain('gh auth login')
    expect(listingText(listing, NOW.getTime())).toContain(listing.peopleNote!)
  })
})

describe('read_tracker', () => {
  test('a line names the reviewers, my roles, the threads and the last push', () => {
    const line = trackerLine(
      row({
        reviewers: [
          { login: 'jalez', state: 'requested' },
          { login: 'hubot', state: 'approved' },
        ],
        myRoles: ['reviewer-asked', 'author'],
        discussions: { resolved: 2, unresolved: 1 },
        lastPushAt: '2026-10-21T06:25:26.000Z',
      }),
    )
    expect(line).toContain('reviewers:jalez(requested),hubot(approved)')
    expect(line).toContain('my roles:reviewer-asked,author')
    expect(line).toContain('threads:1 unresolved,2 resolved')
    expect(line).toContain('pushed:2026-10-21T06:25:26.000Z')
    expect(trackerLine(row())).not.toContain('reviewers:')
  })
})
