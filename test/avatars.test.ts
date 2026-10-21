import { describe, expect, test } from 'bun:test'
import { LIMITS, trackerRowSchema } from 'kehikot-module-protocol'

import { avatarOf, peopleOf } from '../server/trackers/common.ts'
import { issueRow as ghIssueRow, listQuery, pullRow, refsQuery as ghRefsQuery } from '../server/trackers/github.ts'
import { BATCH, issueRow as glIssueRow, mergeRow, refsQuery as glRefsQuery } from '../server/trackers/gitlab.ts'
import type { Source } from '../server/trackers/sources.ts'

/**
 * Faces (protocol 2.10.0): a row's `people` map gives each login it names a
 * display name and an absolute `https:` picture, read in the queries the host
 * already makes. The answers are in the shapes GitHub and GitLab give; nothing
 * here reaches either.
 */

const NOW = '2026-10-21T12:00:00.000Z'
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }
const face = (id: number) => `https://avatars.githubusercontent.com/u/${id}?s=48&v=4`

describe('an avatar URL', () => {
  test('an absolute https: one is kept as it is', () => {
    expect(avatarOf({ avatarUrl: face(1) }, 'github.com')).toBe(face(1))
    expect(avatarOf({ avatar_url: 'https://secure.gravatar.com/avatar/abc?s=80&d=identicon' }, 'gitlab.com')).toBe(
      'https://secure.gravatar.com/avatar/abc?s=80&d=identicon',
    )
  })
  test('a GitLab-relative path is made absolute against the source host', () => {
    expect(avatarOf({ avatarUrl: '/uploads/-/system/user/avatar/7/me.png' }, 'gitlab.example.org')).toBe(
      'https://gitlab.example.org/uploads/-/system/user/avatar/7/me.png',
    )
  })
  test('http:, data:, javascript: and one too long are left out', () => {
    expect(avatarOf({ avatarUrl: 'http://gitlab.example.org/a.png' }, 'gitlab.example.org')).toBeUndefined()
    expect(avatarOf({ avatarUrl: 'data:image/png;base64,AAAA' }, 'github.com')).toBeUndefined()
    expect(avatarOf({ avatarUrl: 'javascript:alert(1)' }, 'github.com')).toBeUndefined()
    expect(avatarOf({ avatarUrl: `https://a.example/${'x'.repeat(LIMITS.URL)}` }, 'github.com')).toBeUndefined()
    expect(avatarOf({}, 'github.com')).toBeUndefined()
  })
})

describe('peopleOf', () => {
  test('keeps only the logins the row names, filling one person in from two objects', () => {
    const people = peopleOf(
      { authorLogin: 'Jalez', assigneeLogins: ['mona'], reviewers: [{ login: 'hubot', state: 'requested' }] },
      [
        { login: 'jalez', avatarUrl: face(1) },
        { login: 'Jalez', fullName: 'Jaakko Rajala' },
        { login: 'mona', name: 'Mona Lisa', avatarUrl: face(2) },
        { login: 'hubot' },
        { login: 'stranger', avatarUrl: face(9) },
      ],
      'github.com',
    )
    expect(people).toEqual({
      Jalez: { name: 'Jaakko Rajala', avatarUrl: face(1) },
      mona: { name: 'Mona Lisa', avatarUrl: face(2) },
    })
  })
  test('is undefined when nothing is known of anybody', () => {
    expect(peopleOf({ authorLogin: 'x' }, [{ login: 'x' }], 'github.com')).toBeUndefined()
  })
})

