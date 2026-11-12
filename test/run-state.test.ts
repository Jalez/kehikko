import { afterEach, describe, expect, test } from 'bun:test'

import { askStart, askStop, dotOf, lookOf, runControl, runStateOf, RUN_LABELS, STARTED_OUTSIDE_STOP } from '../src/host/runState.ts'

describe('the dot, in words', () => {
  test('every state has its sentence, and only running is green', () => {
    expect(RUN_LABELS).toEqual({
      running: 'Running',
      starting: 'Starting…',
      asleep: 'Asleep: starts when a kehikko uses it',
      stopped: 'Stopped: press Start to run it',
      'not-running': 'Not running',
      'not-answering': 'Not answering',
      'not-installed': 'Not installed',
    })
    const green = (Object.keys(RUN_LABELS) as Array<keyof typeof RUN_LABELS>).filter((state) => lookOf(state).colour.includes('emerald'))
    expect(green).toEqual(['running'])
  })

  test('the state from what the host knows', () => {
    expect(runStateOf({ condition: 'ready' })).toBe('running')
    expect(runStateOf({ condition: 'silent', lifecycle: 'asleep' })).toBe('asleep')
    for (const lifecycle of ['starting', 'installing', 'updating', 'restarting', 'loading'] as const) {
      expect(runStateOf({ condition: 'silent', lifecycle })).toBe('starting')
    }
    expect(runStateOf({ condition: 'silent', stopped: true })).toBe('stopped')
    expect(runStateOf({ condition: 'silent', reached: true })).toBe('not-answering')
    expect(runStateOf({ condition: 'incompatible' })).toBe('not-answering')
    expect(runStateOf({ condition: 'silent', reached: false })).toBe('not-running')
  })

  test('states that share a colour have different shapes or different words', () => {
    const greys = (Object.keys(RUN_LABELS) as Array<keyof typeof RUN_LABELS>).map(lookOf)
    const keys = greys.map((look) => `${look.shape}|${look.label}`)
    expect(new Set(keys).size).toBe(keys.length)
    /* Asleep, starting and not installed are told apart by shape too. */
    const shapes = new Set([lookOf('asleep').shape, lookOf('stopped').shape, lookOf('not-installed').shape, lookOf('not-answering').shape, lookOf('running').shape])
    expect(shapes.size).toBe(5)
    expect(dotOf({ condition: 'ready' }).label).toBe('Running')
  })
})

describe('what a row offers', () => {
  test('Stop for a module the host started and holds, even while it is coming up', () => {
    expect(runControl({ run: 1, dir: '/m', reached: true, condition: 'ready' })).toEqual({ kind: 'stop' })
    expect(runControl({ run: 1, dir: '/m', reached: false, condition: 'silent' })).toEqual({ kind: 'stop' })
  })

  test('a module started outside Kehikot gets Stop, disabled, with the reason', () => {
    expect(runControl({ dir: '/m', reached: true, condition: 'ready' })).toEqual({ kind: 'stop-disabled', why: STARTED_OUTSIDE_STOP })
    expect(runControl({ reached: true, condition: 'ready' })).toEqual({ kind: 'stop-disabled', why: 'Started outside Kehikot: stop it where it runs' })
  })

  test('Start when it is not running and has a directory; nothing without one', () => {
    expect(runControl({ dir: '/m', reached: false, condition: 'silent' })).toEqual({ kind: 'start' })
    expect(runControl({ reached: false, condition: 'silent' })).toBeNull()
  })
})

describe('the presses hit the right routes', () => {
  const real = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = real
  })
  test('Stop posts to /host/stop-module and Start to /host/start, each with the one module', async () => {
    const seen: Array<[string, string, string]> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push([String(url), String(init.method), String(init.body)])
      return new Response(JSON.stringify({ ok: false, why: 'No.' }), { status: 409 })
    }) as unknown as typeof fetch
    expect(await askStop('me.a')).toEqual({ ok: false, why: 'No.' })
    await askStart('me.a')
    expect(seen).toEqual([
      ['/host/stop-module', 'POST', '{"module":"me.a"}'],
      ['/host/start', 'POST', '{"module":"me.a"}'],
    ])
  })
})
