import { describe, expect, test } from 'bun:test'
import { LIMITS, trackerDetailSchema, type TrackerRow } from 'kehikot-module-protocol'

import type { Ran, Runner } from '../server/feedback.ts'
import { githubAdapter } from '../server/trackers/github.ts'
import { gitlabAdapter } from '../server/trackers/gitlab.ts'
import {
  detailCurrent,
  detailVersion,
  githubCheckState,
  githubItemFacts,
  githubItemQuery,
  gitlabChecks,
  gitlabComments,
  gitlabJobState,
  milestoneOf,
} from '../server/trackers/itemDetail.ts'
import type { Source } from '../server/trackers/sources.ts'

/**
 * Protocol 2.98.0: a ref's detail carries what a person reads an item for — the milestone, the
 * newest comments and their count, a change's checks one by one, and a fork's branch. Fake CLIs;
 * nothing here reaches GitHub or GitLab.
 */

const NOW = '2026-11-13T12:00:00.000Z'
const ok = (out: unknown, code = 0): Ran => ({ code, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' })
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'owner/repo', default: true, listed: true }
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }

function runner(answers: Array<[string, Ran | ((argv: string[]) => Ran)]>): Runner & { asked: string[][] } {
  const asked: string[][] = []
  const run = (async (argv: string[]) => {
    asked.push(argv)
    const line = argv.join(' ')
    for (const [has, ran] of answers) if (line.includes(has)) return typeof ran === 'function' ? ran(argv) : ran
    return { code: 1, out: '', err: `nothing answers ${line}` }
  }) as Runner & { asked: string[][] }
  run.asked = asked
  return run
}

const row = (over: Partial<TrackerRow>): TrackerRow => ({
  ref: '!7',
  tracker: 'gitlab',
  host: 'gitlab.example.org',
  repo: 'group/project',
  number: 7,
  kind: 'change',
  state: 'open',
  title: 'A change',
  url: 'https://gitlab.example.org/group/project/-/merge_requests/7',
  labels: [],
  assignees: [],
  links: [],
  readAt: NOW,
  ...over,
})

const pull = {
  __typename: 'PullRequest',
  milestone: { title: 'v1', url: 'https://github.com/owner/repo/milestone/1', dueOn: '2026-12-01T00:00:00Z' },
  comments: {
    totalCount: 3,
    nodes: [
      { databaseId: 11, author: { login: 'ada', name: 'Ada L' }, body: 'First.', createdAt: '2026-11-01T10:00:00Z', lastEditedAt: null, url: 'https://github.com/owner/repo/pull/5#issuecomment-11' },
      { databaseId: 12, author: null, body: 'From a deleted account.', createdAt: '2026-11-02T10:00:00Z', url: 'javascript:alert(1)' },
    ],
  },
  reviews: {
    nodes: [
      { databaseId: 21, author: { login: 'bob' }, body: 'Approved, one nit.', state: 'APPROVED', submittedAt: '2026-11-03T10:00:00Z', url: 'https://github.com/owner/repo/pull/5#pullrequestreview-21' },
      { databaseId: 22, author: { login: 'cy' }, body: '', state: 'APPROVED', submittedAt: '2026-11-03T11:00:00Z' },
    ],
  },
  reviewThreads: {
    nodes: [{ path: 'src/a.ts', comments: { nodes: [{ databaseId: 11, author: { login: 'cy' }, body: 'Why here?', createdAt: '2026-11-02T12:00:00Z', path: 'src/a.ts' }] } }],
  },
  isCrossRepository: true,
  headRefName: 'fix-it',
  headRepository: { nameWithOwner: 'someone/repo' },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              totalCount: 3,
              nodes: [
                { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/owner/repo/runs/1', completedAt: '2026-11-03T09:00:00Z' },
                { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-11-03T09:01:00Z' },
                { __typename: 'StatusContext', context: 'ci/legacy', state: 'FAILURE', targetUrl: 'http://ci.example/1', createdAt: '2026-11-03T08:00:00Z' },
              ],
            },
          },
        },
      },
    ],
  },
}

