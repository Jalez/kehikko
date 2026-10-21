import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrackerRow } from 'kehikot-module-protocol'

import { ensureSettings, settingsRoute } from '../server/agentSettings.ts'
import { open } from '../server/canvases.ts'
import type { Ran, Runner } from '../server/feedback.ts'
import { Inbox } from '../server/inbox.ts'
import { addProject } from '../server/projects.ts'
import { readNotices, TrackerNotices, writeNotices } from '../server/trackerNotices.ts'
import type { Adapter, Wanted } from '../server/trackers/common.ts'
import { epicsByRef, Trackers } from '../server/trackers/reading.ts'
import type { Source } from '../server/trackers/sources.ts'
import { planGo } from '../src/host/goToPlace.ts'
import { isLive } from '../src/host/inbox.ts'
import {
  DEFAULT_NOTICES,
  factsOf,
  happenings,
  itemId,
  noticeItem,
  noticesPatched,
  noticesStored,
  TRACKER_NOTICES_MODULE,
  type Seen,
} from '../src/host/trackerNotices.ts'

/**
 * Tracker notices: what happened on the person's issues and changes between
 * two readings, told in the Inbox as the host's own items, one per ref.
 * Scratch databases and folders; fake trackers — nothing reaches a forge.
 */

const T0 = 1_800_000_000_000
const ME = 'jaakko'

const gh = (number: number, over: Partial<TrackerRow> = {}): TrackerRow => ({
  ref: `gh#${number}`,
  tracker: 'github',
  host: 'github.com',
  repo: 'Jalez/kehikko',
  number,
  kind: 'change',
  state: 'open',
  title: `change ${number}`,
  url: `https://github.com/Jalez/kehikko/pull/${number}`,
  labels: [],
  assignees: [],
  links: [],
  authorLogin: ME,
  myRoles: ['author'],
  reviewers: [],
  updatedAt: new Date(T0 - 60_000).toISOString(),
  readAt: new Date(T0).toISOString(),
  ...over,
})

const gl = (number: number, over: Partial<TrackerRow> = {}): TrackerRow => ({
  ...gh(number),
  ref: `!${number}`,
  tracker: 'gitlab',
  host: 'gitlab.example.org',
  repo: 'group/sub/project',
  url: `https://gitlab.example.org/group/sub/project/-/merge_requests/${number}`,
  ...over,
})

const at = (ms: number) => new Date(ms).toISOString()

/** A Seen as the store would hold it after a reading of `row` at `when`. */
const seenOf = (row: TrackerRow, when = T0, over: Partial<Seen> = {}): Seen => ({
  id: itemId(row),
  ref: row.ref,
  title: row.title,
  facts: factsOf(row),
  events: [],
  since: null,
  at: when,
  ...over,
})

const kinds = (list: { kind: string; by?: string }[]) => list.map((one) => (one.by ? `${one.kind}:${one.by}` : one.kind))

