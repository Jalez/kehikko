import { describe, expect, test } from 'bun:test'

import { nextConnection, Openness, STALE_MS } from '../server/open.ts'

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
  /*
   * The page reopens its stream whenever the open kehikko changes, so for a
   * moment two connections exist for one page. The old one's cancel arrives
   * after the new one's start, and it used to delete the LIVE stream's report
   * -- after which the server believed nobody had anything open and the
   * lifecycle policy stopped every module on the canvas somebody was watching.
   */
  test('a replaced stream closing does not withdraw the live one', () => {
    const openness = new Openness()
    const first = nextConnection()
    const second = nextConnection()

    openness.streamed(first, 'page-a', 1)
    openness.streamed(second, 'page-a', 1)
    openness.closed(first)

    expect(openness.open()).toEqual({ ok: true, id: 1 })
    expect(openness.every()).toEqual([1])
  })

  test('the last stream closing does withdraw', () => {
    const openness = new Openness()
    const only = nextConnection()
    openness.streamed(only, 'page-a', 1)
    openness.closed(only)
    expect(openness.open().ok).toBe(false)
  })

  /*
   * The one that made modules sleep while somebody watched them.
   *
   * macOS fires `pagehide` when a full-screen app occludes the window, so the
   * page withdrew its word for a screen that was still there. The stream was
   * still open the whole time and is what keeps the answer true.
   */
  test('a stream still open outlives the page saying it went away', () => {
    const openness = new Openness()
    const live = nextConnection()
    openness.streamed(live, 'page-a', 1)
    openness.reported('page-a', 1)

    openness.reported('page-a', null)

    expect(openness.open()).toEqual({ ok: true, id: 1 })
  })

  /* And when the screen really is gone, both ends agree and nothing is left. */
  test('a page that leaves for real stops answering', () => {
    const openness = new Openness()
    const live = nextConnection()
    openness.streamed(live, 'page-a', 1)
    openness.reported('page-a', 1)

    openness.reported('page-a', null)
    openness.closed(live)

    expect(openness.open().ok).toBe(false)
    expect(openness.every()).toEqual([])
  })

  /*
   * Mid-switch a page holds a post for the kehikko it moved to and a stream for
   * the one it moved from. That is one screen, not two, and must not read as an
   * ambiguity -- an agent would be refused an answer that plainly exists.
   */
  test('a page mid-switch counts once, as its newest claim', () => {
    const openness = new Openness()
    const old = nextConnection()
    const at = Date.now()

    openness.streamed(old, 'page-a', 1, at)
    openness.reported('page-a', 2, at + 10)

    expect(openness.every(at + 20)).toEqual([2])
    expect(openness.open(at + 20)).toEqual({ ok: true, id: 2 })
  })

  /* Two screens really are two, whichever way each of them said so. */
  test('two pages on two kehikot are still an ambiguity', () => {
    const openness = new Openness()
    openness.streamed(nextConnection(), 'page-a', 1)
    openness.reported('page-b', 7)
    expect(openness.every()).toEqual([1, 7])
    expect(openness.open().ok).toBe(false)
  })

  test('streams do not grow without bound either', () => {
    const openness = new Openness()
    for (let n = 0; n < 200; n += 1) openness.streamed(nextConnection(), `page-${n}`, 1)
    expect(openness.open()).toEqual({ ok: true, id: 1 })
  })
})
