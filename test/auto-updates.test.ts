import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { settingsRoute } from '../server/agentSettings.ts'
import { AutoUpdates, readAutoUpdates, writeAutoUpdates, type Applied, type Facts } from '../server/autoUpdates.ts'
import type { Checkout } from '../server/updates.ts'
import {
  AUTO_UPDATES_NOTE,
  decide,
  holdsShells,
  isMajor,
  RETRY_AFTER_MS,
  waitSaid,
  type Candidate,
} from '../src/host/autoUpdates.ts'
import type { ModuleRelease } from '../src/host/moduleReleases.ts'
import { indicator, moduleRow, restartNowWord } from '../src/host/updateModel.ts'
import { acknowledged, ackFor, baselined, newsItems, noticeSaid, notesDue, type WhatsNewAnswer } from '../src/host/whatsNew.ts'

/**
 * "Keep modules up to date automatically": the decision table, and the one
 * thing that acts on it (`server/autoUpdates.ts`), with every process and git
 * call handed in. Nothing here touches a real install.
 */

const NOW = 1_700_000_000_000

const release = (over: Partial<ModuleRelease> = {}): ModuleRelease => ({
  follows: 'release',
  installed: 'v1.5.0',
  newest: 'v1.6.0',
  target: 'v1.6.0',
  notes: ['v1.6.0'],
  needsNewer: null,
  repo: 'Jalez/kehikko-thing',
  error: null,
  ...over,
})

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  on: true,
  installed: true,
  reading: { release: release(), blocked: null },
  pinned: [],
  running: false,
  onScreen: false,
  holdsShells: false,
  kept: false,
  busy: false,
  failed: null,
  checking: true,
  now: NOW,
  ...over,
})