describe('what changed between two readings', () => {
  const NOW = T0 + 600_000
  const LAST = T0

  test('approved and changes requested, reviewer by reviewer (GitHub and GitLab)', () => {
    for (const make of [gh, gl]) {
      const was = make(7, { reviewers: [{ login: 'mona', state: 'requested' }, { login: 'bob', state: 'requested' }] })
      const now = make(7, { reviewers: [{ login: 'mona', state: 'approved' }, { login: 'bob', state: 'changes' }] })
      expect(kinds(happenings(seenOf(was), now, ME, NOW, LAST))).toEqual(['approved:mona', 'changes-requested:bob'])
    }
  })

  test('without reviewers, the change’s own review state, attributed by its last activity', () => {
    const was = gl(7, { reviewers: undefined, review: 'required' })
    const now = gl(7, { reviewers: undefined, review: 'approved', lastActivity: { login: 'mona', at: at(NOW - 5), kind: 'review', mine: false } })
    expect(kinds(happenings(seenOf(was), now, ME, NOW, LAST))).toEqual(['approved:mona'])
  })

  test('your review requested: when you were added, not when you already were', () => {
    const was = gh(8, { authorLogin: 'mona', myRoles: [], reviewers: [] })
    const now = gh(8, { authorLogin: 'mona', myRoles: ['reviewer-asked'], reviewers: [{ login: ME, state: 'requested' }] })
    expect(kinds(happenings(seenOf(was), now, ME, NOW, LAST))).toEqual(['review-requested'])
    expect(happenings(seenOf(now), now, ME, NOW, LAST)).toEqual([])
  })

  test('somebody else commented; your own comment is not told, nor one whose author is unknown', () => {
    const was = gh(9, { lastActivity: { login: ME, at: at(T0 - 10), kind: 'comment', mine: true } })
    const theirs = gh(9, { lastActivity: { login: 'mona', at: at(T0 + 10), kind: 'comment', mine: false } })
    expect(kinds(happenings(seenOf(was), theirs, ME, NOW, LAST))).toEqual(['commented:mona'])
    const mine = gh(9, { lastActivity: { login: ME, at: at(T0 + 10), kind: 'comment', mine: true } })
    expect(happenings(seenOf(was), mine, ME, NOW, LAST)).toEqual([])
    const unknown = gh(9, { lastActivity: { login: 'mona', at: at(T0 + 10), kind: 'comment' } })
    expect(happenings(seenOf(was), unknown, null, NOW, LAST)).toEqual([])
    /* An approval is one event, not an approval and a comment. */
    const review = gh(9, { reviewers: [{ login: 'mona', state: 'approved' }], lastActivity: { login: 'mona', at: at(T0 + 10), kind: 'review', mine: false } })
    expect(kinds(happenings(seenOf(was), review, ME, NOW, LAST))).toEqual(['approved:mona'])
  })

  test('merged, closed and reopened; not when you did it', () => {
    const open = gl(10)
    const merged = gl(10, { state: 'merged', lastActivity: { login: 'mona', at: at(T0 + 1), kind: 'state', mine: false } })
    expect(kinds(happenings(seenOf(open), merged, ME, NOW, LAST))).toEqual(['merged:mona'])
    const closed = gh(11, { kind: 'issue', state: 'closed', reviewers: undefined })
    expect(kinds(happenings(seenOf(gh(11, { kind: 'issue', reviewers: undefined })), closed, ME, NOW, LAST))).toEqual(['closed'])
    expect(kinds(happenings(seenOf(closed), gh(11, { kind: 'issue', reviewers: undefined }), ME, NOW, LAST))).toEqual(['reopened'])
    const mine = gl(10, { state: 'merged', lastActivity: { login: ME, at: at(T0 + 1), kind: 'state', mine: true } })
    expect(happenings(seenOf(open), mine, ME, NOW, LAST)).toEqual([])
  })

  test('new commits only on a change you review, pushed by somebody else', () => {
    const base = { authorLogin: 'mona', reviewers: [{ login: ME, state: 'commented' as const }], myRoles: ['reviewer-done' as const] }
    const was = gh(12, { ...base, lastPushAt: at(T0 - 100) })
    const now = gh(12, { ...base, lastPushAt: at(T0 + 100), lastActivity: { login: 'mona', at: at(T0 + 100), kind: 'commit', mine: false } })
    expect(kinds(happenings(seenOf(was), now, ME, NOW, LAST))).toEqual(['pushed:mona'])
    /* Your own change: a push is yours, never told. */
    const own = gh(13, { lastPushAt: at(T0 - 100) })
    expect(happenings(seenOf(own), gh(13, { lastPushAt: at(T0 + 100) }), ME, NOW, LAST)).toEqual([])
  })

  test('your own review is not an event', () => {
    const was = gh(14, { authorLogin: 'mona', myRoles: ['reviewer-asked'], reviewers: [{ login: ME, state: 'requested' }] })
    const now = gh(14, { authorLogin: 'mona', myRoles: ['reviewer-done'], reviewers: [{ login: ME, state: 'approved' }] })
    expect(happenings(seenOf(was), now, ME, NOW, LAST)).toEqual([])
  })

  test('the first reading tells nothing; a new item tells only a review newly asked of you', () => {
    const now = gh(15, { authorLogin: 'mona', myRoles: ['reviewer-asked'], reviewers: [{ login: ME, state: 'requested' }], updatedAt: at(T0 + 5) })
    expect(happenings(undefined, now, ME, NOW, null)).toEqual([])
    expect(kinds(happenings(undefined, now, ME, NOW, LAST))).toEqual(['review-requested'])
    expect(happenings(undefined, { ...now, updatedAt: at(T0 - 5) }, ME, NOW, LAST)).toEqual([])
  })

  test('a display name from the row’s people is used when present', () => {
    const was = gh(16, { reviewers: [{ login: 'mona', state: 'requested' }] })
    const now = gh(16, { reviewers: [{ login: 'mona', state: 'approved' }], people: { mona: { name: 'Mona Lisa' } } })
    expect(happenings(seenOf(was), now, ME, NOW, LAST)).toEqual([{ kind: 'approved', by: 'mona', name: 'Mona Lisa', at: NOW }])
  })
})

