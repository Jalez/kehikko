import { describe, expect, test } from 'bun:test'

import type { Check, Checkout, Updated } from '../src/host/updates.ts'
import {
  derive,
  idsToUpdate,
  initialState,
  outcomeOf,
  toldOf,
  updatesReducer,
  type EngineAction,
  type EngineState,
} from '../src/host/updatesEngine.ts'

/*
 * The update engine's reducer (`host/updatesEngine.ts`): every transition the
 * Updates menu and the module list read, without React and without a server.
 * The rendered engine is `updates-panel.test.tsx`.
 */

const one = (id: string, over: Partial<Checkout> = {}): Checkout => ({
  id,
  name: id,
  dir: `/${id}`,
  branch: 'main',
  commit: 'abc1234',
  dirty: false,
  upstream: 'origin/main',
  behind: 0,
  ahead: 0,
  incoming: [],
  fetchFailed: null,
  blocked: 'already up to date',
  ...over,
})
const behind = (id: string, over: Partial<Checkout> = {}) => one(id, { behind: 2, blocked: null, ...over })

const checkOf = (checkouts: Checkout[], over: Partial<Check> = {}): Check => ({
  checked: new Date(1_000),
  checkouts,
  pins: {},
  restartable: false,
  progress: {},
  stale: {},
  older: {},
  previews: {},
  kept: [],
  holds: [],
  protocol: null,
  builds: {},
  auto: null,
  ...over,
})

const done = (checkout: Checkout, over: Partial<Updated> = {}): Updated => ({
  checkout,
  changed: ['a.ts'],
  installed: false,
  installFailed: null,
  restart: null,
  module: { ran: 'restarted' },
  ...over,
})

const start = () => initialState(new Date(0))
const play = (state: EngineState, ...actions: EngineAction[]) => actions.reduce(updatesReducer, state)

describe('a check', () => {
  test('out loud shows checking and clears the notice; ending it goes back to idle and moves the clock', () => {
    const was = { ...start(), notice: 'old' }
    const checking = play(was, { type: 'checkStarted', loud: true })
    expect(checking.phase).toEqual({ kind: 'checking' })
    expect(checking.notice).toBeNull()
    expect(checking.quietly).toBe(false)
    const ended = play(checking, { type: 'checkEnded', loud: true, now: new Date(5) })
    expect(ended.phase).toEqual({ kind: 'idle' })
    expect(ended.now).toEqual(new Date(5))
  })

  test('a quiet one only pulses, and leaves the notice alone', () => {
    const was = { ...start(), notice: 'kept' }
    const quiet = play(was, { type: 'checkStarted', loud: false })
    expect(quiet.quietly).toBe(true)
    expect(quiet.phase).toEqual({ kind: 'idle' })
    expect(quiet.notice).toBe('kept')
    expect(play(quiet, { type: 'checkEnded', loud: false, now: new Date(5) }).quietly).toBe(false)
  })

  test('what it found replaces the last failure; a re-read keeps it', () => {
    const failed = play(start(), { type: 'checkFailed', at: new Date(9), why: 'offline' })
    expect(failed.failed).toEqual({ at: new Date(9), why: 'offline' })
    const check = checkOf([one('a')])
    expect(play(failed, { type: 'read', check }).failed).not.toBeNull()
    const found = play(failed, { type: 'checked', check })
    expect(found.check).toBe(check)
    expect(found.failed).toBeNull()
  })

  test('a cancelled loud check says so; a cancelled quiet one says nothing', () => {
    expect(play(start(), { type: 'checkCancelled', loud: true }).notice).toContain('Check cancelled')
    expect(play(start(), { type: 'checkCancelled', loud: false })).toEqual(start())
  })
})

describe('the panel', () => {
  test('opening forgets what was done, except a host update that waits on a restart', () => {
    const was: EngineState = {
      ...start(),
      showLevel: true,
      skipped: [{ id: 'x', name: 'x', why: 'no' }],
      outcomes: {
        host: { kind: 'updated', note: 'n', restart: 'host', installFailed: null },
        a: { kind: 'updated', note: 'n', restart: null, installFailed: null },
        b: { kind: 'failed', why: 'w' },
      },
    }
    const opened = play(was, { type: 'opened' })
    expect(opened.open).toBe(true)
    expect(Object.keys(opened.outcomes)).toEqual(['host'])
    expect(opened.showLevel).toBe(false)
    expect(opened.skipped).toEqual([])
  })

  test('closing drops an arm and the asked-for module', () => {
    const was: EngineState = { ...start(), open: true, asked: 'a', armed: { id: 'a', token: 't', sentence: 's', forMs: 1 } }
    const closed = play(was, { type: 'closed' })
    expect(closed).toMatchObject({ open: false, asked: null, armed: null })
  })

  test('the setters take a value or what to make of the one held', () => {
    expect(play(start(), { type: 'showLevelSet', showLevel: (was) => !was }).showLevel).toBe(true)
    expect(play(start(), { type: 'askedSet', asked: 'a' }).asked).toBe('a')
    expect(play(start(), { type: 'openSet', open: true }).open).toBe(true)
  })

  test('a module asked for by name is shown even when it is up to date', () => {
    expect(play(start(), { type: 'askedFor', module: 'a' })).toMatchObject({ asked: 'a', showLevel: true })
    expect(play(start(), { type: 'askedFor', module: null })).toMatchObject({ asked: null, showLevel: false })
  })
})

