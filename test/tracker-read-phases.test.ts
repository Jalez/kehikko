import { describe, expect, test } from 'bun:test'
import { LIMITS, type TrackerDetailFacts, type TrackerRow } from 'kehikot-module-protocol'

import type { Adapter, Read } from '../server/trackers/common.ts'
import { rowIdentity } from '../server/trackers/identity.ts'
import { boardsAfter, keptRows, mergeRows, notFoundAfter, readOutcome, sourcesAfter, trimToReads, wantedIdentities } from '../server/trackers/merge.ts'
import { detailFor, listHowFor, planRead, readAgain, WHOLE_EVERY_MS } from '../server/trackers/readPlan.ts'
import { readSource, type ReadAt } from '../server/trackers/readSources.ts'
import { sourceKey, type Source } from '../server/trackers/sources.ts'
import { READS_DEFAULT, readsKey } from '../src/host/trackerReads.ts'

/**
 * The phases of one tracker read, each on its own and without a tracker: what is asked of each
 * source (`readPlan.ts`), what one source's read comes to (`readSources.ts`, against an adapter
 * that answers from memory), and what that comes to beside what was held (`merge.ts`). The whole
 * read is held to in `trackers.test.ts` and `tracker-incremental.test.ts`.
 */

const NOW = '2026-10-05T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const DAY = 86_400_000
const gh: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko', default: true, listed: true }
const gl: Source = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'group/project', default: true, listed: true }
const other: Source = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko-protocol', default: false, listed: false }

const row = (source: Source, n: number, over: Partial<TrackerRow> = {}): TrackerRow =>
  ({
    ref: source.tracker === 'github' ? (source.default ? `gh#${n}` : `gh:${source.repo}#${n}`) : `#${n}`,
    tracker: source.tracker,
    host: source.host,
    repo: source.repo,
    number: n,
    kind: 'issue',
    state: 'open',
    title: `item ${n}`,
    url: '',
    labels: [],
    assignees: [],
    links: [],
    readAt: NOW,
    updatedAt: NOW,
    ...over,
  }) as TrackerRow
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString()
const byId = (rows: TrackerRow[]) => new Map(rows.map((r) => [rowIdentity(r), r]))