describe('the item: words, state and priority', () => {
  const ev = (kind: Seen['events'][number]['kind'], by?: string) => ({ kind, ...(by ? { by } : {}), at: T0 })

  test('changes requested and your review asked: needs you, while still true', () => {
    const row = gh(20, { reviewers: [{ login: 'mona', state: 'changes' }] })
    const item = noticeItem(seenOf(row, T0, { events: [ev('changes-requested', 'mona')], since: T0 }), DEFAULT_NOTICES)!
    expect(item).toMatchObject({ state: 'attention', priority: 'normal', label: 'gh#20 changes requested by mona', refs: ['gh#20'], since: T0, detail: 'change 20' })
    /* mona approved since: the change request is no longer true. */
    const after = gh(20, { reviewers: [{ login: 'mona', state: 'approved' }] })
    expect(noticeItem(seenOf(after, T0, { events: [ev('changes-requested', 'mona')], since: T0 }), DEFAULT_NOTICES)).toBeNull()
    const asked = gh(21, { myRoles: ['reviewer-asked'] })
    expect(noticeItem(seenOf(asked, T0, { events: [ev('review-requested')], since: T0 }), DEFAULT_NOTICES)).toMatchObject({
      state: 'attention',
      label: 'gh#21 review requested from you',
    })
  })

  test('approved and merged: done at normal priority; comments and the rest: done at low', () => {
    const row = gl(22)
    const good = noticeItem(seenOf(row, T0, { events: [ev('approved', 'mona'), ev('commented', 'bob'), ev('commented', 'bob')], since: T0 }), DEFAULT_NOTICES)!
    expect(good).toMatchObject({ state: 'done', priority: 'normal', label: '!22 approved by mona · 2 new comments from bob' })
    const info = noticeItem(seenOf(row, T0, { events: [ev('commented', 'bob')], since: T0 }), DEFAULT_NOTICES)!
    expect(info).toMatchObject({ state: 'done', priority: 'low', label: '!22 a new comment from bob' })
    const merged = noticeItem(seenOf(gl(22, { state: 'merged' }), T0, { events: [ev('merged', 'mona')], since: T0 }), DEFAULT_NOTICES)!
    expect(merged).toMatchObject({ state: 'done', priority: 'normal', label: '!22 merged by mona' })
  })

  test('the setting’s per-event switches leave events out', () => {
    const seen = seenOf(gl(23), T0, { events: [ev('commented', 'bob')], since: T0 })
    expect(noticeItem(seen, { ...DEFAULT_NOTICES, events: { ...DEFAULT_NOTICES.events, commented: false } })).toBeNull()
    expect(noticeItem(seen, { ...DEFAULT_NOTICES, on: false })).toBeNull()
  })

  test('an item id is one per item however spelled, and bounded', () => {
    expect(itemId(gh(5))).toBe(itemId({ ...gh(5), kind: 'issue' }))
    expect(itemId(gl(5))).not.toBe(itemId({ ...gl(5), kind: 'issue' }))
    expect(itemId({ ...gl(5), repo: 'a/'.repeat(100) + 'b' }).length).toBeLessThanOrEqual(128)
  })
})

describe('the setting', () => {
  test('read strictly when changed, leniently when stored', () => {
    expect(noticesPatched(DEFAULT_NOTICES, { scope: 'epics', events: { pushed: false } })).toMatchObject({ on: true, scope: 'epics', events: { pushed: false, approved: true } })
    expect(noticesPatched(DEFAULT_NOTICES, { scope: 'all' })).toBeNull()
    expect(noticesPatched(DEFAULT_NOTICES, { events: { nope: true } })).toBeNull()
    expect(noticesPatched(DEFAULT_NOTICES, { on: 'yes' })).toBeNull()
    expect(noticesStored({ broken: 1 })).toEqual(DEFAULT_NOTICES)
  })

  test('kept in the machine database; the Settings route reads and changes it', async () => {
    const db = open(':memory:')
    ensureSettings(db)
    let restated = 0
    const route = settingsRoute({ db, status: () => ({ at: null, running: false, modules: [], problems: [] }), changed: () => {}, noticesChanged: () => (restated += 1), skillsAt: () => '/s', hook: () => ({ file: '/x', on: false }) })
    const url = new URL('http://127.0.0.1/host/settings')
    const got = await (await route(new Request(url), url))!.json()
    expect(got.notices).toEqual(DEFAULT_NOTICES)
    const post = (body: unknown) => route(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url)
    const changed = await (await post({ notices: { scope: 'epics', events: { commented: false } } }))!.json()
    expect(changed.notices).toMatchObject({ scope: 'epics', events: { commented: false } })
    expect(readNotices(db)).toMatchObject({ scope: 'epics', events: { commented: false } })
    expect((await post({ notices: { scope: 'nope' } }))!.status).toBe(400)
    expect(restated).toBe(1)
  })
})