describe('the decision table', () => {
  test('not running: now', () => {
    expect(decide(candidate())).toEqual({ do: 'now', target: 'v1.6.0', major: false })
  })

  test('running but not on screen: now (restarted quietly)', () => {
    expect(decide(candidate({ running: true, onScreen: false }))).toMatchObject({ do: 'now' })
  })

  test('on screen and running: when it is next off screen', () => {
    expect(decide(candidate({ running: true, onScreen: true }))).toMatchObject({ do: 'wait', until: 'off-screen', target: 'v1.6.0' })
  })

  test('on screen but not running (it is about to start): now, before it starts', () => {
    expect(decide(candidate({ running: false, onScreen: true }))).toMatchObject({ do: 'now' })
  })

  test('holding live work: when it next stops, wherever it is', () => {
    expect(decide(candidate({ running: true, holdsShells: true }))).toMatchObject({ do: 'wait', until: 'stopped', shells: true })
    expect(decide(candidate({ running: true, onScreen: true, holdsShells: true }))).toMatchObject({ do: 'wait', until: 'stopped' })
    /* Once it has stopped, it goes. */
    expect(decide(candidate({ running: false, holdsShells: true }))).toMatchObject({ do: 'now' })
  })

  test('kept by its registration: when it next stops', () => {
    expect(decide(candidate({ running: true, kept: true }))).toMatchObject({ do: 'wait', until: 'stopped', shells: false })
  })

  test('pinned: never by itself', () => {
    expect(decide(candidate({ pinned: ['v1.2.0'] }))).toMatchObject({ do: 'wait', until: 'pinned', detail: 'v1.2.0' })
  })

  test('only newer releases that need a newer Kehikot: it waits for the app', () => {
    const waiting = release({
      target: null,
      newest: 'v1.5.0',
      needsNewer: { tag: 'v1.7.0', protocol: '2.30.0' },
      works: { 'v1.7.0': { kind: 'from', need: '2.30.0', from: '0.1.70', until: null } },
    })
    const decided = decide(candidate({ reading: { release: waiting, blocked: null } }))
    expect(decided).toEqual({ do: 'wait', until: 'app', target: 'v1.7.0', detail: '0.1.70' })
    if (decided.do === 'wait') expect(waitSaid('Paper', decided)).toBe('Paper waits for Kehikot 0.1.70')
  })

  test('a checkout somebody edits (not installed): never', () => {
    expect(decide(candidate({ installed: false }))).toEqual({ do: 'nothing' })
  })

  test('a copy that follows main (no release yet): never; a press, as before', () => {
    expect(decide(candidate({ reading: { release: release({ follows: 'main', installed: null, target: null }), blocked: null } }))).toEqual({ do: 'nothing' })
  })

  test('refused by update (changes of its own): never, with why', () => {
    expect(decide(candidate({ reading: { release: release(), blocked: 'there are uncommitted changes' } }))).toMatchObject({ do: 'wait', until: 'held' })
  })

  test('the switch off: nothing at all', () => {
    expect(decide(candidate({ on: false }))).toEqual({ do: 'nothing' })
    expect(decide(candidate({ on: false, running: true, onScreen: true }))).toEqual({ do: 'nothing' })
  })

  test('up to date, unreadable, or a person already updating it: nothing', () => {
    expect(decide(candidate({ reading: { release: release({ target: null }), blocked: null } }))).toEqual({ do: 'nothing' })
    expect(decide(candidate({ reading: null }))).toEqual({ do: 'nothing' })
    expect(decide(candidate({ busy: true }))).toEqual({ do: 'nothing' })
  })

  test('a failure waits for the next check: not on a re-decision, not on a check too soon', () => {
    const failed = { target: 'v1.6.0', at: NOW, why: 'bun install failed' }
    expect(decide(candidate({ failed, checking: false, now: NOW + RETRY_AFTER_MS * 10 }))).toMatchObject({ do: 'wait', until: 'retry' })
    expect(decide(candidate({ failed, checking: true, now: NOW + 60_000 }))).toMatchObject({ do: 'wait', until: 'retry' })
    expect(decide(candidate({ failed, checking: true, now: NOW + RETRY_AFTER_MS }))).toMatchObject({ do: 'now' })
    /* A newer release than the one that failed is a new try. */
    expect(decide(candidate({ failed: { ...failed, target: 'v1.5.5' }, checking: true, now: NOW + 1 }))).toMatchObject({ do: 'now' })
  })

  test('a major version jump is taken, and marked', () => {
    expect(decide(candidate({ reading: { release: release({ target: 'v2.0.0' }), blocked: null } }))).toEqual({ do: 'now', target: 'v2.0.0', major: true })
    expect(isMajor('v1.9.0', 'v2.0.0')).toBe(true)
    expect(isMajor('v1.5.0', 'v1.6.0')).toBe(false)
    expect(isMajor(null, 'v2.0.0')).toBe(false)
  })

  test('the words for each wait', () => {
    expect(waitSaid('Terminal', { until: 'stopped', target: 'v1.2.0', detail: null, shells: true })).toBe('Terminal updates when its sessions end')
    expect(waitSaid('Journeys', { until: 'off-screen', target: 'v1.6.0', detail: null })).toBe('Journeys updates when you leave its kehikko')
    expect(waitSaid('Paper', { until: 'app', target: 'v2.0.0', detail: '' })).toBe('Paper waits for a newer Kehikot')
    expect(waitSaid('Notes', { until: 'pinned', target: 'v1.6.0', detail: 'v1.2.0' })).toBe('Notes is pinned to v1.2.0, so it is not updated automatically')
    expect(waitSaid('Notes', { until: 'retry', target: 'v1.6.0', detail: 'bun install failed.' })).toBe(
      'Notes could not be updated to 1.6.0: bun install failed. It is tried again at the next check.',
    )
  })

  test('which modules hold live work: Terminal, Claude, Codex — under either spelling', () => {
    expect(['kehikot.terminal', 'kehikot.claude', 'kehikot.codex', 'roadmap.terminal'].every(holdsShells)).toBe(true)
    expect(holdsShells('kehikot.journeys')).toBe(false)
    expect(restartNowWord('kehikot.codex')).toBe('Restart now (ends its shells)')
  })
})

