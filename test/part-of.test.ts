import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { trackerReadingResult, type TrackerRow } from 'kehikot-module-protocol'
import { dispositionOf } from 'kehikot-module-protocol/facets'

import type { Ran, Runner } from '../server/feedback.ts'
import { trackerLine } from '../server/mcp.ts'
import type { Adapter, Wanted } from '../server/trackers/common.ts'
import { closingIssues, contributedIssues, withContributors } from '../server/trackers/common.ts'
import { githubAdapter, issueRow, linkClosers, pullRow } from '../server/trackers/github.ts'
import { gitlabAdapter, issueRow as glIssueRow, linkDeclarers, mergeRow } from '../server/trackers/gitlab.ts'
import { Trackers } from '../server/trackers/reading.ts'
import type { Source } from '../server/trackers/sources.ts'

/**
 * Jalez/kehikko#187: a merge request that says "Part of #N" delivers part of #N
 * and does not close it. Fixtures shaped like the forges' answers, after the
 * two cases seen on a real GitLab: !3907 says "Part of #3912" (GitLab's
 * `closed_by` for #3912 is empty), !3251 says "Closes #2638" (its `closed_by`
 * is [3251]). Nothing here reaches GitHub or GitLab.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-part-of-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const NOW = '2026-10-26T12:00:00.000Z'
const ok = (out: unknown): Ran => ({ code: 0, out: JSON.stringify(out), err: '' })
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }

function runner(answers: Array<[string, Ran]>): Runner {
  return (async (argv: string[]) => {
    const line = argv.join(' ')
    for (const [start, ran] of answers) if (line.startsWith(start)) return ran
    return { code: 1, out: '', err: `nothing answers ${line}` }
  }) as Runner
}

/** GitLab's REST answers for the four refs, as `glab api` hands them over. */
const GL_ISSUES = [
  { iid: 3912, state: 'opened', title: 'Partly delivered', web_url: 'https://gitlab.example.org/group/project/-/issues/3912', labels: [], assignees: [] },
  { iid: 2638, state: 'closed', title: 'Delivered', web_url: 'https://gitlab.example.org/group/project/-/issues/2638', labels: [], assignees: [], closed_at: '2026-10-20T00:00:00Z' },
]
const GL_MERGES = [
  { iid: 3907, state: 'merged', title: 'One part', description: 'Part of #3912', web_url: 'https://gitlab.example.org/group/project/-/merge_requests/3907', merged_at: '2026-10-25T00:00:00Z' },
  { iid: 3251, state: 'merged', title: 'The whole', description: 'Closes #2638', web_url: 'https://gitlab.example.org/group/project/-/merge_requests/3251', merged_at: '2026-10-20T00:00:00Z' },
]

const byRef = (rows: TrackerRow[]) => new Map(rows.map((r) => [r.ref, r]))

describe('the words', () => {
  test('closing keywords close; "part of", "implements" and "contributes to" contribute', () => {
    const text = 'Closes #12 and #13. Part of #2274; implements #40, contributes to #41; mentions #99 in passing'
    expect(closingIssues(text)).toEqual([12, 13])
    expect(contributedIssues(text)).toEqual([2274, 40, 41])
  })

  test('an issue a change both closes and is part of is closed, and not also contributed to', () => {
    expect(closingIssues('Part of #5. Fixes #5')).toEqual([5])
    expect(contributedIssues('Part of #5. Fixes #5')).toEqual([])
  })
})

