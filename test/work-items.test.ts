import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackerReadingResult, trackerRowSchema, type TrackerRow } from 'kehikot-module-protocol'

import type { Ran, Runner } from '../server/feedback.ts'
import { trackerLine } from '../server/mcp.ts'
import { BATCH, gitlabAdapter, issueRow, OLD_GITLAB_PEOPLE, refsQuery, workItemOf } from '../server/trackers/gitlab.ts'
import { Trackers } from '../server/trackers/reading.ts'
import type { Source } from '../server/trackers/sources.ts'

/**
 * Work item types (protocol 2.11.0): a GitLab issue that is a task, an
 * incident or another work item type says so in `workItem`, so a module can
 * tell a task from an issue. The answers below are in the shapes gitlab.com
 * gave read-only queries (GraphQL `Issue.type`, REST `issue_type` and `type`
 * for gitlab-org/gitlab#635091, a task); nothing here reaches GitLab.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-work-items-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const NOW = new Date('2026-10-22T12:00:00.000Z').toISOString()
const ok = (out: unknown, code = 0): Ran => ({ code, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' })
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

/** An issue as GraphQL gives it. */
const graphIssue = (iid: number, over: Record<string, unknown> = {}) => ({
  iid: String(iid),
  state: 'opened',
  title: `Issue ${iid}`,
  webUrl: `https://gitlab.example.org/group/project/-/work_items/${iid}`,
  createdAt: '2026-10-21T09:00:00Z',
  updatedAt: '2026-10-21T11:15:19Z',
  closedAt: null,
  author: { username: 'ann', name: 'Ann' },
  assignees: { nodes: [] },
  labels: { nodes: [] },
  notes: { nodes: [] },
  ...over,
})

/** An issue as the REST list gives it. */
const restIssue = (iid: number, over: Record<string, unknown> = {}) => ({
  iid,
  state: 'closed',
  title: `Issue ${iid}`,
  web_url: `https://gitlab.example.org/group/project/-/issues/${iid}`,
  created_at: '2026-10-01T09:00:00Z',
  updated_at: '2026-10-02T09:00:00Z',
  closed_at: '2026-10-02T09:00:00Z',
  author: { username: 'ann', name: 'Ann' },
  assignees: [],
  labels: [],
  issue_type: 'issue',
  type: 'ISSUE',
  ...over,
})

const row = (over: Partial<TrackerRow> = {}): TrackerRow =>
  trackerRowSchema.parse({
    ref: '#12',
    tracker: 'gitlab',
    host: 'gitlab.example.org',
    repo: 'group/project',
    number: 12,
    kind: 'issue',
    state: 'open',
    title: 'Write the migration',
    url: 'https://gitlab.example.org/group/project/-/work_items/12',
    readAt: NOW,
    ...over,
  })

describe('an issue’s work item type', () => {
  test('GraphQL’s `type` and REST’s `issue_type` / `type`, lower-cased', () => {
    expect(workItemOf({ type: 'TASK' })).toBe('task')
    expect(workItemOf({ issue_type: 'task' })).toBe('task')
    expect(workItemOf({ type: 'TEST_CASE', issue_type: 'test_case' })).toBe('test_case')
    expect(workItemOf({ type: 'KEY_RESULT' })).toBe('key_result')
    expect(workItemOf({ type: 'INCIDENT' })).toBe('incident')
  })

  test('a plain issue, a namespace’s own type and an issue that does not say have none', () => {
    expect(workItemOf({ type: 'ISSUE' })).toBeUndefined()
    expect(workItemOf({ issue_type: 'issue' })).toBeUndefined()
    expect(workItemOf({ type: 'SPIKE' })).toBeUndefined()
    expect(workItemOf({ type: null })).toBeUndefined()
    expect(workItemOf({})).toBeUndefined()
  })

  test('a task is a row of kind issue with `workItem: task`; a type the protocol does not list keeps the row', () => {
    expect(issueRow(gl, graphIssue(12, { type: 'TASK' }), NOW)).toMatchObject({ ref: '#12', kind: 'issue', workItem: 'task' })
    const plain = issueRow(gl, graphIssue(13, { type: 'ISSUE' }), NOW)!
    expect(plain.kind).toBe('issue')
    expect('workItem' in plain).toBe(false)
    const own = issueRow(gl, graphIssue(14, { type: 'SPIKE' }), NOW)
    expect(own).not.toBeNull()
    expect('workItem' in own!).toBe(false)
  })
})