describe('what a read asks of each source', () => {
  test('a whole read lists every listed source; named refs go to their source, one entry per item', () => {
    const plan = planRead([gh, gl, other], ['gh#12', 'gh:Jalez/kehikko#12', '#3', '!3', 'gh:Jalez/kehikko-protocol#6', 'gh:nobody/here#1'], true)
    expect([...plan.values()].map((p) => [p.source.repo, p.list])).toEqual([
      ['Jalez/kehikko', true],
      ['group/project', true],
      ['Jalez/kehikko-protocol', false],
    ])
    /* One GitHub number is one item however it is spelled. */
    expect([...plan.get(sourceKey(gh))!.wanted.values()]).toEqual([{ number: 12, kind: null, refs: ['gh#12', 'gh:Jalez/kehikko#12'] }])
    /* A GitLab issue and change of one number are two. */
    expect([...plan.get(sourceKey(gl))!.wanted.values()].map((w) => [w.kind, w.number])).toEqual([
      ['issue', 3],
      ['change', 3],
    ])
    expect(plan.get(sourceKey(other))!.wanted.size).toBe(1)
  })

  test('a read of a few refs lists nothing', () => {
    const plan = planRead([gh], ['gh#1'], false)
    expect(plan.get(sourceKey(gh))!.list).toBe(false)
  })

  test('a listing asks only what changed after a recent whole one that read the same, from a little before it', () => {
    const was = { listedAt: ago(15 * 60_000), wholeAt: ago(DAY / 2), readsKey: readsKey(undefined) }
    expect(listHowFor(gh, was, NOW_MS, 'schedule')).toEqual({ reads: READS_DEFAULT, since: ago(17 * 60_000) })
    /* The person's Refresh all is whole. */
    expect(listHowFor(gh, was, NOW_MS, 'press').since).toBeNull()
    /* So is the first, one a day, and one after `reads` changed. */
    expect(listHowFor(gh, undefined, NOW_MS, 'schedule').since).toBeNull()
    expect(listHowFor(gh, { ...was, wholeAt: ago(WHOLE_EVERY_MS + 1) }, NOW_MS, 'schedule').since).toBeNull()
    expect(listHowFor(gh, { ...was, readsKey: 'issues|30' }, NOW_MS, 'schedule').since).toBeNull()
    /* And every listing of a source that reads everything every time. */
    expect(listHowFor({ ...gh, reads: { ...READS_DEFAULT, since: false } }, was, NOW_MS, 'schedule').since).toBeNull()
  })

  test('a held ref is read again by name only when the read cannot vouch for it', () => {
    const at = { whole: true, by: 'schedule' as const, nowMs: NOW_MS }
    const open = row(gh, 1)
    const running = row(gh, 2, { kind: 'change', pipeline: 'running' })
    const oldClosed = row(gh, 3, { state: 'closed', closedAt: ago(90 * DAY), updatedAt: ago(90 * DAY) })
    expect(readAgain(undefined, gh, true, at)).toBe(true)
    expect(readAgain(open, gh, true, at)).toBe(false)
    expect(readAgain(open, gh, false, at)).toBe(true)
    expect(readAgain(running, gh, true, at)).toBe(true)
    expect(readAgain(oldClosed, gh, false, at)).toBe(false)
    /* Everything, on Refresh all and on a read of a few refs. */
    expect(readAgain(oldClosed, gh, true, { ...at, by: 'press' })).toBe(true)
    expect(readAgain(oldClosed, gh, true, { ...at, whole: false })).toBe(true)
  })

  test('detail is read for the rows this read covers, not current, of a source that did not fail', () => {
    const current = row(gh, 2, { detail: { readAt: NOW } as TrackerDetailFacts })
    const rows = byId([row(gh, 1), current, row(gl, 5), row(gh, 9)])
    const need = detailFor(['gh#1', 'gh#2', '#5', 'gh#7', 'gh#9'], {
      refs: ['gh#1', 'gh#2', '#5', 'gh#7'],
      whole: false,
      sources: [gh, gl],
      rows,
      failed: (key) => key === sourceKey(gl),
    })
    expect([...need.keys()]).toEqual([sourceKey(gh)])
    expect(need.get(sourceKey(gh))!.rows.map((r) => r.ref)).toEqual(['gh#1'])
    /* A whole read covers every ref somebody asked the detail of. */
    const whole = detailFor(['gh#1', 'gh#9'], { refs: [], whole: true, sources: [gh], rows, failed: () => false })
    expect(whole.get(sourceKey(gh))!.rows.map((r) => r.ref)).toEqual(['gh#1', 'gh#9'])
  })
})

