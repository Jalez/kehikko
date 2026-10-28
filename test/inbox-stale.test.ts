import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityItem } from 'kehikot-module-protocol'

import { open } from '../server/canvases.ts'
import { epicSlugs } from '../server/holdings.ts'
import { epicsDir } from '../server/hostData.ts'
import { Inbox } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'
import { addProject } from '../server/projects.ts'
import {
  REREPORT_GRACE_MS,
  applyList,
  closedWords,
  isHostModule,
  placeGone,
  retire,
  unreportedAfter,
  type Present,
} from '../src/host/inbox.ts'

/**
 * Jalez/kehikko#195: attention that outlives its reason. A dot stays yellow
 * while nothing the module would say now asks for the person. Every way a
 * module can stop saying something closes what it said, and says how.
 */

const item = (id: string, state: ActivityItem['state'], more: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  state,
  label: `Label ${id}`,
  ...more,
})

const T0 = 1_000_000

describe('the rules', () => {
  test('the module’s latest whole list is all that is held: attention it no longer lists closes', () => {
    const have = applyList([], 'm', 'M', [item('a', 'attention'), item('b', 'working')], { now: T0 }).puts
    const now = applyList(have, 'm', 'M', [item('b', 'done')], { now: T0 + 5 })
    expect(now.puts.map((e) => [e.id, e.state, e.closed, e.how])).toEqual([
      ['b', 'done', null, null],
      ['a', 'attention', T0 + 5, 'listed'],
    ])
  })

  test('a list naming a place that is gone is not held, and what was held for it closes as gone', () => {
    const gone = (place: ActivityItem['place']) => place?.kehikko === 'removed'
    const have = applyList([], 'm', 'M', [item('a', 'attention', { place: { kehikko: 'removed' } })], { now: T0 }).puts
    const again = applyList(have, 'm', 'M', [item('a', 'attention', { place: { kehikko: 'removed' } }), item('b', 'attention')], { now: T0 + 5, gone })
    expect(again.puts.map((e) => [e.id, e.closed, e.how])).toEqual([
      ['b', null, null],
      ['a', T0 + 5, 'gone'],
    ])
    expect(again.news.map((e) => e.id)).toEqual(['b'])
    const fresh = applyList([], 'm', 'M', [item('c', 'attention', { place: { kehikko: 'removed' } })], { now: T0, gone })
    expect(fresh.puts).toEqual([])
  })

  test('a place is gone when it names a kehikko or an epic the project does not have; not knowing retires nothing', () => {
    const present = { kehikot: new Set(['k1']), epics: new Set(['e1']) }
    expect(placeGone(undefined, present)).toBe(false)
    expect(placeGone({ kehikko: 'k1', epic: 'e1' }, present)).toBe(false)
    expect(placeGone({ kehikko: 'k2' }, present)).toBe(true)
    expect(placeGone({ epic: 'e2' }, present)).toBe(true)
    expect(placeGone({ parts: ['p'] }, present)).toBe(false)
    expect(placeGone({ kehikko: 'k2', epic: 'e2' }, { kehikot: null, epics: null })).toBe(false)
    /* A project whose kehikot cannot be listed yet says nothing about which are gone. */
    expect(placeGone({ kehikko: 'k2' }, { kehikot: new Set(), epics: null })).toBe(false)
  })

  test('retire closes what an uninstalled module, a removed kehikko or a deleted epic left open; never the host’s own for its module', () => {
    const have = [
      ...applyList([], 'kehikot.gone', 'Gone', [item('a', 'attention')], { now: T0 }).puts,
      ...applyList([], 'kehikot.here', 'Here', [item('b', 'attention', { place: { kehikko: 'old' } }), item('c', 'attention', { place: { epic: 'deleted' } }), item('d', 'attention', { place: { kehikko: 'k1', epic: 'e1' } })], { now: T0 }).puts,
      ...applyList([], 'kehikko', 'Kehikot', [item('place-ask:s', 'attention')], { now: T0 }).puts,
      ...applyList([], 'kehikko.trackers', 'Kehikot', [item('t', 'done', { place: { epic: 'deleted' } })], { now: T0 }).puts,
    ]
    const present: Present = { modules: new Set(['kehikot.here']), kehikot: new Set(['k1']), epics: new Set(['e1']) }
    const out = retire(have, present, T0 + 9)
    expect(out.map((e) => [e.module, e.id, e.closed, e.how])).toEqual([
      ['kehikot.gone', 'a', T0 + 9, 'gone'],
      ['kehikot.here', 'b', T0 + 9, 'gone'],
      ['kehikot.here', 'c', T0 + 9, 'gone'],
      ['kehikko.trackers', 't', T0 + 9, 'gone'],
    ])
    expect(retire(have, { modules: null, kehikot: null, epics: null }, T0 + 9)).toEqual([])
  })

  test('a new page that has not sent a list in its grace is unreported; one that sent one, or is still in its grace, is not', () => {
    const greeted = new Map([['quiet', T0], ['spoke', T0], ['young', T0 + 15_000], ['kehikko.trackers', T0]])
    const heard = new Map([['spoke', T0], ['quiet', T0 - 1]])
    expect(unreportedAfter(greeted, heard, T0 + REREPORT_GRACE_MS)).toEqual(['quiet'])
    expect(unreportedAfter(greeted, heard, T0 + REREPORT_GRACE_MS - 1)).toEqual([])
  })

  test('the host’s own lists are known as such', () => {
    expect(['kehikko', 'kehikko.trackers', 'kehikko.settings', 'kehikot.claude', 'kehikkox'].map(isHostModule)).toEqual([true, true, true, false, false])
  })

  test('each closing says how, in words', () => {
    expect(closedWords({ state: 'attention', how: 'unreported', origin: 'activity' })).toBe('not said again after the module restarted, was needs you')
    expect(closedWords({ state: 'attention', how: 'gone', origin: 'activity' })).toBe('its module or place is gone, was needs you')
    expect(closedWords({ state: 'attention', how: 'silent', origin: 'activity' })).toBe('stopped answering, was needs you')
  })
})