describe('the GitLab query', () => {
  test('asks an issue’s `type` with the people, and only of issues', () => {
    const q = refsQuery(gl, [12], [8])
    const [issues, merges] = q.split('mergeRequests(')
    expect(issues).toContain('webUrl type createdAt')
    expect(merges).not.toMatch(/\btype\b/)
  })

  test('a GitLab too old for the people fields is not asked the type either', () => {
    expect(refsQuery(gl, [12], [8], false)).not.toMatch(/\btype\b/)
  })

  test('the batch stays at 22: `type` costs 2 on gitlab.com, 243 → 245 of 250', () => {
    expect(BATCH).toBe(22)
  })
})

describe('GitLab through glab', () => {
  test('a ref read by iid says it is a task', async () => {
    const run = runner(() =>
      ok({ data: { project: { issues: { nodes: [graphIssue(12, { type: 'TASK' }), graphIssue(13, { type: 'ISSUE' })] } } } }),
    )
    const read = await gitlabAdapter(run).refs(gl, [{ number: 12, kind: 'issue' }, { number: 13, kind: 'issue' }], NOW)
    if (!read.ok) throw new Error(read.why)
    const rows = new Map(read.rows.map((r) => [r.ref, r]))
    expect(rows.get('#12')!.workItem).toBe('task')
    expect(rows.get('#13')!.workItem).toBeUndefined()
  })

  test('the listing: a closed task from REST alone, an open one from the GraphQL read again', async () => {
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (line.includes('/issues?')) {
        return ok([restIssue(20, { issue_type: 'task', type: 'TASK' }), restIssue(21), restIssue(22, { state: 'opened', closed_at: null, issue_type: 'task', type: 'TASK' })])
      }
      if (line.includes('/merge_requests?')) return ok([])
      return ok({ data: { project: { issues: { nodes: [graphIssue(22, { type: 'TASK' })] } } } })
    })
    const read = await gitlabAdapter(run).list(gl, 100, NOW)
    if (!read.ok) throw new Error(read.why)
    const rows = new Map(read.rows.map((r) => [r.ref, r]))
    expect(rows.get('#20')).toMatchObject({ state: 'closed', workItem: 'task' })
    expect(rows.get('#21')!.workItem).toBeUndefined()
    expect(rows.get('#22')).toMatchObject({ state: 'open', workItem: 'task' })
  })

  test('an older GitLab without `type`: asked again without it, the row read, no type, and said once', async () => {
    const run = runner((argv) =>
      /\btype\b/.test(queryOf(argv))
        ? ok({ errors: [{ message: "Field 'type' doesn't exist on type 'Issue'" }] }, 1)
        : ok({ data: { project: { issues: { nodes: [graphIssue(12)] } } } }),
    )
    const read = await gitlabAdapter(run).refs(gl, [{ number: 12, kind: 'issue' }], NOW)
    if (!read.ok) throw new Error(read.why)
    expect(read.rows).toHaveLength(1)
    expect(read.rows[0]!.workItem).toBeUndefined()
    expect(read.people).toEqual({ unreadable: OLD_GITLAB_PEOPLE('gitlab.example.org') })
    expect(OLD_GITLAB_PEOPLE('gitlab.example.org')).toContain('a task there reads as an issue')
    expect(run.asked).toHaveLength(2)
  })
})

describe('the shared reading', () => {
  test('tracker.get hands the task over, kept and read back', async () => {
    const run = runner((argv) => {
      const line = argv.join(' ')
      if (line.startsWith('git -C')) {
        return ok('origin\thttps://gitlab.example.org/group/project.git (fetch)\norigin\thttps://gitlab.example.org/group/project.git (push)')
      }
      if (line.includes('api user')) return ok({ username: 'ann' })
      return ok({ data: { project: { issues: { nodes: [graphIssue(12, { type: 'TASK' })] } } } })
    })
    const trackers = new Trackers({ run, now: () => new Date(NOW) })
    await trackers.refresh(folder, { refs: ['#12'] })
    const got = trackers.get(folder, { refs: ['#12'] })
    if ('refused' in got) throw new Error(got.refused)
    expect(trackerReadingResult.safeParse(got).success).toBe(true)
    expect(got.rows.map((r) => [r.ref, r.kind, r.workItem])).toEqual([['#12', 'issue', 'task']])
    const again = new Trackers({ run, now: () => new Date(NOW) }).get(folder, { refs: ['#12'] })
    if ('refused' in again) throw new Error(again.refused)
    expect(again.rows[0]!.workItem).toBe('task')
  })
})

describe('read_tracker', () => {
  test('a task says so beside its kind', () => {
    expect(trackerLine(row({ workItem: 'task' }))).toStartWith('#12 issue (task) open')
    expect(trackerLine(row({ workItem: 'test_case' }))).toStartWith('#12 issue (test case) open')
  })
  test('a plain issue reads as it did', () => {
    expect(trackerLine(row())).toStartWith('#12 issue open')
  })
})
