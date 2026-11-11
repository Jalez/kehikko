import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIMITS, type TrackerRow } from 'kehikot-module-protocol'
import { TELL_EVERY_MS } from 'kehikot-module-protocol/serve'

import { AgentMessages, type Reader } from '../server/agentMessages.ts'
import { open } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { MUTED_SAYS } from '../server/messageMutes.ts'
import { messageDesk } from '../server/messageRoutes.ts'
import { addProject } from '../server/projects.ts'
import { TrackerNotices, writeNotices } from '../server/trackerNotices.ts'
import { epicPlacesByRef } from '../server/trackers/reading.ts'
import { DEFAULT_NOTICES, factsOf, itemId, type Seen } from '../src/host/trackerNotices.ts'
import { newsLine, newsOf, newsTells, TRACKER_NEWS_FROM, type EpicPlace } from '../src/host/trackerNews.ts'

/**
 * Tracker news to agents: what somebody else did on an item an epic holds,
 * told to the agent sessions at that epic as the host's own message, through
 * the same delivery as a module's news to a place. Scratch databases and
 * folders; rows made up — nothing reaches a forge.
 */

const T0 = 1_800_000_000_000
const ME = 'jaakko'
const at = (ms: number) => new Date(ms).toISOString()

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
  authorLogin: 'ali',
  myRoles: [],
  reviewers: [],
  updatedAt: at(T0 - 60_000),
  readAt: at(T0),
  ...over,
})

const seenOf = (row: TrackerRow, when = T0): Seen => ({ id: itemId(row), ref: row.ref, title: row.title, facts: factsOf(row), events: [], since: null, at: when })

describe('what agents are told of one item', () => {
  const NOW = T0 + 600_000
  test('reviews, comments with their place, pushes by somebody else, CI', () => {
    const was = gh(7, { reviewers: [{ login: 'mona', state: 'requested' }], pipeline: 'success', lastPushAt: at(T0 - 100) })
    const now = gh(7, {
      reviewers: [{ login: 'mona', state: 'changes' }],
      pipeline: 'failed',
      lastPushAt: at(T0 + 100),
      lastActivity: { login: 'ali', at: at(T0 + 100), kind: 'commit', mine: false, commits: 3 },
    })
    const told = newsOf(seenOf(was), now, ME, NOW, T0)
    expect(told.map((one) => one.kind)).toEqual(['changes-requested', 'pushed', 'ci-failed'])
    expect(newsLine('!1801', 'Login', told, 2)).toBe('mona requested changes on !1801 · 2 unresolved threads; ali pushed 3 commits to !1801; CI failed on !1801 — Login')
  })

  test('the wording follows the detail', () => {
    expect(newsLine('!1801', '', [{ kind: 'pushed', by: 'ali', name: 'Ali', commits: 3 }])).toBe('Ali pushed 3 commits to !1801')
    expect(newsLine('#42', '', [{ kind: 'ci-failed' }])).toBe('CI failed on #42')
    expect(newsLine('#42', '', [{ kind: 'ci-recovered' }])).toBe('CI passes again on #42')
    expect(newsLine('!1801', '', [{ kind: 'changes-requested', by: 'mona', name: 'Mona' }], 2)).toBe('Mona requested changes on !1801 · 2 unresolved threads')
    expect(newsLine('!3', '', [{ kind: 'commented', by: 'mona', path: 'src/api.ts', line: 42 }])).toBe('mona commented on line 42 of api.ts in !3')
    expect(newsLine('!3', '', [{ kind: 'commented', by: 'mona' }, { kind: 'commented', by: 'bob' }])).toBe('2 new comments on !3 from mona and bob')
    expect(newsLine('!3', '', [{ kind: 'approved', by: 'mona' }, { kind: 'merged', by: 'bob' }])).toBe('mona approved !3; bob merged !3')
    expect(newsLine('!3', '', [{ kind: 'review', by: 'mona' }])).toBe('mona reviewed !3')
  })

  test('CI passing again after a failure, across a run in between', () => {
    const failed = seenOf(gh(8, { pipeline: 'failed' }))
    const running = gh(8, { pipeline: 'running' })
    expect(newsOf(failed, running, ME, NOW, T0)).toEqual([])
    const carried: Seen = { ...failed, facts: factsOf(running, failed.facts) }
    expect(carried.facts.ci).toBe('failed')
    expect(newsOf(carried, gh(8, { pipeline: 'success' }), ME, NOW, T0).map((one) => one.kind)).toEqual(['ci-recovered'])
  })

  test('never the person’s own acts, nothing whose doer is unknown, nothing where the person is unknown', () => {
    const was = gh(9, { reviewers: [{ login: ME, state: 'requested' }] })
    const mine = gh(9, { reviewers: [{ login: ME, state: 'approved' }], lastActivity: { login: ME, at: at(T0 + 10), kind: 'review', mine: true } })
    expect(newsOf(seenOf(was), mine, ME, NOW, T0)).toEqual([])
    const myComment = gh(9, { reviewers: [{ login: ME, state: 'requested' }], lastActivity: { login: ME, at: at(T0 + 10), kind: 'comment', mine: true } })
    expect(newsOf(seenOf(was), myComment, ME, NOW, T0)).toEqual([])
    const closedByWhom = gh(9, { state: 'closed', reviewers: [{ login: ME, state: 'requested' }] })
    expect(newsOf(seenOf(was), closedByWhom, ME, NOW, T0)).toEqual([])
    const theirs = gh(9, { reviewers: [{ login: ME, state: 'requested' }], lastActivity: { login: 'mona', at: at(T0 + 10), kind: 'comment', mine: false } })
    expect(newsOf(seenOf(was), theirs, null, NOW, T0)).toEqual([])
    expect(newsOf(seenOf(was), theirs, ME, NOW, null)).toEqual([])
    expect(newsOf(undefined, theirs, ME, NOW, T0)).toEqual([])
  })

  test('one message per place: to the epic when it names the item, else to the parts that hold it', () => {
    const tells = newsTells([
      { line: 'a', places: [{ epic: 'auth', parts: [] }, { epic: 'auth', parts: ['p1'] }] },
      { line: 'b', places: [{ epic: 'auth', parts: ['p2'] }, { epic: 'ui', parts: [] }] },
      { line: 'c', places: [{ epic: 'auth', parts: [] }] },
    ])
    expect(tells).toEqual([
      { place: { epic: 'auth' }, body: 'a\nc' },
      { place: { epic: 'auth', parts: ['p2'] }, body: 'b' },
      { place: { epic: 'ui' }, body: 'b' },
    ])
  })
})

