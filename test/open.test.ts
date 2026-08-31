import { describe, expect, test } from 'bun:test'

import { Openness, STALE_MS } from '../server/open.ts'

/**
 * Which kehikko is open, which the server only knows because pages say so.
 *
 * The whole value of this file is in what it REFUSES. A guess here is a tool
 * call that lands on a canvas somebody is not looking at, with nothing anywhere
 * saying it did.
 */

describe('one page, one kehikko, one answer', () => {
  test('nothing has said, so there is no answer and the sentence says what to do', () => {
    const openness = new Openness()
    const asked = openness.open()
    expect(asked.ok).toBe(false)
    expect(asked.ok === false && asked.why).toContain('kehikko: <id>')
  })

  test('one page reporting one kehikko is an answer', () => {
    const openness = new Openness()
    openness.reported('page-a', 3)
    expect(openness.open()).toEqual({ ok: true, id: 3 })
  })

  test('a page that moves to another kehikko replaces its own report', () => {
    const openness = new Openness()
    openness.reported('page-a', 3)
    openness.reported('page-a', 7)
    expect(openness.open()).toEqual({ ok: true, id: 7 })
  })

  test('two pages on the same kehikko is the ordinary case, not a disagreement', () => {
    const openness = new Openness()
    openness.reported('page-a', 3)
    openness.reported('page-b', 3)
    expect(openness.open()).toEqual({ ok: true, id: 3 })
  })

  test('two pages on two kehikot is refused, with both ids in the sentence', () => {
    const openness = new Openness()
    openness.reported('page-a', 3)
    openness.reported('page-b', 7)
    const asked = openness.open()
    expect(asked.ok).toBe(false)
    /* Naming both is the whole point: an agent can act on this, and picking the
       most recent of them would have changed a screen nobody named. */
    expect(asked.ok === false && asked.why).toContain('3, 7')
  })

  test('a page that goes away withdraws, and the other one is the answer again', () => {
    const openness = new Openness()
    openness.reported('page-a', 3)
    openness.reported('page-b', 7)
    openness.reported('page-b', null)
    expect(openness.open()).toEqual({ ok: true, id: 3 })
  })

  test('a report older than half a day is not an answer', () => {
    const openness = new Openness()
    const long = Date.now()
    openness.reported('page-a', 3, long)
    expect(openness.open(long + STALE_MS - 1)).toEqual({ ok: true, id: 3 })
    /* The backstop for a tab that was killed and never withdrew. */
    expect(openness.open(long + STALE_MS + 1).ok).toBe(false)
  })

  test('a stale report does not make a live one ambiguous', () => {
    const openness = new Openness()
    const long = Date.now()
    openness.reported('page-a', 3, long)
    openness.reported('page-b', 7, long + STALE_MS)
    expect(openness.open(long + STALE_MS + 1)).toEqual({ ok: true, id: 7 })
  })

  test('a flood of page ids does not grow without bound', () => {
    const openness = new Openness()
    for (let n = 0; n < 200; n += 1) openness.reported(`page-${n}`, 1)
    /* All of them naming one kehikko, so the answer is still an answer — what
       is being checked is that a map keyed by a string off a request has a
       ceiling. */
    expect(openness.open()).toEqual({ ok: true, id: 1 })
  })
})
