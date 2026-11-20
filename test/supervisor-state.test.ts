import { describe, expect, test } from 'bun:test'

import { ExitRestarts } from '../server/lifecycle.ts'
import { ModuleStates } from '../server/supervisor/state.ts'

/*
 * What the supervisor believes about each module (`server/supervisor/state.ts`), and the events
 * that change several of those beliefs at once. The supervisor's behaviour with them is pinned
 * from outside in `supervisor.test.ts`.
 */

describe('ModuleStates', () => {
  test('a run: its end is the news, it is starting, and asleep or failed stops being believed', () => {
    const states = new ModuleStates()
    states.sleeping.set('a', 1)
    states.failures.set('a', { line: 'it stopped', detail: [] })
    states.ran('a', 5)
    expect(states.runs.get('a')).toBe(5)
    expect(states.starting.get('a')).toBe(5)
    expect(states.sleeping.has('a')).toBe(false)
    expect(states.failures.has('a')).toBe(false)
  })

  test('answering, however it came back: not starting, asleep or failed; its run is still the one whose end is news', () => {
    const states = new ModuleStates()
    states.ran('a', 5)
    states.sleeping.set('a', 6)
    states.failures.set('a', { line: 'x', detail: [] })
    states.answering('a')
    expect([states.starting.has('a'), states.sleeping.has('a'), states.failures.has('a')]).toEqual([false, false, false])
    expect(states.runs.get('a')).toBe(5)
  })

  test('a press: the ends are counted again and nothing waits', () => {
    let now = 0
    const states = new ModuleStates(new ExitRestarts(() => now))
    states.exitRestarts.ended('a')
    expect(states.exitRestarts.ended('a').wait).toBeGreaterThan(0)
    states.exitHeld.set('a', 10_000)
    expect(states.heldAfterEnd('a', 9_999)).toBe(true)
    expect(states.heldAfterEnd('a', 10_000)).toBe(false)
    states.pressed('a')
    expect(states.heldAfterEnd('a', 0)).toBe(false)
    now = 1
    expect(states.exitRestarts.ended('a')).toEqual({ wait: 0, times: 1 })
  })

  test('a module whose registration is gone is forgotten: starting, asleep, failed, stopped by the person, its scope', () => {
    const states = new ModuleStates()
    for (const id of ['gone', 'here']) {
      states.ran(id, 1)
      states.sleeping.set(id, 2)
      states.failures.set(id, { line: 'x', detail: [] })
      states.stoppedByPerson.stop(id)
      states.scopeRead.set(id, { id } as never)
    }
    states.forgetAllBut(new Set(['here']))
    expect([states.starting.has('gone'), states.sleeping.has('gone'), states.failures.has('gone'), states.stoppedByPerson.has('gone'), states.scopeRead.has('gone')]).toEqual([false, false, false, false, false])
    expect([states.starting.has('here'), states.sleeping.has('here'), states.failures.has('here'), states.stoppedByPerson.has('here'), states.scopeRead.has('here')]).toEqual([true, true, true, true, true])
  })
})