describe('GitLab', () => {
  test('!3907 "Part of #3912" contributes; !3251 "Closes #2638" closes, as before', () => {
    const partial = mergeRow(gl, GL_MERGES[0], NOW)!
    expect(partial.links).toEqual([])
    expect(partial.contributes).toEqual(['#3912'])
    const closing = mergeRow(gl, GL_MERGES[1], NOW)!
    expect(closing.links).toEqual([{ ref: '#2638', relation: 'closes' }])
    expect(closing.contributes).toBeUndefined()
  })

  test('the listing: #3912 has a contribution and is not closed by merge; #2638 is closed by !3251', async () => {
    const run = runner([
      ['glab api --hostname gitlab.example.org projects/group%2Fproject/issues', ok(GL_ISSUES)],
      ['glab api --hostname gitlab.example.org projects/group%2Fproject/merge_requests', ok(GL_MERGES)],
    ])
    const read = await gitlabAdapter(run).list(gl, 100, NOW)
    if (!read.ok) throw new Error(read.why)
    const rows = byRef(read.rows)
    const partly = rows.get('#3912')!
    expect(partly.links).toEqual([])
    expect(partly.contributedBy).toEqual(['!3907'])
    expect(partly.closedByMerge).toBeUndefined()
    expect(dispositionOf('#3912', partly, []).value).toBeNull()
    const done = rows.get('#2638')!
    expect(done.links).toEqual([{ ref: '!3251', relation: 'closed-by' }])
    expect(done.contributedBy).toBeUndefined()
    expect(done.closedByMerge).toBe(true)
    expect(dispositionOf('#2638', done, []).value).toBe('done')
    /* Every row still fits the protocol's answer. */
    expect(trackerReadingResult.safeParse({ rows: read.rows }).success).toBe(true)
  })

  test('read_tracker says the tie from both sides, and never as closing', async () => {
    const rows = byRef(linkDeclarers([...GL_ISSUES.map(glIssue), ...GL_MERGES.map((m) => mergeRow(gl, m, NOW)!)]))
    expect(trackerLine(rows.get('!3907')!)).toContain('[contributes to #3912]')
    expect(trackerLine(rows.get('#3912')!)).toContain('[has contributions from !3907]')
    expect(trackerLine(rows.get('!3907')!)).not.toContain('closes')
    expect(trackerLine(rows.get('#3912')!)).not.toContain('closed-by')
    expect(trackerLine(rows.get('!3251')!)).toContain('[closes #2638]')
    expect(trackerLine(rows.get('#2638')!)).toContain('[closed-by !3251]')
  })
})

/** GitLab's issue rows, through the adapter's own reader. */
const glIssue = (raw: unknown): TrackerRow => glIssueRow(gl, raw, NOW)!