describe('what one source’s read comes to', () => {
  /** An adapter answering from memory, recording what it was asked. */
  function adapter(o: { list?: Read; refs?: Read; changed?: boolean | null }) {
    const asked = { list: 0, refs: [] as number[][], kept: 0 }
    const a: Adapter = {
      async list() {
        asked.list += 1
        return o.list ?? { ok: true, rows: [], notFound: [] }
      },
      async refs(_s, wanted) {
        asked.refs.push(wanted.map((w) => w.number))
        return o.refs ?? { ok: true, rows: [], notFound: [] }
      },
      async detail() {
        return new Map()
      },
      ...(o.changed !== undefined ? { changed: async () => ({ changed: o.changed!, keep: () => void (asked.kept += 1) }) } : {}),
    }
    return { a, asked }
  }
  const at = (over: Partial<ReadAt> = {}): ReadAt => ({
    whole: true,
    by: 'schedule',
    now: NOW,
    nowMs: NOW_MS,
    held: new Map(),
    listedBefore: new Map([[sourceKey(gh), { listedAt: ago(15 * 60_000), wholeAt: ago(DAY / 2), readsKey: readsKey(undefined) }]]),
    listLimit: 400,
    ...over,
  })

  test('nothing asked is nothing read', async () => {
    const { a, asked } = adapter({})
    expect(await readSource(a, planRead([gh], [], false).get(sourceKey(gh))!, at({ whole: false }))).toBeNull()
    expect(asked.list).toBe(0)
  })

  test('a probe that found nothing changed lists nothing, and a held named row is not read again', async () => {
    const { a, asked } = adapter({ changed: false })
    const held = byId([row(gh, 1)])
    const read = await readSource(a, planRead([gh], ['gh#1'], true).get(sourceKey(gh))!, at({ held }))
    expect(asked.list).toBe(0)
    expect(asked.refs).toEqual([])
    expect(read).toMatchObject({ error: null, failedOutright: false, listed: { since: true }, listedWhole: false, rows: [], gone: [] })
  })

  test('a listing that read cleanly keeps its probe; a named ref neither it nor the tracker has is gone', async () => {
    const { a, asked } = adapter({ changed: true, list: { ok: true, rows: [row(gh, 1)], notFound: [] } })
    const read = await readSource(a, planRead([gh], ['gh#1', 'gh#2'], true).get(sourceKey(gh))!, at({ listedBefore: new Map() }))
    expect(asked).toEqual({ list: 1, refs: [[2]], kept: 1 })
    expect(read).toMatchObject({ error: null, listed: { since: false }, listedWhole: true, gone: [rowIdentity(row(gh, 2))] })
    expect(read!.rows.map((r) => r.ref)).toEqual(['gh#1'])
  })

  test('a read by name that fails after a clean listing fails the source and brings no rows', async () => {
    const { a } = adapter({ changed: null, list: { ok: true, rows: [row(gh, 1)], notFound: [] }, refs: { ok: false, why: 'rate limited' } })
    const read = await readSource(a, planRead([gh], ['gh#2'], true).get(sourceKey(gh))!, at({ listedBefore: new Map() }))
    expect(read).toMatchObject({ error: 'rate limited', failedOutright: true, listedWhole: true, rows: [], gone: [] })
  })

  test('refs the tracker would not answer are thin, not gone, and say why', async () => {
    const { a } = adapter({ refs: { ok: true, rows: [], notFound: [], unread: { why: 'timed out', refs: [{ number: 3, kind: null }] } } })
    const read = await readSource(a, planRead([gh], ['gh#3'], false).get(sourceKey(gh))!, at({ whole: false }))
    expect(read).toMatchObject({ error: 'timed out', failedOutright: false, thin: [rowIdentity(row(gh, 3))], gone: [] })
  })
})