/* ---- the one that acts ---- */

const reading = (id: string, over: Partial<ModuleRelease> = {}, more: Partial<Checkout> = {}): Checkout => ({
  id,
  name: id,
  dir: `/scratch/installed/${id}`,
  branch: null,
  commit: 'abc1234',
  dirty: false,
  upstream: 'v1.6.0',
  behind: 1,
  ahead: 0,
  incoming: [],
  fetchFailed: null,
  blocked: null,
  release: release(over),
  ...more,
})

function harness(start: Record<string, Partial<Facts>> = {}, outcome: (id: string) => Applied = () => ({ ok: true, checkout: null })) {
  let on = true
  let now = NOW
  const facts = new Map<string, Facts>()
  for (const [id, over] of Object.entries(start)) {
    facts.set(id, { name: id, installed: true, pinned: [], running: false, onScreen: false, holdsShells: false, kept: false, busy: false, ...over })
  }
  const applied: string[] = []
  const pendingWhileApplying: boolean[] = []
  let changes = 0
  const auto = new AutoUpdates({
    on: () => on,
    facts: (id) => facts.get(id) ?? null,
    async apply(id) {
      applied.push(id)
      pendingWhileApplying.push(auto.pending(id))
      return outcome(id)
    },
    changed: () => (changes += 1),
    log: () => {},
    now: () => now,
  })
  return {
    auto,
    applied,
    pendingWhileApplying,
    set(id: string, over: Partial<Facts>) {
      facts.set(id, { ...facts.get(id)!, ...over })
    },
    turn(next: boolean) {
      on = next
      return auto.turned(next)
    },
    later(ms: number) {
      now += ms
    },
    changes: () => changes,
  }
}

