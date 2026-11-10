import { describe, expect, test } from 'bun:test'
import { trackerRowSchema } from 'kehikot-module-protocol'

import { activityOf as ghActivityOf, openThreadsOf, reviewersOf as ghReviewersOf } from '../server/trackers/github.ts'
import { activityOf as glActivityOf, reviewersOf as glReviewersOf } from '../server/trackers/gitlab.ts'

/**
 * Protocol 2.66.0: what each reviewer did beyond the tracker's word for them, and what the latest
 * activity was — read from what the queries already fetch.
 */

const comment = (login: string, createdAt: string) => ({ __typename: 'IssueComment', createdAt, author: { login } })

describe('GitHub: what each reviewer did', () => {
  test('a reviewer still asked who commented on the conversation has an activeAt', () => {
    const reviewers = ghReviewersOf(
      { nodes: [{ requestedReviewer: { login: 'mona' } }] },
      { nodes: [] },
      { nodes: [comment('mona', '2026-11-10T09:00:00Z'), comment('ali', '2026-11-10T10:00:00Z')] },
    )
    expect(reviewers).toEqual([{ login: 'mona', state: 'requested', activeAt: '2026-11-10T09:00:00.000Z' }])
  })

  test('a review says when it was submitted, and the newest of their acts is activeAt', () => {
    const reviewers = ghReviewersOf(
      { nodes: [] },
      { nodes: [{ state: 'APPROVED', submittedAt: '2026-11-10T08:00:00Z', author: { login: 'jo' } }] },
      { nodes: [comment('jo', '2026-11-10T11:00:00Z')] },
    )
    expect(reviewers).toEqual([{ login: 'jo', state: 'approved', reviewedAt: '2026-11-10T08:00:00.000Z', activeAt: '2026-11-10T11:00:00.000Z' }])
  })

  test('asked again after a review keeps when that review was', () => {
    const reviewers = ghReviewersOf(
      { nodes: [{ requestedReviewer: { login: 'jo' } }] },
      { nodes: [{ state: 'CHANGES_REQUESTED', submittedAt: '2026-11-09T08:00:00Z', author: { login: 'jo' } }] },
    )
    expect(reviewers).toEqual([{ login: 'jo', state: 'requested', reviewedAt: '2026-11-09T08:00:00.000Z', activeAt: '2026-11-09T08:00:00.000Z' }])
  })

  test('open threads by who started them, only when every thread was read and each open one has an author', () => {
    const thread = (isResolved: boolean, login?: string) => ({ isResolved, comments: { nodes: login ? [{ author: { login } }] : [] } })
    const threads = { totalCount: 4, nodes: [thread(false, 'Cat'), thread(false, 'cat'), thread(true, 'jo'), thread(false, 'jo')] }
    expect(openThreadsOf(threads)).toEqual(new Map([['cat', 2], ['jo', 1]]))
    const reviewers = ghReviewersOf({ nodes: [] }, { nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'cat' } }, { state: 'APPROVED', author: { login: 'ann' } }] }, undefined, threads)
    expect(reviewers.map((r) => [r.login, r.openThreads])).toEqual([['cat', 2], ['ann', 0]])
    expect(openThreadsOf({ ...threads, totalCount: 140 })).toBeNull()
    expect(openThreadsOf({ totalCount: 1, nodes: [thread(false)] })).toBeNull()
  })
})

describe('GitHub: what the latest activity was', () => {
  test('a review says its verdict', () => {
    const review = { __typename: 'PullRequestReview', state: 'APPROVED', body: '', submittedAt: '2026-11-10T09:00:00Z', author: { login: 'jo' } }
    expect(ghActivityOf({ nodes: [review] }, null, null)).toEqual({ login: 'jo', at: '2026-11-10T09:00:00.000Z', kind: 'review', verdict: 'approved' })
  })
  test('a review that only commented on a line of the diff is a comment there', () => {
    const review = {
      __typename: 'PullRequestReview',
      state: 'COMMENTED',
      body: '',
      submittedAt: '2026-11-10T09:00:00Z',
      author: { login: 'mona' },
      comments: { nodes: [{ path: 'src/api.ts', line: 42 }] },
    }
    expect(ghActivityOf({ nodes: [review] }, null, null)).toEqual({ login: 'mona', at: '2026-11-10T09:00:00.000Z', kind: 'comment', path: 'src/api.ts', line: 42 })
    /* With a summary of its own it is a review. */
    expect(ghActivityOf({ nodes: [{ ...review, body: 'Looks fine, one nit.' }] }, null, null)).toMatchObject({ kind: 'review', verdict: 'commented' })
  })
  test('a run of commits by one person at the end is one push of that many', () => {
    const commit = (login: string, at: string) => ({ __typename: 'PullRequestCommit', commit: { committedDate: at, author: { user: { login } } } })
    const nodes = [commit('ali', '2026-11-10T07:00:00Z'), comment('jo', '2026-11-10T08:00:00Z'), commit('ali', '2026-11-10T09:00:00Z'), commit('ali', '2026-11-10T09:01:00Z')]
    expect(ghActivityOf({ nodes }, null, null)).toEqual({ login: 'ali', at: '2026-11-10T09:01:00.000Z', kind: 'commit', commits: 2 })
  })
})