describe('GitHub', () => {
  const issue = (number: number, state: 'OPEN' | 'CLOSED', closers: Array<{ number: number; merged: boolean }> = []) => ({
    number,
    state,
    stateReason: state === 'CLOSED' ? 'COMPLETED' : null,
    title: `issue ${number}`,
    url: `https://github.com/Jalez/kehikko/issues/${number}`,
    closedByPullRequestsReferences: { nodes: closers },
  })
  const pull = (number: number, body: string, closing: number[]) => ({
    number,
    state: 'MERGED',
    title: `pull ${number}`,
    url: `https://github.com/Jalez/kehikko/pull/${number}`,
    body,
    mergedAt: '2026-10-25T00:00:00Z',
    closingIssuesReferences: { nodes: closing.map((n) => ({ number: n })) },
  })

  test('a pull request that is "Part of #3912" contributes; GitHub’s closing references close', () => {
    const partial = pullRow(gh, pull(3907, 'Part of #3912', []), NOW)!
    expect(partial.links).toEqual([])
    expect(partial.contributes).toEqual(['gh#3912'])
    const closing = pullRow(gh, pull(3251, 'Closes #2638', [2638]), NOW)!
    expect(closing.links).toEqual([{ ref: 'gh#2638', relation: 'closes' }])
    expect(closing.contributes).toBeUndefined()
  })

  test('the forge’s closing list wins over the words: a closing reference is never also a contribution', () => {
    const both = pullRow(gh, pull(5, 'Part of #6', [6]), NOW)!
    expect(both.links).toEqual([{ ref: 'gh#6', relation: 'closes' }])
    expect(both.contributes).toBeUndefined()
  })

  test('without a body nothing is said about contributions', () => {
    const { body: _, ...bare } = pull(3907, '', [])
    expect(pullRow(gh, bare, NOW)!.contributes).toBeUndefined()
  })

  test('the issues: #3912 has a contribution and is not closed by merge; #2638 is', () => {
    const rows = byRef(linkClosers([
      issueRow(gh, issue(3912, 'OPEN'), NOW)!,
      issueRow(gh, issue(2638, 'CLOSED', [{ number: 3251, merged: true }]), NOW)!,
      pullRow(gh, pull(3907, 'Part of #3912', []), NOW)!,
      pullRow(gh, pull(3251, 'Closes #2638', [2638]), NOW)!,
    ]))
    const partly = rows.get('gh#3912')!
    expect(partly.contributedBy).toEqual(['gh#3907'])
    expect(partly.links).toEqual([])
    expect(partly.closedByMerge).toBeUndefined()
    const done = rows.get('gh#2638')!
    expect(done.links).toEqual([{ ref: 'gh#3251', relation: 'closed-by' }])
    expect(done.closedByMerge).toBe(true)
    expect(done.contributedBy).toBeUndefined()
  })

  test('the pull request query asks for the body', async () => {
    const asked: string[] = []
    const run = (async (argv: string[]) => {
      asked.push(argv.join(' '))
      return { code: 1, out: '', err: 'no' }
    }) as Runner
    await githubAdapter(run).refs(gh, [{ number: 3907, kind: 'change' }], NOW)
    expect(asked.some((line) => /PullRequest \{ number state title url body /.test(line))).toBe(true)
  })
})

describe('the mirror', () => {
  const row = (ref: string, kind: 'issue' | 'change', over: Partial<TrackerRow> = {}): TrackerRow => ({
    ref, tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', number: Number(ref.slice(1)), kind, state: 'open',
    title: ref, url: 'u', labels: [], assignees: [], links: [], readAt: NOW, ...over,
  })

  test('a held change that stops contributing is taken off; one the rows do not hold is kept', () => {
    const rows = withContributors([
      row('#1', 'issue', { contributedBy: ['!2', '!3'] }),
      row('!2', 'change'),
    ])
    expect(rows[0]!.contributedBy).toEqual(['!3'])
  })

  test('never touches links or closedByMerge', () => {
    const rows = withContributors([row('#1', 'issue'), row('!2', 'change', { state: 'merged', contributes: ['#1'] })])
    expect(rows[0]!.contributedBy).toEqual(['!2'])
    expect(rows[0]!.links).toEqual([])
    expect('closedByMerge' in rows[0]!).toBe(false)
  })
})

/** A fake adapter that hands back the rows it is told to. */
function fake(rows: TrackerRow[]): Adapter {
  return {
    async list(source: Source) {
      return { ok: true as const, rows: rows.filter((r) => r.repo === source.repo), notFound: [] }
    },
    async refs(source: Source, wanted: readonly Wanted[]) {
      return { ok: true as const, rows: rows.filter((r) => r.repo === source.repo && wanted.some((w) => w.number === r.number)), notFound: [] }
    },
    async detail() {
      return new Map()
    },
  }
}

describe('an epic’s issues come with the changes that are part of them', () => {
  const remotes = runner([['git -C', { code: 0, out: 'origin\thttps://gitlab.example.org/group/project.git (fetch)', err: '' }]])
  const epicFile = (epic: object) => {
    mkdirSync(join(folder, '.kehikot', 'host', 'epics'), { recursive: true })
    writeFileSync(join(folder, '.kehikot', 'host', 'epics', 'one.json'), JSON.stringify({ slug: 'one', title: 'One', ...epic }))
  }

  test('!3907 is answered with #3912, which the epic names; !3251 is not, as before', async () => {
    epicFile({ steps: [{ title: 's', refs: ['#3912', '#2638'] }] })
    const rows = [
      ...GL_ISSUES.map(glIssue),
      ...GL_MERGES.map((m) => mergeRow(gl, m, NOW)!),
    ]
    const trackers = new Trackers({ run: remotes, adapters: { gitlab: fake(rows) }, now: () => new Date(NOW) })
    await trackers.refresh(folder, { project: true })
    const got = trackers.get(folder, { epic: 'one' })
    if ('refused' in got) throw new Error(got.refused)
    const refs = got.rows.map((r) => r.ref)
    expect(refs).toEqual(['#3912', '#2638', '!3907'])
    const partial = got.rows.find((r) => r.ref === '!3907')!
    expect(partial.contributes).toEqual(['#3912'])
    expect(got.rows.find((r) => r.ref === '#3912')!.closedByMerge).toBeUndefined()
    /* Asked by name, a ref is answered as itself only. */
    const named = trackers.get(folder, { refs: ['#3912'] })
    if ('refused' in named) throw new Error(named.refused)
    expect(named.rows.map((r) => r.ref)).toEqual(['#3912'])
    /* And live.get's maps still say only which change delivers which issue. */
    const live = trackers.live(folder, 'one')!
    expect(live.links).toEqual({ '2638': [3251] })
  })
})
