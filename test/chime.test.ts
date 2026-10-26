import { describe, expect, test } from 'bun:test'

import {
  Burst,
  chimeFrom,
  chimePatched,
  choiceOf,
  DEFAULT_CHIME,
  DEFAULT_SOUNDS,
  durationMs,
  fellBackWords,
  kindOf,
  loudest,
  PRESETS,
  playsHere,
  soundFor,
  soundOfChoice,
  tuneFor,
  validTune,
  withoutFile,
  type ChimeSettings,
  type Kind,
  type Tune,
} from '../src/host/chime.ts'
import { placeOpened } from '../src/host/activity.ts'
import { applyList } from '../src/host/inbox.ts'

/* The decision to chime: which entries are news, which kind they are, what a burst plays, which window. */

const item = (id: string, state: 'attention' | 'working' | 'done', extra = {}) => ({ id, state, label: id, ...extra }) as never

describe('what chimes', () => {
  test('a new item that enters attention or done is news, and has a kind', () => {
    /* The first list after the page loaded: only what is newer than the page. */
    const out = applyList([], 'kehikot.claude', 'Claude', [item('a', 'attention', { since: 2000 }), item('b', 'done', { since: 2000 })], { now: 3000, loadedAt: 1000 })
    expect(out.news.map((one) => kindOf(one))).toEqual(['attention', 'done'])
  })

  test('items already there when the page loads do not chime', () => {
    const out = applyList([], 'kehikot.claude', 'Claude', [item('a', 'attention', { since: 100 }), item('b', 'done')], { now: 3000, loadedAt: 1000 })
    /* `a` is older than the page; `b` has no `since` and so cannot be shown to be new. */
    expect(out.news.map((one) => one.id)).toEqual([])
  })

  test('working is never a sound; a notice and an urgent item have their own kinds', () => {
    const base = { priority: 'normal' as const, origin: 'activity' as const }
    expect(kindOf({ ...base, state: 'working' })).toBeNull()
    expect(kindOf({ ...base, state: 'attention' })).toBe('attention')
    expect(kindOf({ ...base, priority: 'urgent', state: 'attention' })).toBe('urgent')
    expect(kindOf({ ...base, state: 'done' })).toBe('done')
    expect(kindOf({ ...base, origin: 'notice', state: 'done' })).toBe('notice')
    expect(kindOf({ ...base, origin: 'notice', state: 'attention' })).toBe('attention')
  })

  test('a place on screen is the existing rule, and is not chimed for', () => {
    const at = { epic: 'e1', parts: [], kehikko: 'k1' }
    expect(placeOpened({ epic: 'e1', kehikko: 'k1' }, at as never)).toBe(true)
    expect(placeOpened({ epic: 'e2' }, at as never)).toBe(false)
  })
})

describe('a burst', () => {
  const clock = () => {
    let now = 0
    const timers: { at: number; run(): void }[] = []
    return {
      now: () => now,
      after: (run: () => void, ms: number) => timers.push({ at: now + ms, run }),
      advance(ms: number) {
        now += ms
        for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
          if (timer.at <= now) timer.run()
          else timers.push(timer)
        }
      },
    }
  }

  test('plays once, and the most urgent kind wins', () => {
    const c = clock()
    const heard: [Kind, string | undefined][] = []
    const burst = new Burst((kind, module) => heard.push([kind, module]), c)
    burst.offer('notice', 'a')
    burst.offer('done', 'b')
    burst.offer('urgent', 'c')
    burst.offer('attention', 'd')
    c.advance(400)
    expect(heard).toEqual([['urgent', 'c']])
  })

  test('is quiet for about three seconds after, then plays again', () => {
    const c = clock()
    const heard: Kind[] = []
    const burst = new Burst((kind) => heard.push(kind), c)
    burst.offer('done')
    c.advance(400)
    c.advance(1000)
    burst.offer('attention')
    c.advance(400)
    expect(heard).toEqual(['done'])
    c.advance(3000)
    burst.offer('attention')
    c.advance(400)
    expect(heard).toEqual(['done', 'attention'])
  })

  test('urgency order is urgent, needs you, finished, notice', () => {
    expect(loudest(['notice', 'done', 'attention'])).toBe('attention')
    expect(loudest(['notice', 'done'])).toBe('done')
    expect(loudest([])).toBeNull()
  })
})

describe('which window plays', () => {
  const peer = (id: string, focusedAt: number, heardAt = 1000) => ({ id, focusedAt, heardAt })
  test('the one focused most recently', () => {
    expect(playsHere(peer('a', 500), [peer('b', 400)], 1000)).toBe(true)
    expect(playsHere(peer('b', 400), [peer('a', 500)], 1000)).toBe(false)
  })
  test('never two on a tie, and a window nobody has heard from lately does not count', () => {
    expect(playsHere(peer('a', 5), [peer('b', 5)], 1000)).toBe(true)
    expect(playsHere(peer('b', 5), [peer('a', 5)], 1000)).toBe(false)
    expect(playsHere(peer('b', 0), [peer('a', 900, 0)], 100_000)).toBe(true)
  })
})