describe('updating', () => {
  test('each update moves through its phases, and finishing counts it', () => {
    const ids = ['a', 'b']
    let state = play(start(), { type: 'updateAllStarted', fetching: false }, { type: 'updateStarted', ids, id: 'a' })
    expect(state.phase).toEqual({ kind: 'updating', ids, running: { a: 'updating' }, finished: 0 })
    state = play(state, { type: 'updateStarted', ids, id: 'b' }, { type: 'phaseReached', id: 'a', phase: 'restarting' })
    expect(state.phase).toEqual({ kind: 'updating', ids, running: { a: 'restarting', b: 'updating' }, finished: 0 })
    state = play(state, { type: 'updateEnded', id: 'a' })
    expect(state.phase).toEqual({ kind: 'updating', ids, running: { b: 'updating' }, finished: 1 })
    state = play(state, { type: 'updateEnded', id: 'b' }, { type: 'updatesEnded', cancelled: false })
    expect(state.phase).toEqual({ kind: 'idle' })
    expect(state.notice).toBeNull()
  })

  test('a cancelled run says what was left as it was', () => {
    expect(play(start(), { type: 'updatesEnded', cancelled: true }).notice).toContain('Update cancelled')
  })

  test('fetching first shows checking, and lists what was not updated', () => {
    const was = { ...start(), notice: 'old', skipped: [{ id: 'z', name: 'z', why: 'w' }] }
    const fetching = play(was, { type: 'updateAllStarted', fetching: true })
    expect(fetching).toMatchObject({ notice: null, skipped: [], phase: { kind: 'checking' } })
    const dirty = behind('dirty', { dirty: true, blocked: 'there are uncommitted changes; commit or stash them first' })
    const found = checkOf([behind('a'), dirty])
    const fetched = play(fetching, { type: 'fetchedForUpdate', check: found })
    expect(fetched.check).toBe(found)
    expect(fetched.skipped.map((s) => s.id)).toEqual(['dirty'])
    expect(play(fetching, { type: 'fetchForUpdateFailed', why: 'offline' }).notice).toContain('offline')
  })

  test('only the asked-for checkouts that are ready after the fetch are updated', () => {
    const found = checkOf([behind('a'), behind('b'), one('c')])
    expect(idsToUpdate(found, ['a'], ['c', 'b'])).toEqual(['a', 'b'])
  })

  test('a finished update replaces its checkout, says its outcome and clears its staleness', () => {
    const was = { ...start(), check: checkOf([behind('a'), behind('b')], { stale: { a: 'old', b: 'old' }, older: { a: 'older' } }) }
    const state = play(was, { type: 'updateDone', id: 'a', done: done(one('a', { commit: 'def5678' })) })
    expect(state.check?.checkouts.map((c) => (c as Checkout).commit)).toEqual(['def5678', 'abc1234'])
    expect(state.check?.stale).toEqual({ b: 'old' })
    expect(state.check?.older).toEqual({})
    expect(state.outcomes.a?.kind).toBe('updated')
  })

  test('an update whose module still runs old code keeps it stale', () => {
    const was = { ...start(), check: checkOf([behind('a')], { stale: { a: 'old' } }) }
    const state = play(was, { type: 'updateDone', id: 'a', done: done(one('a'), { module: { ran: 'stale', why: 'busy' } }) })
    expect(state.check?.stale).toEqual({ a: 'old' })
    expect(state.outcomes.a).toMatchObject({ kind: 'failed', retry: true })
  })

  test('a failed update says why', () => {
    expect(play(start(), { type: 'updateFailed', id: 'a', why: 'nope' }).outcomes.a).toEqual({ kind: 'failed', why: 'nope' })
  })
})

describe('what an update came to', () => {
  test("the host's own checkout says to quit and reopen when Kehikot itself changed", () => {
    expect(outcomeOf('host', done(one('host'), { restart: 'host', module: null }))).toMatchObject({ kind: 'updated', restart: 'host' })
    const note = outcomeOf('host', done(one('host'), { restart: 'host', module: null }))
    expect(note.kind === 'updated' && note.note).toContain('Quit and reopen')
  })

  test('a module that did not start again can be retried', () => {
    expect(outcomeOf('a', done(one('a'), { module: { ran: 'failed', why: 'crashed', detail: ['x'] } }))).toEqual({
      kind: 'failed',
      why: 'Updated, but it did not start again. crashed',
      detail: ['x'],
      retry: true,
    })
  })

  test('commits that cancel out restart nothing', () => {
    const outcome = outcomeOf('a', done(one('a'), { changed: [], module: { ran: 'page' } }))
    expect(outcome.kind === 'updated' && outcome.note).toContain("wasn't restarted")
  })
})