describe('GitHub', () => {
  test('every person in the queries is asked for a 48px picture; the author keeps its login as `author`', () => {
    for (const q of [ghRefsQuery(gh, [1]), listQuery(gh, { issues: null, pulls: null })]) {
      expect(q).toContain('author { login avatarUrl(size: 48) ... on User { fullName: name } }')
      expect(q).toContain('assignees(first: 16) { nodes { login name avatarUrl(size: 48) } }')
      expect(q).toContain('... on User { login name avatarUrl(size: 48) } ... on Bot { login avatarUrl(size: 48) } ... on Mannequin { login avatarUrl(size: 48) }')
      expect(q).toContain('latestReviews(first: 32) { nodes { state author { login avatarUrl(size: 48) ... on User { name } } } }')
      expect(q).toContain('actor { login avatarUrl(size: 48) }')
      expect(q).not.toMatch(/author \{ login \}/)
    }
  })

  test('a pull request row carries people for its author, assignees, reviewers and last actor', () => {
    const r = pullRow(
      gh,
      {
        number: 41,
        state: 'OPEN',
        title: 'Faces',
        url: 'https://github.com/Jalez/kehikko/pull/41',
        author: { login: 'Jalez', avatarUrl: face(1), fullName: 'Jaakko Rajala' },
        assignees: { nodes: [{ login: 'mona', name: 'Mona Lisa', avatarUrl: face(2) }] },
        reviewRequests: { nodes: [{ requestedReviewer: { login: 'dependabot', avatarUrl: face(3) } }] },
        latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'octo', avatarUrl: face(4), name: 'Octo Cat' } }] },
        timelineItems: { nodes: [{ __typename: 'IssueComment', createdAt: NOW, author: { login: 'nina', avatarUrl: face(5) } }] },
      },
      NOW,
    )!
    expect(r.author).toBe('Jalez')
    expect(r.people).toEqual({
      Jalez: { name: 'Jaakko Rajala', avatarUrl: face(1) },
      mona: { name: 'Mona Lisa', avatarUrl: face(2) },
      dependabot: { avatarUrl: face(3) },
      octo: { name: 'Octo Cat', avatarUrl: face(4) },
      nina: { avatarUrl: face(5) },
    })
    expect(trackerRowSchema.safeParse(r).success).toBe(true)
  })

  test('an issue with a bad picture keeps its row and loses only the picture', () => {
    const r = ghIssueRow(
      gh,
      {
        number: 7,
        state: 'OPEN',
        title: 'An issue',
        url: 'https://github.com/Jalez/kehikko/issues/7',
        author: { login: 'Jalez', avatarUrl: 'http://evil.example/a.png' },
        assignees: { nodes: [{ login: 'mona', avatarUrl: face(2) }] },
      },
      NOW,
    )!
    expect(r).not.toBeNull()
    expect(r.people).toEqual({ mona: { avatarUrl: face(2) } })
  })

  test('a row read without any people answers no map', () => {
    const r = ghIssueRow(gh, { number: 8, state: 'OPEN', title: 't', url: 'https://github.com/x/y/issues/8' }, NOW)!
    expect(r.people).toBeUndefined()
  })
})

describe('GitLab', () => {
  test('the by-iid query asks for pictures with the people, and not of a GitLab without them', () => {
    const q = glRefsQuery(gl, [1], [8])
    expect(q).toContain('assignees { nodes { name username avatarUrl } } author { name username avatarUrl }')
    expect(q).toContain('approvedBy(first: 32) { nodes { username name avatarUrl } }')
    expect(q).toContain('createdAt author { username avatarUrl } } }')
    expect(glRefsQuery(gl, [1], [8], false)).not.toContain('avatarUrl')
  })

  test('a batch is 22 + 22: what keeps it under the complexity limit with the pictures', () => {
    expect(BATCH).toBe(22)
  })

  test('a GraphQL merge request makes a relative picture absolute against the source host', () => {
    const r = mergeRow(
      gl,
      {
        iid: '9',
        state: 'opened',
        title: 'Faces',
        webUrl: 'https://gitlab.example.org/group/project/-/merge_requests/9',
        author: { username: 'eread', name: 'Evan Read', avatarUrl: '/uploads/-/system/user/avatar/7/e.png' },
        assignees: { nodes: [] },
        reviewers: {
          nodes: [
            {
              username: 'ann',
              name: 'Ann',
              avatarUrl: 'https://secure.gravatar.com/avatar/abc?s=80&d=identicon',
              mergeRequestInteraction: { approved: false, reviewState: 'UNREVIEWED' },
            },
          ],
        },
        approvedBy: { nodes: [] },
        notes: { nodes: [] },
      },
      NOW,
    )!
    expect(r.people).toEqual({
      eread: { name: 'Evan Read', avatarUrl: 'https://gitlab.example.org/uploads/-/system/user/avatar/7/e.png' },
      ann: { name: 'Ann', avatarUrl: 'https://secure.gravatar.com/avatar/abc?s=80&d=identicon' },
    })
  })

  test('a REST issue reads `avatar_url`', () => {
    const r = glIssueRow(
      gl,
      {
        iid: 3,
        state: 'opened',
        title: 'REST',
        web_url: 'https://gitlab.example.org/group/project/-/issues/3',
        author: { username: 'bob', name: 'Bob', avatar_url: 'https://gitlab.example.org/uploads/b.png' },
        assignees: [{ username: 'ann', name: 'Ann', avatar_url: null }],
      },
      NOW,
    )!
    expect(r.people).toEqual({
      bob: { name: 'Bob', avatarUrl: 'https://gitlab.example.org/uploads/b.png' },
      ann: { name: 'Ann' },
    })
  })
})