describe('GitHub', () => {
  test('one item query asks for the comments, reviews, line comments, milestone, checks and fork', () => {
    const q = githubItemQuery(gh, 5)
    expect(q).toContain('repository(owner: "owner", name: "repo")')
    expect(q).toContain('issueOrPullRequest(number: 5)')
    expect(q).toContain(`comments(last: ${LIMITS.TRACKER_COMMENTS})`)
    expect(q).toContain(`contexts(first: ${LIMITS.TRACKER_CHECKS})`)
    expect(q).toContain('headRepository { nameWithOwner }')
  })

  test("a pull request's answer becomes detail facts the protocol takes", () => {
    const facts = githubItemFacts(pull, 'github.com')
    expect(facts.milestone).toEqual({ title: 'v1', url: 'https://github.com/owner/repo/milestone/1', dueOn: '2026-12-01' })
    expect(facts.comments?.map((c) => [c.id, c.kind])).toEqual([
      ['11', 'comment'],
      ['12', 'comment'],
      ['l11', 'line'],
      ['r21', 'review'],
    ])
    const [first, second, line, review] = facts.comments!
    expect(first).toMatchObject({ login: 'ada', name: 'Ada L', url: 'https://github.com/owner/repo/pull/5#issuecomment-11' })
    expect(second!.login).toBeUndefined()
    expect(second!.url).toBeUndefined()
    expect(line).toMatchObject({ path: 'src/a.ts' })
    expect(review).toMatchObject({ verdict: 'approved', body: 'Approved, one nit.' })
    expect(facts.commentCount).toBe(3 + 2)
    expect(facts.checks).toEqual([
      { name: 'test', state: 'success', url: 'https://github.com/owner/repo/runs/1', at: '2026-11-03T09:00:00.000Z' },
      { name: 'lint', state: 'running', at: '2026-11-03T09:01:00.000Z' },
      { name: 'ci/legacy', state: 'failed', at: '2026-11-03T08:00:00.000Z' },
    ])
    expect(facts.checksClipped).toBe(false)
    expect(facts.fork).toEqual({ repo: 'someone/repo', branch: 'fix-it' })
    expect(trackerDetailSchema.parse({ ...facts, readAt: NOW }).comments).toHaveLength(4)
  })

  test('an issue has no checks and no fork', () => {
    const facts = githubItemFacts({ __typename: 'Issue', milestone: null, comments: { totalCount: 0, nodes: [] } }, 'github.com')
    expect(facts).toEqual({ comments: [], commentCount: 0 })
  })

  test('check states', () => {
    expect(githubCheckState({ conclusion: 'NEUTRAL' })).toBe('skipped')
    expect(githubCheckState({ conclusion: 'CANCELLED' })).toBe('canceled')
    expect(githubCheckState({ conclusion: 'TIMED_OUT' })).toBe('failed')
    expect(githubCheckState({ status: 'QUEUED' })).toBe('pending')
    expect(githubCheckState({ state: 'EXPECTED' })).toBe('pending')
  })

  test('the adapter adds them to the detail, and a refused item query keeps the rest', async () => {
    const answers = (item: Ran) =>
      runner([
        ['pr view 5', ok({ body: 'The description.', files: [], headRefOid: 'abc', latestReviews: [] })],
        ['api graphql', item],
      ])
    const fine = await githubAdapter(answers(ok({ data: { repository: { issueOrPullRequest: pull } } }))).detail(gh, [row({ ref: 'gh#5', tracker: 'github', host: 'github.com', repo: 'owner/repo', number: 5 })], NOW)
    expect(fine instanceof Map && fine.get('gh#5')?.comments?.length).toBe(4)
    expect(fine instanceof Map && fine.get('gh#5')?.body).toBe('The description.')
    const refused = await githubAdapter(answers({ code: 1, out: '', err: 'HTTP 502' })).detail(gh, [row({ ref: 'gh#5', tracker: 'github', host: 'github.com', repo: 'owner/repo', number: 5 })], NOW)
    expect(refused instanceof Map && refused.get('gh#5')).toMatchObject({ body: 'The description.' })
    expect(refused instanceof Map && refused.get('gh#5')?.comments).toBeUndefined()
  })
})