describe('AutoUpdates: what a check found is taken, or waits', () => {
  test('a module that is not running is updated at once, and said as updated', async () => {
    const h = harness({ a: {} })
    await h.auto.found([reading('a')])
    expect(h.applied).toEqual(['a'])
    expect(h.pendingWhileApplying).toEqual([true])
    expect(h.auto.said().updated).toMatchObject([{ id: 'a', from: '1.5.0', to: '1.6.0', major: false }])
    expect(h.auto.said().waiting).toEqual({})
    expect(h.changes()).toBeGreaterThan(0)
  })

  test('a pinned module is untouched', async () => {
    const h = harness({ a: { pinned: ['v1.2.0'] } })
    await h.auto.found([reading('a')])
    await h.auto.moved()
    expect(h.applied).toEqual([])
    expect(h.auto.waiting('a')).toMatchObject({ until: 'pinned' })
  })

  test('one that needs a newer Kehikot waits, and is never applied', async () => {
    const h = harness({ paper: {} })
    await h.auto.found([reading('paper', { target: null, needsNewer: { tag: 'v2.0.0', protocol: '3.0.0' } })])
    await h.auto.moved()
    expect(h.applied).toEqual([])
    expect(h.auto.waiting('paper')).toMatchObject({ until: 'app', target: 'v2.0.0' })
  })

  test('a checkout somebody edits is never updated', async () => {
    const h = harness({ mine: { installed: false } })
    await h.auto.found([reading('mine')])
    expect(h.applied).toEqual([])
    expect(h.auto.waiting('mine')).toBeNull()
  })

  test('one holding sessions is deferred until it stops, then applied', async () => {
    const h = harness({ 'kehikot.terminal': { running: true, onScreen: true, holdsShells: true } })
    await h.auto.found([reading('kehikot.terminal')])
    expect(h.applied).toEqual([])
    expect(h.auto.waiting('kehikot.terminal')).toMatchObject({ until: 'stopped', shells: true })
    /* Off screen is not enough: its sessions still run. */
    h.set('kehikot.terminal', { onScreen: false })
    await h.auto.moved()
    expect(h.applied).toEqual([])
    /* Its sessions ended and it stopped. */
    h.set('kehikot.terminal', { running: false })
    await h.auto.moved()
    expect(h.applied).toEqual(['kehikot.terminal'])
    expect(h.auto.waiting('kehikot.terminal')).toBeNull()
  })

  test('one on screen waits, and is applied once it is off screen', async () => {
    const h = harness({ journeys: { running: true, onScreen: true } })
    await h.auto.found([reading('journeys')])
    expect(h.applied).toEqual([])
    expect(h.auto.waiting('journeys')).toMatchObject({ until: 'off-screen' })
    await h.auto.moved()
    expect(h.applied).toEqual([])
    h.set('journeys', { onScreen: false })
    await h.auto.moved()
    expect(h.applied).toEqual(['journeys'])
  })

  test('the switch off: nothing automatic, and turning it off forgets what waited', async () => {
    const h = harness({ a: {}, b: { running: true, onScreen: true } })
    await h.turn(false)
    await h.auto.found([reading('a'), reading('b')])
    await h.auto.moved()
    expect(h.applied).toEqual([])
    expect(h.auto.said()).toMatchObject({ on: false, waiting: {} })

    const g = harness({ b: { running: true, onScreen: true } })
    await g.auto.found([reading('b')])
    expect(g.auto.waiting('b')).not.toBeNull()
    await g.turn(false)
    g.set('b', { onScreen: false })
    await g.auto.moved()
    expect(g.applied).toEqual([])
    expect(g.auto.said().waiting).toEqual({})
  })

  test('turning it on takes what the last checks found, with no check of its own', async () => {
    const h = harness({ a: {} })
    await h.turn(false)
    await h.auto.found([reading('a')])
    expect(h.applied).toEqual([])
    await h.turn(true)
    expect(h.applied).toEqual(['a'])
  })

  test('a failure backs off to the next check, never a loop', async () => {
    let fail = true
    const h = harness({ a: {} }, () => (fail ? { ok: false, why: 'bun install failed' } : { ok: true, checkout: null }))
    await h.auto.found([reading('a')])
    expect(h.applied).toEqual(['a'])
    expect(h.auto.waiting('a')).toMatchObject({ until: 'retry', detail: 'bun install failed' })
    /* Every re-decision between checks leaves it alone. */
    for (let i = 0; i < 5; i += 1) await h.auto.moved()
    /* So does a check that comes too soon (a second window, a focus). */
    h.later(60_000)
    await h.auto.found([reading('a')])
    expect(h.applied).toEqual(['a'])
    /* The next check proper tries again. */
    fail = false
    h.later(RETRY_AFTER_MS)
    await h.auto.found([reading('a')])
    expect(h.applied).toEqual(['a', 'a'])
    expect(h.auto.waiting('a')).toBeNull()
    expect(h.auto.said().updated).toHaveLength(1)
  })

  test('one already taken by a press, or put in place when it stopped, is skipped, not failed', async () => {
    const h = harness({ a: {} }, () => ({ ok: 'skipped' }))
    await h.auto.found([reading('a')])
    expect(h.auto.waiting('a')).toBeNull()
    expect(h.auto.said().updated).toEqual([])
  })

  test('a person pressing Update clears what the switch was waiting for', async () => {
    const h = harness({ a: { running: true, onScreen: true } })
    await h.auto.found([reading('a')])
    expect(h.auto.waiting('a')).not.toBeNull()
    h.auto.settled('a')
    h.set('a', { onScreen: false })
    await h.auto.moved()
    expect(h.applied).toEqual([])
  })

  test('a major jump is applied and said as major', async () => {
    const h = harness({ a: {} })
    await h.auto.found([reading('a', { target: 'v2.0.0', newest: 'v2.0.0' })])
    expect(h.auto.said().updated).toMatchObject([{ id: 'a', from: '1.5.0', to: '2.0.0', major: true }])
  })

  test('one at a time; queued modules are held back from starting until theirs is done', async () => {
    const order: string[] = []
    let release1: () => void = () => {}
    const h = harness({ a: {}, b: {} })
    const auto = new AutoUpdates({
      on: () => true,
      facts: (id) => ({ name: id, installed: true, pinned: [], running: false, onScreen: false, holdsShells: false, kept: false, busy: false }),
      async apply(id) {
        order.push(`start ${id}`)
        if (id === 'a') await new Promise<void>((done) => (release1 = done))
        order.push(`end ${id}`)
        return { ok: true, checkout: null }
      },
      changed: () => {},
      log: () => {},
    })
    const going = auto.found([reading('a'), reading('b')])
    await Promise.resolve()
    expect(auto.pending('a')).toBe(true)
    expect(auto.pending('b')).toBe(true)
    release1()
    await going
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
    expect(auto.pending('a') || auto.pending('b')).toBe(false)
    void h
  })
})