describe('the tune', () => {
  const good: Tune = { notes: [72, null, 79], tempo: 120, wave: 'sine', volume: 0.5 }
  test('is valid only with notes from the scale, bounded tempo and volume', () => {
    expect(validTune(good)).toEqual(good)
    expect(validTune({ ...good, notes: [72, 73, 79] })).toBeNull()
    expect(validTune({ ...good, notes: [72, 79] })).toBeNull()
    expect(validTune({ ...good, notes: [72, 72, 72, 72, 72, 72] })).toBeNull()
    expect(validTune({ ...good, notes: [null, null, null] })).toBeNull()
    expect(validTune({ ...good, tempo: 10 })).toBeNull()
    expect(validTune({ ...good, tempo: 999 })).toBeNull()
    expect(validTune({ ...good, volume: 0 })).toBeNull()
    expect(validTune({ ...good, volume: 2 })).toBeNull()
    expect(validTune({ ...good, wave: 'saw' })).toBeNull()
    expect(validTune('x')).toBeNull()
  })

  test('the soft form is the first two notes, an octave down, quieter; urgent is twice', () => {
    expect(tuneFor(good, 'attention')).toEqual(good)
    const soft = tuneFor(good, 'done')
    expect(soft.notes).toEqual([60, 67])
    expect(soft.volume).toBeLessThan(good.volume)
    expect(tuneFor(good, 'notice')).toEqual(soft)
    const urgent = tuneFor(good, 'urgent')
    expect(urgent.notes).toEqual([72, null, 79, null, 72, null, 79])
    expect(urgent.volume).toBeGreaterThan(good.volume)
  })

  test('every built-in chime is a short one, and its soft form shorter', () => {
    for (const one of PRESETS) {
      expect(durationMs(one.tune)).toBeGreaterThanOrEqual(300)
      expect(durationMs(one.tune)).toBeLessThanOrEqual(560)
      expect(durationMs(tuneFor(one.tune, 'done'))).toBeLessThanOrEqual(durationMs(one.tune))
    }
  })
})

describe('the settings', () => {
  const file = { id: '0123456789abcdef', name: 'cheer.wav', ext: 'wav', bytes: 1000, seconds: 1.5 }
  const withFile: ChimeSettings = { ...DEFAULT_CHIME, files: [file] }

  test('are on, with a different default for each kind', () => {
    expect(DEFAULT_CHIME.on).toBe(true)
    expect(new Set(Object.values(DEFAULT_SOUNDS).map(choiceOf)).size).toBe(4)
  })

  test('a stored row that is wrong falls back, part by part', () => {
    const got = chimeFrom({ on: 'yes', sounds: { done: { type: 'preset', id: 'nope' }, urgent: { type: 'none' } }, custom: { notes: [1] } })
    expect(got.on).toBe(true)
    expect(got.sounds.done).toEqual(DEFAULT_SOUNDS.done)
    expect(got.sounds.urgent).toEqual({ type: 'none' })
    expect(got.custom).toEqual(DEFAULT_CHIME.custom)
  })

  test('a change takes a preset, mute, a tune and a module override, and refuses the rest', () => {
    const next = chimePatched(withFile, { on: false, sounds: { done: { type: 'file', id: file.id } }, modules: { 'kehikot.claude': { attention: { type: 'preset', id: 'playful' } } } })!
    expect(next.on).toBe(false)
    expect(next.sounds.done).toEqual({ type: 'file', id: file.id })
    expect(soundFor(next, 'attention', 'kehikot.claude')).toEqual({ type: 'preset', id: 'playful' })
    expect(soundFor(next, 'attention', 'kehikot.factory')).toEqual(DEFAULT_SOUNDS.attention)
    expect(chimePatched(next, { modules: { 'kehikot.claude': { attention: null } } })!.modules).toEqual({})
    expect(chimePatched(withFile, { sounds: { done: { type: 'file', id: 'ffffffffffffffff' } } })).toBeNull()
    expect(chimePatched(withFile, { sounds: { done: { type: 'preset', id: 'nope' } } })).toBeNull()
    expect(chimePatched(withFile, { sounds: { loud: { type: 'none' } } })).toBeNull()
    expect(chimePatched(withFile, { custom: { notes: [61, 62, 64], tempo: 100, wave: 'sine', volume: 0.5 } })).toBeNull()
    expect(chimePatched(withFile, { on: 'no' })).toBeNull()
    expect(chimePatched(withFile, {})).toBeNull()
    expect(chimePatched(withFile, { modules: { '../x': { done: { type: 'none' } } } })).toBeNull()
  })

  test('the choice of a picker round-trips', () => {
    for (const sound of [{ type: 'none' }, { type: 'custom' }, { type: 'preset', id: 'bell' }, { type: 'file', id: file.id }] as const) {
      expect(soundOfChoice(choiceOf(sound))).toEqual(sound)
    }
    expect(soundOfChoice('what')).toBeNull()
  })

  test('removing a sound that is in use puts the kind back to its default and says so', () => {
    const using = chimePatched(withFile, { sounds: { done: { type: 'file', id: file.id } }, modules: { 'kehikot.claude': { notice: { type: 'file', id: file.id } } } })!
    const out = withoutFile(using, file.id)
    expect(out.settings.files).toEqual([])
    expect(out.settings.sounds.done).toEqual(DEFAULT_SOUNDS.done)
    expect(out.settings.modules).toEqual({})
    expect(out.fellBack).toEqual(['done'])
    expect(out.modules).toEqual(['kehikot.claude'])
    expect(fellBackWords(file.name, out.fellBack, out.modules)).toContain('went back to')
    expect(fellBackWords(file.name, [], [])).toBe('')
  })

  test('a file that is gone plays the default, never nothing by accident', () => {
    const broken: ChimeSettings = { ...DEFAULT_CHIME, sounds: { ...DEFAULT_SOUNDS, done: { type: 'file', id: 'ffffffffffffffff' } } }
    expect(soundFor(broken, 'done')).toEqual(DEFAULT_SOUNDS.done)
  })
})