describe('what a read comes to beside what was held', () => {
  test('every identity somebody names, asked now or before', () => {
    const plan = planRead([gh, gl], ['gh#1'], false)
    expect([...wantedIdentities(plan, ['#4', 'gh:nobody/here#1'], [gh, gl])]).toEqual([rowIdentity(row(gh, 1)), rowIdentity(row(gl, 4))])
  })

  test('fresh rows replace theirs; a whole listing drops what it no longer names; a source no longer read takes its rows', () => {
    const detail = { readAt: NOW } as TrackerDetailFacts
    const held = [row(gh, 1, { detail }), row(gh, 2), row(gh, 3, { title: 'held', labels: ['kept'] }), row(gl, 1), row(other, 1)]
    const { labels: _unsaid, ...thin } = row(gh, 3, { title: 'thin' })
    const fresh = [row(gh, 1, { title: 'new' }), thin as TrackerRow]
    const merged = mergeRows(held, fresh, {
      sources: [gh, gl],
      listedNow: new Set([sourceKey(gh)]),
      wanted: new Set([rowIdentity(row(gh, 1)), rowIdentity(row(gh, 3))]),
      thin: new Set([rowIdentity(row(gh, 3))]),
    })
    expect([...merged.values()].map((r) => [r.ref, r.repo, r.title])).toEqual([
      ['gh#1', 'Jalez/kehikko', 'new'],
      ['gh#3', 'Jalez/kehikko', 'thin'],
      ['#1', 'group/project', 'item 1'],
    ])
    /* An earlier detail survives a summary read of the same version; a thin row keeps what it did not say. */
    expect(merged.get(rowIdentity(row(gh, 1)))!.detail).toEqual(detail)
    expect(merged.get(rowIdentity(row(gh, 3)))!.labels).toEqual(['kept'])
  })

  test('a cleanly listed source loses what its reads leave out, and one of what changed is cut to a listing', () => {
    const oldClosed = row(gl, 1, { state: 'closed', closedAt: ago(90 * DAY), updatedAt: ago(90 * DAY) })
    const named = row(gl, 2, { state: 'closed', closedAt: ago(90 * DAY), updatedAt: ago(90 * DAY) })
    const recent = [3, 4, 5].map((n) => row(gl, n, { updatedAt: ago(n * 60_000) }))
    const ghOld = row(gh, 1, { state: 'closed', closedAt: ago(90 * DAY), updatedAt: ago(90 * DAY) })
    const rows = byId([oldClosed, named, ...recent, ghOld])
    const trimmed = trimToReads(rows, {
      sources: [gh, gl],
      listedHow: new Map([[sourceKey(gl), { since: true }]]),
      wanted: new Set([rowIdentity(named)]),
      nowMs: NOW_MS,
      listLimit: 2,
    })
    /* gh did not list cleanly: it keeps everything. Order is the order held. */
    expect([...trimmed.values()].map((r) => r.ref)).toEqual(['#2', '#3', '#4', 'gh#1'])
    /* What it was handed is not changed. */
    expect(rows.size).toBe(6)
  })

  test('room goes to every named row first, then the newest updated', () => {
    const many = Array.from({ length: LIMITS.TRACKER_ROWS + 2 }, (_, i) => row(gh, i + 1, { updatedAt: ago((i + 1) * 60_000) }))
    const oldest = many.at(-1)!
    const kept = keptRows(many, new Set([rowIdentity(oldest)]))
    expect(kept).toHaveLength(LIMITS.TRACKER_ROWS)
    expect(kept.at(-1)).toBe(oldest)
    expect(kept.map((r) => r.number)).not.toContain(LIMITS.TRACKER_ROWS + 1)
    expect(keptRows(many.slice(0, 3), new Set())).toHaveLength(3)
  })

  test('gone is what was gone and not read since, and what this read found gone', () => {
    expect([...notFoundAfter(['a', rowIdentity(row(gh, 1))], [row(gh, 1)], new Set(['b']))]).toEqual(['a', 'b'])
  })

  test('a listing replaces a source’s boards, a read by name adds to them, an unreadable one says why', () => {
    const board = (name: string) => ({ board: name, columns: [] })
    const held = [
      { source: sourceKey(gh), boards: [board('Old')], unreadable: null },
      { source: sourceKey(gl), boards: [board('Kept')], unreadable: null },
    ]
    const byName = boardsAfter([gh, gl, other], held, new Map([[sourceKey(gh), { boards: [board('New')] }], [sourceKey(other), { unreadable: 'no read:project' }]]), new Set())
    expect(byName.map((b) => [b.source, b.boards.map((x) => x.board), b.unreadable])).toEqual([
      [sourceKey(gh), ['New', 'Old'], null],
      [sourceKey(gl), ['Kept'], null],
      [sourceKey(other), [], 'no read:project'],
    ])
    const listed = boardsAfter([gh], held, new Map([[sourceKey(gh), { boards: [board('New')] }]]), new Set([sourceKey(gh)]))
    expect(listed[0]!.boards.map((x) => x.board)).toEqual(['New'])
  })

  test('each source’s line: read cleanly now, failed with its sentence, or as it was when not asked', () => {
    const was = { tracker: 'gitlab' as const, host: gl.host, repo: gl.repo, default: true, listed: true, at: ago(DAY), error: null, listedAt: ago(DAY), wholeAt: ago(DAY), readsKey: 'x' }
    const lines = sourcesAfter([gh, gl, other], [was], {
      errors: new Map<string, string | null>([
        [sourceKey(gh), null],
        [sourceKey(other), 'rate limited'],
      ]),
      listedHow: new Map([[sourceKey(gh), { since: false }]]),
      now: NOW,
    })
    expect(lines).toEqual([
      { tracker: 'github', host: gh.host, repo: gh.repo, default: true, listed: true, at: NOW, error: null, listedAt: NOW, wholeAt: NOW, readsKey: readsKey(undefined) },
      was,
      { tracker: 'github', host: other.host, repo: other.repo, default: false, listed: false, at: null, error: 'rate limited' },
    ])
  })

  test('the read answers failed with every failed source’s sentence', () => {
    expect(readOutcome(new Map([[sourceKey(gh), null]]), NOW)).toEqual({ outcome: 'read', at: NOW, why: '' })
    expect(
      readOutcome(
        new Map<string, string | null>([
          [sourceKey(gh), 'rate limited'],
          [sourceKey(gl), 'gone'],
        ]),
        NOW,
      ),
    ).toEqual({ outcome: 'failed', at: NOW, why: 'github.com/jalez/kehikko: rate limited gitlab.example.org/group/project: gone' })
  })
})
