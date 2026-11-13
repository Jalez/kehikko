import { describe, expect, test } from 'bun:test'
import type { TrackerRow } from 'kehikot-module-protocol'

import { issueRow, linkClosers, pullRow } from '../server/trackers/github.ts'
import { issueRow as glIssueRow, linkDeclarers, mergeRow } from '../server/trackers/gitlab.ts'
import type { Source } from '../server/trackers/sources.ts'

/**
 * A `closed-by` link says where the closing change stands (protocol 2.100.0), so an open issue can
 * be shown as "closing in !56" while that change is open — also when the change's own row is not in
 * the reading.
 */

const NOW = '2026-11-13T12:00:00.000Z'
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }

const ghIssue = (closers: unknown[]) => ({
  number: 5,
  state: 'OPEN',
  title: 'an issue',
  url: 'https://github.com/Jalez/kehikko/issues/5',
  closedByPullRequestsReferences: { nodes: closers },
})
const ghPull = (number: number, more: Record<string, unknown>) => ({
  number,
  state: 'OPEN',
  title: `pull ${number}`,
  url: `https://github.com/Jalez/kehikko/pull/${number}`,
  closingIssuesReferences: { nodes: [{ number: 5 }] },
  ...more,
})

describe('GitHub', () => {
  test('the issue answer names each closing pull request with its state and draft', () => {
    const row = issueRow(
      gh,
      ghIssue([
        { number: 6, merged: false, state: 'OPEN', isDraft: false },
        { number: 7, merged: false, state: 'OPEN', isDraft: true },
        { number: 8, merged: true, state: 'MERGED', isDraft: false },
        { number: 9, merged: false, state: 'CLOSED', isDraft: false },
      ]),
      NOW,
    )!
    expect(row.links).toEqual([
      { ref: 'gh#6', relation: 'closed-by', state: 'open', draft: false },
      { ref: 'gh#7', relation: 'closed-by', state: 'open', draft: true },
      { ref: 'gh#8', relation: 'closed-by', state: 'merged' },
      { ref: 'gh#9', relation: 'closed-by', state: 'closed' },
    ])
  })

  test('an answer without a state leaves the link as it was', () => {
    expect(issueRow(gh, ghIssue([{ number: 6 }]), NOW)!.links).toEqual([{ ref: 'gh#6', relation: 'closed-by' }])
  })

  test('a listing links the issue from the pull request, with the pull request\'s own state', () => {
    const rows = linkClosers([issueRow(gh, ghIssue([]), NOW)!, pullRow(gh, ghPull(6, { isDraft: true }), NOW)!])
    expect(rows[0]!.links).toEqual([{ ref: 'gh#6', relation: 'closed-by', state: 'open', draft: true }])
  })

  test('and the pull request\'s row is the freshest word over what the issue was read with', () => {
    const issue = issueRow(gh, ghIssue([{ number: 6, merged: false, state: 'OPEN', isDraft: true }]), NOW)!
    const merged = pullRow(gh, ghPull(6, { state: 'MERGED', mergedAt: NOW }), NOW)!
    expect(linkClosers([issue, merged])[0]!.links).toEqual([{ ref: 'gh#6', relation: 'closed-by', state: 'merged' }])
  })
})

describe('GitLab', () => {
  test('an open issue is linked to the open merge request that declares it, draft or not', () => {
    const issue = glIssueRow(gl, { iid: 12, state: 'opened', title: 'x', web_url: 'https://gitlab.example.org/group/project/-/issues/12', labels: [], assignees: [] }, NOW)!
    const merge = (iid: number, draft: boolean) =>
      mergeRow(gl, { iid, state: 'opened', draft, title: 'm', description: 'Closes #12', web_url: `https://gitlab.example.org/group/project/-/merge_requests/${iid}`, labels: [], assignees: [] }, NOW)!
    const rows: TrackerRow[] = linkDeclarers([issue, merge(56, false), merge(57, true)])
    expect(rows[0]!.links).toEqual([
      { ref: '!56', relation: 'closed-by', state: 'open', draft: false },
      { ref: '!57', relation: 'closed-by', state: 'open', draft: true },
    ])
    expect(rows[0]!.closedByMerge).toBeUndefined()
  })
})