const note = (login: string, createdAt: string, body: string, system = false, position?: unknown) => ({ system, body, createdAt, author: { username: login }, ...(position ? { position } : {}) })

describe('GitLab: what each reviewer did', () => {
  test('a reviewer GitLab calls unreviewed who left discussion notes has an activeAt', () => {
    const reviewers = glReviewersOf(
      { nodes: [{ username: 'mona', mergeRequestInteraction: { approved: false, reviewState: 'UNREVIEWED' } }] },
      { nodes: [] },
      { nodes: [note('mona', '2026-11-10T09:00:00Z', 'Why this way?'), note('ali', '2026-11-10T10:00:00Z', 'Because.')] },
    )
    expect(reviewers).toEqual([{ login: 'mona', state: 'requested', activeAt: '2026-11-10T09:00:00.000Z' }])
  })
  test('an approval note is when they reviewed', () => {
    const reviewers = glReviewersOf(
      { nodes: [{ username: 'jo', mergeRequestInteraction: { approved: true } }] },
      { nodes: [] },
      { nodes: [note('jo', '2026-11-10T08:00:00Z', 'approved this merge request', true), note('jo', '2026-11-10T07:00:00Z', 'nit')] },
    )
    expect(reviewers).toEqual([{ login: 'jo', state: 'approved', reviewedAt: '2026-11-10T08:00:00.000Z', activeAt: '2026-11-10T08:00:00.000Z' }])
  })
  test('label and assignment notes are nobody reviewing', () => {
    const reviewers = glReviewersOf({ nodes: [{ username: 'mona', mergeRequestInteraction: {} }] }, { nodes: [] }, { nodes: [note('mona', '2026-11-10T08:00:00Z', 'added ~bug label', true)] })
    expect(reviewers).toEqual([{ login: 'mona', state: 'requested' }])
  })
})

describe('GitLab: what the latest activity was', () => {
  test('a push says how many commits, an approval its verdict, a diff note its place', () => {
    expect(glActivityOf({ nodes: [note('ali', '2026-11-10T09:00:00Z', 'added 3 commits\n\n* abc', true)] }, null, null)).toMatchObject({ kind: 'commit', commits: 3 })
    expect(glActivityOf({ nodes: [note('jo', '2026-11-10T09:00:00Z', 'requested changes', true)] }, null, null)).toMatchObject({ kind: 'review', verdict: 'changes' })
    expect(glActivityOf({ nodes: [note('mona', '2026-11-10T09:00:00Z', 'Off by one?', false, { filePath: 'src/api.ts', newLine: 42, oldLine: null })] }, null, null)).toEqual({
      login: 'mona',
      at: '2026-11-10T09:00:00.000Z',
      kind: 'comment',
      path: 'src/api.ts',
      line: 42,
    })
    /* A note on a removed line has only the old line. */
    expect(glActivityOf({ nodes: [note('mona', '2026-11-10T09:00:00Z', 'Gone?', false, { filePath: 'a.ts', newLine: null, oldLine: 7 })] }, null, null)).toMatchObject({ line: 7 })
  })
})

describe('the row carries them', () => {
  test('through the protocol’s schema', () => {
    const r = trackerRowSchema.parse({
      ref: '!7',
      tracker: 'gitlab',
      host: 'gitlab.example.org',
      repo: 'group/repo',
      number: 7,
      kind: 'change',
      state: 'open',
      title: 'A change',
      url: 'https://gitlab.example.org/group/repo/-/merge_requests/7',
      readAt: '2026-11-10T10:00:00Z',
      reviewers: [{ login: 'mona', state: 'requested', activeAt: '2026-11-10T09:00:00.000Z' }],
      lastActivity: { login: 'mona', at: '2026-11-10T09:00:00.000Z', kind: 'comment', path: 'src/api.ts', line: 42 },
    })
    expect(r.reviewers?.[0]?.activeAt).toBe('2026-11-10T09:00:00.000Z')
    expect(r.lastActivity).toMatchObject({ path: 'src/api.ts', line: 42 })
  })
})
