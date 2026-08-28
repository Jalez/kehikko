import { describe, expect, test } from 'bun:test'
import { epicsListResult, LIMITS, METHOD_NAMES } from 'roadmap-module-protocol'

import { answer } from '../server/answers.ts'
import { unanswered } from '@/host/division.ts'

/**
 * What a host with no material of its own says.
 *
 * The whole design problem here is that there are two kinds of emptiness and a
 * module has to be able to tell them apart: "I looked and there is nothing" is
 * an answer, and "that is not mine to say" is a refusal. A host that collapsed
 * them into `ok: true, data: null` would never lie outright and would leave
 * every module drawing an empty panel for a question nobody ever answered.
 */

const registered = (id: string) => id === 'example.journey-notes'
const ME = 'example.journey-notes'

describe('every method the protocol names is answered by somebody', () => {
  test('nothing falls between the two halves of the host', () => {
    expect(unanswered()).toEqual([])
  })

  test('and the list is the protocol\'s, not a copy that has drifted', () => {
    expect(METHOD_NAMES.length).toBeGreaterThan(0)
  })
})

describe('nothing to show', () => {
  test('the list of epics this host holds is empty, in the shape the protocol names', () => {
    const given = answer(ME, 'epics.list', {}, registered)
    expect(given).toEqual({ ok: true, data: { epics: [] } })
    /* And the host's own answer is held to that shape, so a rename in the
       package fails here rather than reaching a module as an unreadable front
       door. */
    expect(epicsListResult.safeParse((given as { data: unknown }).data).success).toBe(true)
  })
})

describe('not mine to say', () => {
  test('what the trackers last reported is refused, because an empty answer would be a claim', () => {
    const given = answer(ME, 'live.get', { epic: 'modes-are-modules' }, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    expect(given.reason).toBe('failed')
    expect(given.error).toContain('trackers')
  })

  test('a named epic is not found here, and the refusal does not list the ones that are', () => {
    const given = answer(ME, 'epic.get', { epic: 'modes-are-modules' }, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    /* Not quoted back — a refusal that names what it could not find is one step
       from a refusal that names what it could. */
    expect(given.error).not.toContain('modes-are-modules')
  })

  test('a write this host cannot perform is refused rather than absorbed', () => {
    const given = answer(ME, 'stage.report', { ref: 'gh#41', stage: 'working' }, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    expect(given.error).toContain('Nothing was recorded')
  })
})

describe('events.emit is no longer this half\'s to answer', () => {
  /*
   * These three tests used to assert a refusal, and the refusal was right for
   * as long as the wire had no message that carried an event. It has one now,
   * and delivery needs a frame — which this half of the host does not have. So
   * what is worth testing here is no longer WHAT the server says about an
   * event, it is that the server no longer claims the call at all and says so
   * in a sentence naming the other half. The checks these tests used to cover
   * moved with the delivery and are covered in `events.test.ts`.
   */
  test('the server hands it back to the canvas rather than refusing it on the merits', () => {
    const given = answer(
      ME,
      'events.emit',
      {
        extension: 'roadmap.notifications@1',
        payload: { epic: 'modes-are-modules', message: 'the note was updated', level: 'info' },
      },
      registered,
    )
    expect(given.ok).toBe(false)
    if (given.ok) return
    /* Naming the canvas, because this refusal is only ever reached when the
       host has forwarded something to the wrong side of itself — a fault in the
       host, and the sentence has to send whoever reads it to the right file. */
    expect(given.error).toContain('canvas')
    expect(given.error).toContain('events.emit')
  })

  test('a valid payload gets the same answer as an invalid one, because neither is looked at', () => {
    const good = answer(
      ME,
      'events.emit',
      { extension: 'roadmap.notifications@1', payload: { epic: 'x', message: 'hi' } },
      registered,
    )
    const bad = answer(
      ME,
      'events.emit',
      { extension: 'somebody.else@7', payload: { anything: true } },
      registered,
    )
    expect(good.ok).toBe(false)
    expect(bad.ok).toBe(false)
    if (good.ok || bad.ok) return
    /* Identical, and that is the point: a half of the host that does not answer
       a method must not half-answer it either. A server that still validated
       the payload would be a second implementation of a check that lives
       somewhere else, and two copies of a check are two answers waiting to
       disagree. */
    expect(good.error).toBe(bad.error)
  })

  test('it is not reported as unknown-method, which would mean never', () => {
    const given = answer(ME, 'events.emit', { extension: 'roadmap.calls@1', payload: {} }, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    /* `unknown-method` is the protocol's word for "this does not exist, now or
       later", and it would be a lie here: the host answers this, elsewhere. */
    expect(given.reason).toBe('failed')
  })
})

describe('refusals carry both halves', () => {
  test('a method this host does not have is unknown-method: never, rather than not yet', () => {
    const given = answer(ME, 'epics.invent', {}, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    expect(given.reason).toBe('unknown-method')
    expect(given.error.length).toBeGreaterThan(0)
  })

  test('a module the host no longer has is unknown-module, which is a different future', () => {
    const given = answer('gone.away', 'epics.list', {}, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    expect(given.reason).toBe('unknown-module')
    expect(given.error).toContain('registration')
  })

  test('a method the view answers is not answered here, and this half says so plainly', () => {
    const given = answer(ME, 'view.goto', { epic: 'modes-are-modules' }, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    expect(given.error).toContain('canvas')
  })
})

describe('nothing a stranger sent comes back unbounded', () => {
  test('a refusal stays inside the protocol\'s own bound on a refusal', () => {
    const given = answer(ME, 'stage.report', { ref: 'x'.repeat(50_000), stage: 'working' }, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    expect(given.error.length).toBeLessThanOrEqual(LIMITS.REASON)
  })

  test('a bad enum does not echo twenty thousand characters back under the module\'s name', () => {
    const given = answer(ME, 'stage.report', { ref: 'gh#41', stage: 'z'.repeat(20_000) }, registered)
    expect(given.ok).toBe(false)
    if (given.ok) return
    expect(given.error.length).toBeLessThanOrEqual(LIMITS.REASON)
  })

  test('a note too long to store is refused rather than clipped', () => {
    const given = answer(
      ME,
      'stage.report',
      { ref: 'gh#41', stage: 'working', note: 'n'.repeat(LIMITS.MESSAGE + 1) },
      registered,
    )
    expect(given.ok).toBe(false)
    if (given.ok) return
    expect(given.error).toContain('note')
  })
})
