import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'

import { RESTART_REASON_ENV, RESTART_VERSION_ENV, WORK_QUEUE } from 'kehikot-module-protocol'

import { BOOT_WINDOW_MS, REASON_FRESH_MS, RestartEnv, RestartHold, takeRestartReason, writeRestartReason, type QueueProvider } from '../server/restartHold.ts'
import { askRestart, heldSaid, restartState } from '../src/host/restartQueue.ts'

/* Protocol 2.110.0: why a module was started again, and an app restart held behind queued work. */

describe('the reason the last host saved', () => {
  test('read once by the next host, when fresh', () => {
    const db = new Database(':memory:')
    writeRestartReason(db, { reason: 'app-update', version: '0.7.36' }, 1_000)
    expect(takeRestartReason(db, 2_000)).toEqual({ reason: 'app-update', version: '0.7.36' })
    expect(takeRestartReason(db, 3_000)).toBeNull()
  })
  test('a stale one, or one from the future, is no reason', () => {
    const db = new Database(':memory:')
    writeRestartReason(db, { reason: 'app-restart', version: null }, 1_000)
    expect(takeRestartReason(db, 1_000 + REASON_FRESH_MS + 1)).toBeNull()
    writeRestartReason(db, { reason: 'app-restart', version: null }, 5_000)
    expect(takeRestartReason(db, 1_000)).toBeNull()
  })
})

describe('what a module is told at its start', () => {
  test('the app’s reason, for modules started in the first minutes', () => {
    let now = 0
    const env = new RestartEnv({ reason: 'app-update', version: '0.7.36' }, 0, () => now)
    expect(env.envFor('kehikot.claude')).toEqual({ [RESTART_REASON_ENV]: 'app-update', [RESTART_VERSION_ENV]: '0.7.36' })
    now = BOOT_WINDOW_MS + 1
    expect(env.envFor('kehikot.claude')).toEqual({})
  })
  test('this host’s own update or restart of one module, for its next start only', () => {
    const env = new RestartEnv(null, 0, () => 0)
    env.note('kehikot.codex', 'module-update')
    expect(env.envFor('kehikot.claude')).toEqual({})
    expect(env.envFor('kehikot.codex')).toEqual({ [RESTART_REASON_ENV]: 'module-update' })
    expect(env.envFor('kehikot.codex')).toEqual({})
  })
})

describe('holding a restart behind queued work', () => {
  const queue = { module: 'kehikot.queue', name: 'Queue', descriptor: { name: 'Queue', run: { test: 'q run -- {command}' }, hold: '/api/hold' } }
  const TOKEN = 'abcdefghij0123456789'
  const hold = (answer: unknown, providers: QueueProvider[] = [queue]) => {
    const calls: unknown[] = []
    const h = new RestartHold({ providers: () => providers, call: async (module, path, body) => (calls.push({ module, path, body }), answer), token: () => TOKEN, clock: () => 7 })
    return { h, calls }
  }

  test('held by the work queue that says hold: it waits, and only that queue’s token lets it go', async () => {
    const { h, calls } = hold({ held: true, ahead: 2 })
    const asked = await h.ask({ reason: 'app-update', version: '0.7.36', label: 'Restart Kehikot to update to 0.7.36' })
    expect(asked).toEqual({ held: true, restart: { reason: 'app-update', version: '0.7.36', by: 'Queue', ahead: 2, at: 7 } })
    expect(calls).toEqual([{ module: 'kehikot.queue', path: '/api/hold', body: { token: TOKEN, reason: 'app-update', label: 'Restart Kehikot to update to 0.7.36' } }])
    expect(h.release('kehikot.other', { token: TOKEN, go: true }).outcome).toBe('unknown')
    expect(h.release('kehikot.queue', { token: 'zyxwvutsrq9876543210', go: true }).outcome).toBe('unknown')
    expect(h.release('kehikot.queue', { token: TOKEN, go: true })).toEqual({ outcome: 'restarting', why: '', restart: { reason: 'app-update', version: '0.7.36' } })
    expect(h.state()).toBeNull()
  })

  test('cancelled in the queue: let go, no restart', async () => {
    const { h } = hold({ held: true, ahead: 1 })
    await h.ask({ reason: 'app-update', version: null, label: 'Restart Kehikot' })
    expect(h.release('kehikot.queue', { token: TOKEN, go: false })).toEqual({ outcome: 'cancelled', why: '' })
    expect(h.release('kehikot.queue', { token: TOKEN, go: true }).outcome).toBe('unknown')
  })

  test('not held — go now — with no queue that holds, nothing ahead, or a queue that cannot be asked', async () => {
    expect(await hold({ held: true, ahead: 1 }, []).h.ask({ reason: 'app-update', version: null, label: 'x' })).toEqual({ held: false, why: null })
    const noHold = { ...queue, descriptor: { name: 'Queue', run: { test: 'q run -- {command}' } } }
    expect(await hold({ held: true, ahead: 1 }, [noHold]).h.ask({ reason: 'app-update', version: null, label: 'x' })).toEqual({ held: false, why: null })
    expect(await hold({ held: false, ahead: 0 }).h.ask({ reason: 'app-update', version: null, label: 'x' })).toEqual({ held: false, why: null })
    const failing = new RestartHold({ providers: () => [queue], call: async () => Promise.reject(new Error('it did not answer within 3 s')) })
    const said = await failing.ask({ reason: 'app-update', version: null, label: 'x' })
    expect(said.held).toBe(false)
    expect((said as { why: string }).why).toContain('Queue could not be asked')
  })

  test('Restart now lets the hold go', async () => {
    const { h } = hold({ held: true, ahead: 3 })
    await h.ask({ reason: 'app-update', version: '1.0.0', label: 'x' })
    expect(h.drop()?.version).toBe('1.0.0')
    expect(h.release('kehikot.queue', { token: TOKEN, go: true }).outcome).toBe('unknown')
  })

  test('the work queue is found by its service, never by a name', () => {
    expect(WORK_QUEUE).toBe('work.queue')
  })
})

describe('the page', () => {
  const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  test('a hold is said; anything else is go now', async () => {
    const restart = { reason: 'app-update' as const, version: '0.7.36', by: 'Queue', ahead: 2, at: 1 }
    expect(await askRestart('0.7.36', answering(200, { held: true, restart }))).toEqual({ held: true, restart })
    expect(await askRestart('0.7.36', answering(200, { held: false, page: true }))).toEqual({ held: false })
    expect(await askRestart('0.7.36', answering(404, {}))).toEqual({ held: false })
    expect(await askRestart('0.7.36', (async () => Promise.reject(new Error('down'))) as unknown as typeof fetch)).toEqual({ held: false })
  })
  test('the state says what is held and whether to apply now', async () => {
    expect(await restartState(answering(200, { held: null, go: { version: '0.7.36' } }))).toEqual({ held: null, go: true })
    expect(await restartState(answering(200, { held: null, go: null }))).toEqual({ held: null, go: false })
  })
  test('the words', () => {
    expect(heldSaid({ reason: 'app-update', version: null, by: 'Queue', ahead: 2, at: 0 })).toBe('Waiting in Queue: restarts when the 2 runs ahead finish.')
    expect(heldSaid({ reason: 'app-update', version: null, by: 'Queue', ahead: 1, at: 0 })).toBe('Waiting in Queue: restarts when the run ahead finishes.')
  })
})