describe('an app restart brings the modules along', () => {
  test('what waited on screen before the restart is put in place before its module first starts', async () => {
    /* Before: Journeys was on screen, so its update waited. */
    const before = harness({ 'kehikot.journeys': { running: true, onScreen: true } })
    await before.auto.found([reading('kehikot.journeys')])
    expect(before.applied).toEqual([])

    /* "Restart to update": the host stopped the modules it started, and a new host reads
       the copies' own tags (the check fetched them) before anything is started. */
    const after = harness({ 'kehikot.journeys': { running: false, onScreen: false }, 'kehikot.terminal': { running: false, holdsShells: true } })
    const booting = after.auto.found([reading('kehikot.journeys'), reading('kehikot.terminal', { installed: 'v0.9.0', target: 'v1.0.0' })])
    /* Held back from starting from the moment it was read. */
    expect(after.auto.pending('kehikot.journeys')).toBe(true)
    expect(after.auto.pending('kehikot.terminal')).toBe(true)
    await booting
    expect(after.applied).toEqual(['kehikot.journeys', 'kehikot.terminal'])
    expect(after.auto.said().updated.map((one) => one.id).sort()).toEqual(['kehikot.journeys', 'kehikot.terminal'])
  })

  test('a module kept running across the restart still waits for its stop', async () => {
    const after = harness({ 'kehikot.terminal': { running: true, holdsShells: true, kept: true } })
    await after.auto.found([reading('kehikot.terminal')])
    expect(after.applied).toEqual([])
    expect(after.auto.waiting('kehikot.terminal')).toMatchObject({ until: 'stopped' })
  })
})

describe('the switch is stored on this machine, on by default', () => {
  const fresh = () => {
    const db = new Database(':memory:')
    db.exec('create table if not exists settings (key text primary key, value text not null)')
    return db
  }

  test('on for a new install and for one from before the switch; off once turned off', () => {
    const db = fresh()
    expect(readAutoUpdates(db)).toBe(true)
    writeAutoUpdates(db, false)
    expect(readAutoUpdates(db)).toBe(false)
    writeAutoUpdates(db, true)
    expect(readAutoUpdates(db)).toBe(true)
    db.query("insert into settings (key, value) values ('module-updates', 'not json') on conflict (key) do update set value = excluded.value").run()
    expect(readAutoUpdates(db)).toBe(true)
  })

  test('POST /host/settings { updates: { auto } } changes it and says so', async () => {
    const db = fresh()
    const heard: boolean[] = []
    const route = settingsRoute({
      db,
      status: () => ({ at: 0, running: false, problems: [], modules: [] }),
      changed: () => {},
      updatesChanged: (auto) => heard.push(auto),
      skillsAt: () => '/scratch/.claude/skills',
      hook: () => ({ file: '/scratch/.claude/settings.json', on: false }),
    })
    const url = new URL('http://127.0.0.1/host/settings')
    const got = await (await route(new Request(url), url))!.json()
    expect(got.updates).toEqual({ auto: true })
    const post = (body: unknown) => route(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url)
    const off = await (await post({ updates: { auto: false } }))!.json()
    expect(off.updates).toEqual({ auto: false })
    expect(readAutoUpdates(db)).toBe(false)
    expect(heard).toEqual([false])
    /* The same again is no change, and says nothing. */
    await post({ updates: { auto: false } })
    expect(heard).toEqual([false])
    expect((await post({ updates: { auto: 'yes' } }))!.status).toBe(400)
  })
})