describe('restarting from a row', () => {
  test('a retry is marked until it comes back, and drops an arm', () => {
    const was: EngineState = { ...start(), armed: { id: 'a', token: 't', sentence: 's', forMs: 1 } }
    const retrying = play(was, { type: 'restartStarted', id: 'a' }, { type: 'restartStarted', id: 'a' })
    expect(retrying.retryingIds).toEqual(['a'])
    expect(retrying.armed).toBeNull()
    const back = play(retrying, { type: 'restarted', id: 'a', failed: null })
    expect(back.retryingIds).toEqual([])
    expect(back.outcomes.a?.kind).toBe('updated')
    const refused = play(retrying, { type: 'restarted', id: 'a', failed: { why: 'kept', detail: [], kept: true } })
    expect(refused.outcomes.a).toEqual({ kind: 'failed', why: 'kept', detail: [], retry: true, kept: true })
  })

  test('"Restart anyway": arming, armed, refused and disarmed', () => {
    const arming = play(start(), { type: 'arming', id: 'a' })
    expect(arming.armingId).toBe('a')
    const armed = play(arming, { type: 'armed', id: 'a', armed: { token: 't', sentence: 'stops x', forMs: 5 } })
    expect(armed).toMatchObject({ armingId: null, armed: { id: 'a', token: 't', sentence: 'stops x', forMs: 5 } })
    expect(play(armed, { type: 'disarmed' }).armed).toBeNull()
    const refused = play(arming, { type: 'anywayRefused', id: 'a', said: { why: 'no', detail: [], kept: true } })
    expect(refused).toMatchObject({ armingId: null, armed: null, outcomes: { a: { kind: 'failed', why: 'no', retry: true, kept: true } } })
  })

  test('an app restart that is refused goes back to the list with why', () => {
    const restarting = play(start(), { type: 'appRestarting' })
    expect(restarting.restarting).toBe(true)
    expect(play(restarting, { type: 'appRestartRefused', why: 'no' })).toMatchObject({ restarting: false, notice: 'no' })
  })
})

describe('the app and the switch', () => {
  test('installing is said only over a ready update', () => {
    const ready = play(start(), { type: 'appStatus', status: { state: 'ready', current: '0.1.0', version: '0.1.1' } as never })
    expect(play(ready, { type: 'appInstalling' }).app?.state).toBe('installing')
    expect(play(start(), { type: 'appInstalling' }).app).toBeNull()
  })

  test('the switch moves at once, and a refusal says why', () => {
    const auto = { on: false, waiting: {}, updated: [] } as unknown as NonNullable<Check['auto']>
    const was = { ...start(), autoTrouble: 'old', check: checkOf([], { auto }) }
    const on = play(was, { type: 'autoSet', on: true })
    expect(on.check?.auto?.on).toBe(true)
    expect(on.autoTrouble).toBeNull()
    expect(play(on, { type: 'autoFailed', why: 'disk' }).autoTrouble).toBe('disk')
    expect(play(start(), { type: 'autoSet', on: true }).check).toBeNull()
  })
})

describe('what is drawn', () => {
  test('progress the server tells is left out for an update this page runs', () => {
    const check = checkOf([behind('a'), behind('b')], { progress: { a: 'installing', b: 'restarting' }, kept: ['b'], holds: ['b'] })
    const told = toldOf(check, {}, (id) => id === 'a')
    expect(told).toEqual({ b: { phase: 'restarting', kept: true, holds: true } })
  })

  test('status, count and the sets "Update all" works over', () => {
    const state = { ...start(), check: checkOf([behind('a'), behind('b'), one('c')]) }
    const seen = derive(state)
    expect(seen.count).toBe(4)
    expect(seen.ready.map((c) => c.id)).toEqual(['a', 'b'])
    expect(seen.level.map((c) => c.id)).toEqual(['c'])
    expect(seen.everything).toBe(2)
    expect(seen.status).toBe('4 new commits across 2 repositories.')
    expect(derive({ ...state, phase: { kind: 'checking' } }).status).toContain('Asking GitHub')
    expect(derive({ ...state, restarting: true }).status).toContain('Restarting Kehikot')
    expect(derive({ ...state, phase: { kind: 'updating', ids: ['a', 'b'], running: { a: 'restarting' }, finished: 1 } }).status).toBe('Restarting a (1 of 2 done)…')
  })

  test('a failure newer than the last check is the one said', () => {
    const state = { ...start(), check: checkOf([]), failed: { at: new Date(2_000), why: 'offline' } }
    expect(derive(state).lastFailed?.why).toBe('offline')
    expect(derive({ ...state, failed: { at: new Date(500), why: 'old' } }).lastFailed).toBeNull()
  })

  test('the asked-for row counts as drawn once it is in the list', () => {
    const state = { ...start(), asked: 'c', check: checkOf([behind('a'), one('c')]) }
    expect(derive(state).askedDrawn).toBe(true)
    expect(derive({ ...state, asked: 'z' }).askedDrawn).toBe(false)
  })
})