describe('told to the sessions at the epic', () => {
  let db: Database
  let folder: string
  let project: number
  let clock: number
  let store: AgentMessages
  let notices: TrackerNotices
  let desk: ReturnType<typeof messageDesk>
  let changed: number[]
  const places = new Map<string, EpicPlace[]>([['gh#1', [{ epic: 'auth', parts: [] }]]])
  const epics = new Map([['gh#1', 'auth']])
  const me = new Map([['github|github.com', ME]])
  const atAuth: Reader = { module: 'stand.sessions', session: 's1', epic: 'auth', kehikko: 'writing' }
  const elsewhere: Reader = { module: 'stand.sessions', session: 's2', epic: 'ui', kehikko: 'writing' }

  /** One reading landing, and its news sent as the server sends it. */
  const land = (rows: TrackerRow[]) => {
    const out = notices.landed(project, { rows, me, epics, places })
    return out.news.map((one) => desk.hostTell(project, one.place, one.body))
  }

  beforeEach(() => {
    db = open(':memory:')
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-news-')))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error('no project')
    project = added.project.id
    clock = T0
    store = new AgentMessages(db, () => clock)
    notices = new TrackerNotices(db, new Inbox(db, () => clock), () => clock)
    changed = []
    desk = messageDesk({ db, messages: store, resolve: async () => ({ here: null }), nameOf: () => null, changed: (id) => changed.push(id), setTimer: () => null })
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('a new event at an epic reaches the sessions there, from the host’s tracker reading', () => {
    land([gh(1, { reviewers: [{ login: 'mona', state: 'requested' }] })])
    clock += 600_000
    const sent = land([gh(1, { reviewers: [{ login: 'mona', state: 'approved' }] })])
    expect(sent).toEqual([{ ok: true, id: expect.any(Number) }])
    expect(changed).toContain(project)
    const got = store.deliver(project, atAuth).messages
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ from: { module: TRACKER_NEWS_FROM.module, name: 'Trackers', session: null }, kind: 'report', body: 'mona approved gh#1 — change 1' })
    expect(got[0]!.to).toEqual({ place: { epic: 'auth' } })
    expect(store.deliver(project, elsewhere).messages).toEqual([])
  })

  test('whatever the Inbox’s own tracker notices are set to', () => {
    writeNotices(db, { ...DEFAULT_NOTICES, on: false })
    land([gh(1)])
    clock += 600_000
    land([gh(1, { lastActivity: { login: 'mona', at: at(clock - 5), kind: 'comment', mine: false, path: 'api.ts', line: 4 } })])
    expect(store.deliver(project, atAuth).messages.map((one) => one.body)).toEqual(['mona commented on line 4 of api.ts in gh#1 — change 1'])
  })

  test('the person’s own acts are not told', () => {
    land([gh(1, { authorLogin: ME, myRoles: ['author'] })])
    clock += 600_000
    expect(land([gh(1, { authorLogin: ME, myRoles: ['author'], state: 'merged', lastActivity: { login: ME, at: at(clock - 5), kind: 'state', mine: true } })])).toEqual([])
    expect(store.deliver(project, atAuth).messages).toEqual([])
  })

  test('no duplicate after a restart', () => {
    land([gh(1, { pipeline: 'success' })])
    clock += 600_000
    const failed = gh(1, { pipeline: 'failed' })
    expect(land([failed])).toHaveLength(1)
    /* The host starts again on the same database: the same reading tells nothing. */
    notices = new TrackerNotices(db, new Inbox(db, () => clock), () => clock)
    store = new AgentMessages(db, () => clock)
    desk = messageDesk({ db, messages: store, resolve: async () => ({ here: null }), nameOf: () => null, changed: () => {}, setTimer: () => null })
    clock += 600_000
    expect(land([failed])).toEqual([])
    expect(store.deliver(project, atAuth).messages.map((one) => one.body)).toEqual(['CI failed on gh#1 — change 1'])
  })

  test('a burst is one copy, then one digest after the minute', () => {
    land([gh(1, { pipeline: 'success' })])
    clock += 600_000
    land([gh(1, { pipeline: 'failed' })])
    expect(store.deliver(project, atAuth).messages).toHaveLength(1)
    clock += 5_000
    land([gh(1, { pipeline: 'success' })])
    clock += 5_000
    land([gh(1, { pipeline: 'success', lastActivity: { login: 'mona', at: at(clock - 1), kind: 'comment', mine: false } })])
    expect(store.deliver(project, atAuth).messages).toEqual([])
    clock += TELL_EVERY_MS
    const digest = store.deliver(project, atAuth).messages
    expect(digest).toHaveLength(1)
    expect(digest[0]!.body).toBe('2 updates:\n- CI passes again on gh#1 — change 1\n- mona commented on gh#1 — change 1')
  })

  test('the hourly cap holds the host’s news like a module’s', () => {
    land([gh(1, { pipeline: 'success' })])
    let declined = 0
    for (let i = 0; i < LIMITS.MESSAGES_PER_HOUR + 2; i += 1) {
      clock += 1_000
      const sent = land([gh(1, { pipeline: i % 2 === 0 ? 'failed' : 'success' })])
      declined += sent.filter((one) => !one.ok).length
    }
    expect(declined).toBe(2)
  })

  test('the mute stops it: nothing kept, nothing woken', async () => {
    const mute = async (muted: boolean) => {
      const response = await desk.route(new Request('http://h/host/messages/mute', { method: 'POST', body: JSON.stringify({ project, module: TRACKER_NEWS_FROM.module, muted }) }), new URL('http://h/host/messages/mute'))
      return (await response!.json()) as { muted: string[] }
    }
    expect((await mute(true)).muted).toEqual([TRACKER_NEWS_FROM.module])
    changed = []
    land([gh(1, { pipeline: 'success' })])
    clock += 600_000
    expect(land([gh(1, { pipeline: 'failed' })])).toEqual([{ ok: false, why: MUTED_SAYS }])
    expect(changed).toEqual([])
    expect(store.count(project)).toBe(0)
    /* Back on, it tells what is new from then on. */
    await mute(false)
    clock += 600_000
    expect(land([gh(1, { pipeline: 'success' })])).toEqual([{ ok: true, id: expect.any(Number) }])
  })

  test('items outside the epic are ignored', () => {
    land([gh(1, { pipeline: 'success' }), gh(2, { pipeline: 'success' })])
    clock += 600_000
    land([gh(1, { pipeline: 'success' }), gh(2, { pipeline: 'failed', reviewers: [{ login: 'mona', state: 'approved' }] })])
    expect(store.count(project)).toBe(0)
  })

  test('an item a part holds goes to that part', () => {
    const parted = new Map<string, EpicPlace[]>([['gh#3', [{ epic: 'auth', parts: ['login'] }]]])
    notices.landed(project, { rows: [gh(3, { pipeline: 'success' })], me, epics: new Map(), places: parted })
    clock += 600_000
    const out = notices.landed(project, { rows: [gh(3, { pipeline: 'failed' })], me, epics: new Map(), places: parted })
    expect(out.news).toEqual([{ place: { epic: 'auth', parts: ['login'] }, body: 'CI failed on gh#3 — change 3' }])
  })
})

describe('where an item belongs', () => {
  let folder: string
  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-news-epics-')))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  test('every epic naming a ref', () => {
    const dir = join(folder, '.kehikot', 'kehikko', 'epics')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ title: 'Auth', refs: ['gh#30'] }))
    writeFileSync(join(dir, 'ui.json'), JSON.stringify({ title: 'UI', refs: ['gh#30', 'gh#31'] }))
    const places = epicPlacesByRef(folder)
    expect(places.get('gh#30')).toEqual([{ epic: 'auth', parts: [] }, { epic: 'ui', parts: [] }])
    expect(places.get('gh#31')).toEqual([{ epic: 'ui', parts: [] }])
    expect(places.get('gh#32')).toBeUndefined()
  })
})