describe("What's new tells of it", () => {
  const at = (release: string | null) => ({ release, commit: release ? null : 'abc1234' })
  const module = (id: string, position: ReturnType<typeof at>) => ({ id, name: id, repo: null, follows: 'release' as const, position, range: [position.release!], works: {} })

  test('an install from before the switch is told once that modules update themselves; a new install is not', () => {
    const old = { app: '0.1.60', modules: {}, show: true }
    expect(notesDue(old, { [AUTO_UPDATES_NOTE]: true })).toEqual([AUTO_UPDATES_NOTE])
    /* Turned off before it was read: there is nothing to announce. */
    expect(notesDue(old, { [AUTO_UPDATES_NOTE]: false })).toEqual([])
    const fresh = baselined(null, '0.1.61', {})
    expect(notesDue(fresh, { [AUTO_UPDATES_NOTE]: true })).toEqual([])

    const answer: WhatsNewAnswer = { record: old, modules: [], updating: [], notes: [AUTO_UPDATES_NOTE] }
    const items = newsItems({ answer, app: null, appTags: null })
    expect(items).toMatchObject([{ kind: 'note', name: 'Modules now update themselves', news: true }])
    expect(noticeSaid(items)).toEqual({ text: 'What’s new', label: 'What’s new: modules now update themselves — press to read' })
    /* Read once, never again. */
    const told = acknowledged(old, ackFor(items))
    expect(notesDue(told, { [AUTO_UPDATES_NOTE]: true })).toEqual([])
  })

  test('what updated automatically is listed as news, a major one by name in the bar', () => {
    const record = { app: null, modules: { 'kehikot.paper': at('v1.4.0') }, show: true }
    const answer: WhatsNewAnswer = { record, modules: [module('kehikot.paper', at('v2.0.0'))], updating: [], auto: ['kehikot.paper'] }
    const items = newsItems({ answer, app: null, appTags: null })
    expect(items).toMatchObject([{ id: 'kehikot.paper', news: true, major: true, auto: true, from: '1.4.0', to: '2.0.0' }])
    expect(noticeSaid(items)).toEqual({
      text: 'What’s new · kehikot.paper 2.0.0',
      label: 'What’s new: 1 module; kehikot.paper 2.0.0 is a major update — press to read',
    })
  })
})

describe('the Updates menu says what waits, and does not count it', () => {
  test('a scheduled update is a row with its reason, and the header does not ask for a press', () => {
    const one = { ...reading('kehikot.terminal'), name: 'Terminal' }
    const row = moduleRow(one, null, null, undefined, { auto: { until: 'stopped', target: 'v1.6.0', detail: null, shells: true } })
    expect(row.state).toBe('scheduled')
    expect(row.autoSaid).toBe('Terminal updates when its sessions end')
    expect(indicator([row])).toBeNull()
    /* Without the switch's word it is an update waiting for a press, as before. */
    expect(indicator([moduleRow(one, null, null)])).toEqual({ label: '1 update', tone: 'info' })
  })

  test('a failed automatic update stays offered, with why', () => {
    const one = { ...reading('kehikot.notes'), name: 'Notes' }
    const row = moduleRow(one, null, null, undefined, { auto: { until: 'retry', target: 'v1.6.0', detail: 'bun install failed', } })
    expect(row.state).toBe('available')
    expect(row.autoFailed).toBe(true)
    expect(row.autoSaid).toContain('could not be updated to 1.6.0: bun install failed')
  })
})