describe('the record', () => {
  let db: Database
  let folder: string
  let project: number
  let clock: number
  let inbox: Inbox
  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-inbox-stale-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    clock = 10_000_000
    inbox = new Inbox(db, () => clock)
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('reproduced: a page that is gone said attention, its new page says nothing, and the record held it open', () => {
    /* The page before the restart. */
    inbox.report(project, 'kehikot.paper', 'Paper', [item('review:e:main.tex', 'attention', { place: { epic: 'e' } })])
    /* The module restarted (an update), its new page was greeted and has nothing open to say —
       so it never calls `activity.set`. Nothing else writes this module's list: before #195 the
       entry stayed open, and live, for as long as the module stayed on the kehikko. */
    clock += 60 * 60_000
    expect(inbox.open(project).map((e) => [e.id, e.state])).toEqual([['review:e:main.tex', 'attention']])
    /* The rule: the grace passed without a list, and the page says so. */
    const out = inbox.report(project, 'kehikot.paper', 'Paper', [], { unreported: true })
    expect(out.open).toEqual([])
    expect(inbox.all(project).map((e) => [e.id, e.closed, e.how])).toEqual([['review:e:main.tex', clock, 'unreported']])
    expect(inbox.log(project, null, 0, 10).rows.map((r) => [r.kind, r.how])).toEqual([['closed', 'unreported']])
  })

  test('a list that arrives after the grace reopens what is still true, without telling it again', () => {
    inbox.report(project, 'kehikot.claude', 'Claude', [item('s', 'attention', { since: 5 })])
    inbox.report(project, 'kehikot.claude', 'Claude', [], { unreported: true })
    clock += 1000
    const back = inbox.report(project, 'kehikot.claude', 'Claude', [item('s', 'attention', { since: 5 })])
    expect(back.open.map((e) => [e.id, e.closed])).toEqual([['s', null]])
    expect(back.news).toEqual([])
  })

  test('retire closes what is gone, once, and keeps it in the log', () => {
    inbox.report(project, 'kehikot.gone', 'Gone', [item('a', 'attention')])
    inbox.report(project, 'kehikot.here', 'Here', [item('b', 'attention', { place: { kehikko: 'k1' } })])
    const present: Present = { modules: new Set(['kehikot.here']), kehikot: new Set(['k1']), epics: null }
    const first = inbox.retire(project, present)
    expect(first.retired).toBe(1)
    expect(inbox.retire(project, present)).toEqual({ retired: 0, rev: first.rev })
    expect(inbox.open(project).map((e) => e.id)).toEqual(['b'])
    expect(inbox.all(project).find((e) => e.id === 'a')).toMatchObject({ how: 'gone' })
  })

  test('the epics of a project are its files; a project with no epics folder says nothing', () => {
    expect(epicSlugs(folder)).toBeNull()
    mkdirSync(epicsDir(folder), { recursive: true })
    writeFileSync(join(epicsDir(folder), 'mcp-support-tickets.json'), '{}')
    writeFileSync(join(epicsDir(folder), 'notes.txt'), '')
    expect([...epicSlugs(folder)!]).toEqual(['mcp-support-tickets'])
  })
})