describe('GitLab', () => {
  const notes = [
    { id: 33, system: false, type: 'DiffNote', author: { username: 'cy', name: 'Cy' }, body: 'Why here?', created_at: '2026-11-03T10:00:00Z', position: { new_path: 'src/a.ts' } },
    { id: 32, system: true, author: { username: 'bot' }, body: 'added 1 commit', created_at: '2026-11-02T11:00:00Z' },
    { id: 31, system: false, type: null, author: { username: 'ada', name: 'Ada' }, body: 'First.', created_at: '2026-11-02T10:00:00Z', last_edited_at: '2026-11-02T10:30:00Z' },
  ]

  test("people's notes, oldest first, without the system's", () => {
    const comments = gitlabComments(notes, 'https://gitlab.example.org/group/project/-/merge_requests/7')
    expect(comments.map((c) => [c.id, c.kind, c.login])).toEqual([
      ['31', 'comment', 'ada'],
      ['33', 'line', 'cy'],
    ])
    expect(comments[0]).toMatchObject({ editedAt: '2026-11-02T10:30:00.000Z', url: 'https://gitlab.example.org/group/project/-/merge_requests/7#note_31' })
    expect(comments[1]!.path).toBe('src/a.ts')
  })

  test('at most the newest TRACKER_COMMENTS, and a long one is clipped and says so', () => {
    const many = Array.from({ length: LIMITS.TRACKER_COMMENTS + 5 }, (_, i) => ({
      id: 1000 - i,
      system: false,
      author: { username: 'ada' },
      body: i === 0 ? 'x'.repeat(LIMITS.TRACKER_COMMENT + 10) : 'ok',
      created_at: new Date(Date.parse(NOW) - i * 60_000).toISOString(),
    }))
    const comments = gitlabComments(many, 'https://gitlab.example.org/group/project/-/issues/3')
    expect(comments).toHaveLength(LIMITS.TRACKER_COMMENTS)
    expect(comments.at(-1)!.id).toBe('1000')
    expect(comments.at(-1)!.bodyClipped).toBe(true)
    expect(comments.at(-1)!.body.length).toBe(LIMITS.TRACKER_COMMENT)
  })

  test('jobs in pipeline order, in the pipeline words', () => {
    const facts = gitlabChecks([
      { name: 'deploy', stage: 'deploy', status: 'manual', web_url: 'https://gitlab.example.org/group/project/-/jobs/3' },
      { name: 'test', stage: 'test', status: 'failed', finished_at: '2026-11-03T10:00:00Z' },
      { name: 'build', stage: 'build', status: 'success' },
    ])
    expect(facts).toEqual({
      checks: [
        { name: 'build', state: 'success', stage: 'build' },
        { name: 'test', state: 'failed', at: '2026-11-03T10:00:00.000Z', stage: 'test' },
        { name: 'deploy', state: 'manual', url: 'https://gitlab.example.org/group/project/-/jobs/3', stage: 'deploy' },
      ],
      checksClipped: false,
    })
    expect(gitlabJobState('waiting_for_resource')).toBe('pending')
    expect(gitlabChecks([])).toEqual({})
  })

  test('a milestone from REST, with its date', () => {
    expect(milestoneOf({ title: '17.0', webUrl: 'https://gitlab.example.org/group/project/-/milestones/4', dueDate: '2026-12-24' }, 'gitlab.example.org')).toEqual({
      title: '17.0',
      url: 'https://gitlab.example.org/group/project/-/milestones/4',
      dueOn: '2026-12-24',
    })
    expect(milestoneOf({ title: 'path only', webPath: '/group/project/-/milestones/5' }, 'gitlab.example.org')?.url).toBe('https://gitlab.example.org/group/project/-/milestones/5')
    expect(milestoneOf(null, 'gitlab.example.org')).toBeUndefined()
  })

  test('the adapter reads the notes, the item, the head pipeline jobs and the fork', async () => {
    const run = runner([
      ['graphql', ok({ data: { project: { mergeRequests: { nodes: [{ iid: '7', description: 'The description.', diffHeadSha: 'abc', diffStats: [], approvedBy: { nodes: [] } }] } } } })],
      ['/notes?', ok(notes)],
      ['/merge_requests/7', ok({ user_notes_count: 2, milestone: { title: 'v1', web_url: 'https://gitlab.example.org/group/project/-/milestones/1' }, head_pipeline: { id: 90, project_id: 44 }, source_project_id: 44, target_project_id: 1, source_branch: 'fix-it' })],
      ['projects/44/pipelines/90/jobs', ok([{ name: 'test', status: 'running' }])],
      ['projects/44', ok({ path_with_namespace: 'someone/project' })],
    ])
    const got = await gitlabAdapter(run).detail(gl, [row({})], NOW)
    expect(got instanceof Map).toBe(true)
    const facts = (got as Map<string, unknown>).get('!7')
    expect(facts).toMatchObject({
      body: 'The description.',
      commentCount: 2,
      milestone: { title: 'v1' },
      checks: [{ name: 'test', state: 'running' }],
      fork: { repo: 'someone/project', branch: 'fix-it' },
    })
    expect(trackerDetailSchema.safeParse(facts).success).toBe(true)
  })
})

describe('freshness', () => {
  const detail = { body: '', bodyClipped: false, files: [], filesClipped: false, readAt: '2026-11-13T10:00:00.000Z' }

  test('a detail is current until its row moves', () => {
    expect(detailCurrent(row({ updatedAt: '2026-11-13T09:00:00.000Z' }), detail)).toBe(true)
    expect(detailCurrent(row({ updatedAt: '2026-11-13T11:00:00.000Z' }), detail)).toBe(false)
    expect(detailCurrent(row({}), undefined)).toBe(false)
  })

  test('a pipeline that moved since makes it old, though the row did not', () => {
    expect(detailCurrent(row({ pipeline: 'success', pipelineAt: '2026-11-13T11:00:00.000Z' }), detail)).toBe(false)
  })

  test('checks running when read and finished now (GitHub moves no updatedAt for that) make it old', () => {
    const running = { ...detail, checks: [{ name: 'test', state: 'running' as const }] }
    expect(detailCurrent(row({ pipeline: 'success' }), running)).toBe(false)
    expect(detailCurrent(row({ pipeline: 'running' }), running)).toBe(true)
  })

  test('each version of a row is asked for once', () => {
    expect(detailVersion(row({ updatedAt: 'a', pipeline: 'running' }))).not.toBe(detailVersion(row({ updatedAt: 'a', pipeline: 'success' })))
  })
})