describe('the store and the Inbox', () => {
  let db: Database
  let folder: string
  let project: number
  let clock: number
  let inbox: Inbox
  let notices: TrackerNotices
  const me = new Map([['github|github.com', ME], ['gitlab|gitlab.example.org', ME]])
  const land = (rows: TrackerRow[], epics: Map<string, string> = new Map()) => notices.landed(project, { rows, me, epics })
  const mine = () => inbox.all(project).filter((one) => one.module === TRACKER_NOTICES_MODULE)

  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-notices-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    clock = T0
    inbox = new Inbox(db, () => clock)
    notices = new TrackerNotices(db, inbox, () => clock)
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  test('the first reading is silent; the next tells, by-lined Kehikot, placed in the epic naming the ref', () => {
    const asked = gh(30, { reviewers: [{ login: 'mona', state: 'requested' }] })
    land([asked, gl(31, { reviewers: [{ login: 'bob', state: 'requested' }] })], new Map([['gh#30', 'thesis']]))
    expect(mine()).toEqual([])
    clock += 60_000
    land([gh(30, { reviewers: [{ login: 'mona', state: 'approved' }] }), gl(31, { reviewers: [{ login: 'bob', state: 'changes' }] })], new Map([['gh#30', 'thesis']]))
    const [a, b] = mine().sort((x, y) => x.label.localeCompare(y.label))
    expect(a).toMatchObject({ name: 'Kehikot', state: 'attention', label: '!31 changes requested by bob', refs: ['!31'] })
    expect(a!.place).toBeUndefined()
    expect(b).toMatchObject({ name: 'Kehikot', state: 'done', priority: 'normal', label: 'gh#30 approved by mona', refs: ['gh#30'], place: { epic: 'thesis' } })
  })

  test('one item per ref, accruing; a burst in one reading is one update', () => {
    land([gh(32, { reviewers: [{ login: 'mona', state: 'requested' }] })])
    clock += 1000
    land([gh(32, { reviewers: [{ login: 'mona', state: 'approved' }], lastActivity: { login: 'bob', at: at(clock), kind: 'comment', mine: false } })])
    expect(mine().map((one) => one.label)).toEqual(['gh#32 approved by mona · a new comment from bob'])
    const moves = inbox.moves(project).filter((one) => one.module === TRACKER_NOTICES_MODULE)
    expect(moves).toHaveLength(1)
    clock += 1000
    land([gh(32, { reviewers: [{ login: 'mona', state: 'approved' }], lastActivity: { login: 'carol', at: at(clock), kind: 'comment', mine: false } })])
    expect(mine()).toHaveLength(1)
    expect(mine()[0]!.label).toBe('gh#32 approved by mona · 2 new comments from bob and carol')
  })

  test('nothing for an item where the person has no role, unless the setting takes the epics too', () => {
    const theirs = (state: 'requested' | 'approved') => gh(33, { authorLogin: 'mona', myRoles: [], reviewers: [{ login: 'bob', state }] })
    land([theirs('requested')], new Map([['gh#33', 'thesis']]))
    clock += 1000
    land([theirs('approved')], new Map([['gh#33', 'thesis']]))
    expect(mine()).toEqual([])
    writeNotices(db, { ...DEFAULT_NOTICES, scope: 'epics' })
    clock += 1000
    land([gh(33, { authorLogin: 'mona', myRoles: [], reviewers: [{ login: 'bob', state: 'approved' }], state: 'merged' })], new Map([['gh#33', 'thesis']]))
    expect(mine().map((one) => one.label)).toEqual(['gh#33 merged'])
  })

  test('dismissed: put away until a NEW event; then only the new one is told', () => {
    land([gl(34)])
    clock += 1000
    land([gl(34, { lastActivity: { login: 'bob', at: at(clock), kind: 'comment', mine: false } })])
    const entry = mine()[0]!
    inbox.dismiss(project, [entry])
    clock += 1000
    land([gl(34, { lastActivity: { login: 'bob', at: at(clock - 1000), kind: 'comment', mine: false } })])
    expect(mine().filter(isLive)).toEqual([])
    clock += 1000
    land([gl(34, { lastActivity: { login: 'carol', at: at(clock), kind: 'comment', mine: false } })])
    const back = mine().filter(isLive)
    expect(back.map((one) => one.label)).toEqual(['!34 a new comment from carol'])
  })

  test('a finished item that was seen is let go, and comes back with the next event', () => {
    land([gh(35)])
    clock += 1000
    land([gh(35, { state: 'merged', lastActivity: { login: 'mona', at: at(clock), kind: 'state', mine: false } })])
    inbox.see(project, mine())
    clock += 1000
    land([gh(35, { state: 'merged', lastActivity: { login: 'mona', at: at(clock - 1000), kind: 'state', mine: false } })])
    expect(mine().filter(isLive)).toEqual([])
    expect(mine()[0]!.closed).not.toBeNull()
  })

  test('turning the notices off closes the items; restate applies the setting at once', () => {
    land([gh(36)])
    clock += 1000
    land([gh(36, { state: 'closed' })])
    expect(mine().filter(isLive)).toHaveLength(1)
    writeNotices(db, { ...DEFAULT_NOTICES, on: false })
    notices.restate([project])
    expect(mine().filter(isLive)).toEqual([])
  })

  test('a review asked of you needs you until you have reviewed', () => {
    const asked = { authorLogin: 'mona', myRoles: ['reviewer-asked' as const], reviewers: [{ login: ME, state: 'requested' as const }] }
    land([gh(37, { authorLogin: 'mona', myRoles: [], reviewers: [] })])
    clock += 1000
    land([gh(37, asked)])
    expect(mine()[0]).toMatchObject({ state: 'attention', label: 'gh#37 review requested from you' })
    clock += 1000
    land([gh(37, { authorLogin: 'mona', myRoles: ['reviewer-done'], reviewers: [{ login: ME, state: 'approved' }] })])
    expect(mine().filter(isLive)).toEqual([])
  })

  test('going to an item goes to its epic and lights nothing; without an epic it says so', () => {
    const item = { module: TRACKER_NOTICES_MODULE, name: 'Kehikot', place: { epic: 'thesis' } }
    const here = { project: 1, epic: 'other', parts: [], kehikko: 'k1' }
    const target = { project: 1, kehikot: [{ key: 'k1', name: 'One', modules: ['kehikot.references'] }], epics: ['thesis', 'other'] }
    expect(planGo(item, here, target)).toEqual({ steps: [{ kind: 'epic', epic: 'thesis', parts: [] }], note: null })
    expect(planGo({ module: TRACKER_NOTICES_MODULE }, here, target)).toEqual({ steps: [], note: 'No epic of this project names it.' })
  })

  test('the epics naming each ref, read from the project', () => {
    const dir = join(folder, '.kehikot', 'kehikko', 'epics')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'thesis.json'), JSON.stringify({ title: 'Thesis', refs: ['gh#30'] }))
    expect(epicsByRef(realpathSync(folder)).get('gh#30')).toBe('thesis')
  })
})