describe('over the routes', () => {
  let db: Database
  let folder: string
  let project: number
  let inbox: Inbox
  let present: Present | null
  let desk: ReturnType<typeof inboxDesk>
  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-inbox-stale-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    inbox = new Inbox(db)
    present = null
    desk = inboxDesk({ inbox, pathOf: (id) => (id === project ? folder : undefined), present: () => present, changed: () => undefined })
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })
  const send = async (path: string, body?: unknown) => {
    const url = new URL(`http://127.0.0.1:4180${path}`)
    const request = new Request(url, body === undefined ? { method: 'GET' } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    const response = await desk.route(request, url)
    return { status: response!.status, body: (await response!.json()) as any }
  }

  test('unreported closes the module’s open entries, as unreported', async () => {
    await send('/host/inbox/report', { project, module: 'kehikot.m', name: 'M', items: [item('a', 'attention')] })
    const out = await send('/host/inbox/report', { project, module: 'kehikot.m', name: 'M', items: [item('ignored', 'attention')], unreported: true })
    expect(out.body.open).toEqual([])
    expect(inbox.all(project).map((e) => [e.id, e.how])).toEqual([['a', 'unreported']])
  })

  test('a read retires what is gone; a report for a gone place is not held; the host’s own stays', async () => {
    await send('/host/inbox/report', { project, module: 'kehikot.uninstalled', name: 'U', items: [item('a', 'attention')] })
    await send('/host/inbox/report', { project, module: 'kehikot.m', name: 'M', items: [item('b', 'attention', { place: { kehikko: 'removed' } }), item('c', 'attention', { place: { epic: 'mcp-support-tickets', kehikko: 'k1' } })] })
    await send('/host/inbox/report', { project, module: 'kehikko', name: 'Kehikot', items: [item('place-ask:s', 'attention')] })
    present = { modules: new Set(['kehikot.m']), kehikot: new Set(['k1']), epics: new Set(['mcp-support-tickets']) }
    const read = await send(`/host/inbox?project=${project}`)
    expect(read.body.open.map((e: { id: string }) => e.id).sort()).toEqual(['c', 'place-ask:s'])
    const again = await send('/host/inbox/report', { project, module: 'kehikot.m', name: 'M', items: [item('b', 'attention', { place: { kehikko: 'removed' } }), item('c', 'attention', { place: { epic: 'mcp-support-tickets', kehikko: 'k1' } })] })
    expect(again.body.open.map((e: { id: string }) => e.id).sort()).toEqual(['c', 'place-ask:s'])
    expect(again.body.news).toEqual([])
  })
})