describe('told by the tracker reading', () => {
  let folder: string
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-notices-read-')))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  test('each read that lands hands its rows and who the person is to the notices', async () => {
    const ok = (out: string): Ran => ({ code: 0, out, err: '' })
    const run = (async (argv: string[]) =>
      argv.join(' ').startsWith('git -C')
        ? ok('origin\thttps://github.com/Jalez/kehikko.git (fetch)\norigin\thttps://github.com/Jalez/kehikko.git (push)')
        : { code: 1, out: '', err: 'no' }) as Runner
    let rows: TrackerRow[] = [gh(40, { reviewers: [{ login: 'mona', state: 'requested' }], myRoles: undefined })]
    const adapter: Adapter = {
      async list(source: Source) {
        return { ok: true as const, rows: rows.filter((r) => r.repo === source.repo), notFound: [] }
      },
      async refs(_source: Source, _wanted: readonly Wanted[]) {
        return { ok: true as const, rows: [], notFound: [] }
      },
      async detail() {
        return new Map()
      },
      async me() {
        return { login: ME }
      },
    }
    const landed: { rows: readonly TrackerRow[]; me: ReadonlyMap<string, string> }[] = []
    const trackers = new Trackers({ run, adapters: { github: adapter }, landed: (_root, got, me) => landed.push({ rows: got, me }), now: () => new Date(T0) })
    await trackers.refresh(folder, { project: true })
    expect(landed).toHaveLength(1)
    expect(landed[0]!.me.get('github|github.com')).toBe(ME)
    expect(landed[0]!.rows[0]).toMatchObject({ ref: 'gh#40', myRoles: ['author'] })
    rows = [gh(40, { reviewers: [{ login: 'mona', state: 'approved' }], myRoles: undefined })]
    await trackers.refresh(folder, { project: true })
    expect(landed[1]!.rows[0]!.reviewers).toEqual([{ login: 'mona', state: 'approved' }])
  })
})
