import { describe, expect, test } from 'bun:test'

import { COVER_WORDS, Covers, isStale, showing, type Said } from '../src/host/standing.ts'

/**
 * What a container shows — the page, the cover, or a notice — and when the
 * cover is armed. One decision for the container body and the frames layer.
 */

const said = (over: Partial<Said> = {}): Said => ({ condition: 'ready', line: 'the server’s line', ...over })
const ready = { condition: 'ready', line: null } as const

describe('what a container shows', () => {
  test('the page only when the server says ready AND the page has answered', () => {
    expect(showing(said(), ready)).toEqual({ kind: 'page' })
  })

  test('a framed page that has not answered yet is covered as loading — first load or any later one', () => {
    expect(showing(said(), undefined)).toEqual({ kind: 'cover', state: 'loading' })
  })

  test('everything the host is doing that ends on its own is the same cover, saying which', () => {
    for (const lifecycle of ['starting', 'installing', 'updating', 'restarting'] as const) {
      expect(showing(said({ condition: 'silent', lifecycle }), undefined)).toEqual({ kind: 'cover', state: lifecycle })
    }
  })

  test('an update or restart in hand covers a page that is still answering: it is about to be replaced', () => {
    expect(showing(said({ condition: 'ready', lifecycle: 'updating' }), ready)).toEqual({ kind: 'cover', state: 'updating' })
    expect(showing(said({ condition: 'ready', lifecycle: 'restarting' }), ready)).toEqual({ kind: 'cover', state: 'restarting' })
  })

  test('a module nothing serves is never shown as its page, whatever a conversation last heard', () => {
    /* The container that stayed green over a dead page. */
    expect(showing(said({ condition: 'silent', line: 'not running' }), ready)).toEqual({
      kind: 'notice',
      condition: 'silent',
      asleep: false,
      line: 'not running',
    })
    expect(showing(said({ condition: 'incompatible', line: 'speaks 3' }), ready).kind).toBe('notice')
  })

  test('asleep is a notice, not a cover: nothing is on its way', () => {
    expect(showing(said({ condition: 'silent', lifecycle: 'asleep', line: 'asleep' }), undefined)).toMatchObject({
      kind: 'notice',
      asleep: true,
    })
  })

  test('a page that was greeted and did not answer is a notice in the conversation’s words, or the server’s', () => {
    expect(showing(said(), { condition: 'silent', line: 'did not answer' })).toEqual({
      kind: 'notice',
      condition: 'silent',
      asleep: false,
      line: 'did not answer',
    })
    expect(showing(said(), { condition: 'silent', line: null })).toMatchObject({ line: 'the server’s line' })
  })

  test('"not running" is not believed until the server was asked knowing what this page has open', () => {
    const silent = said({ condition: 'silent', line: 'not running' })
    expect(showing(silent, undefined, false)).toEqual({ kind: 'cover', state: 'loading' })
    expect(showing(silent, undefined, true).kind).toBe('notice')
    /* Asleep too: opening the kehikko is what wakes it. Incompatible is a fact about the program, said at once. */
    expect(showing(said({ condition: 'silent', lifecycle: 'asleep' }), undefined, false).kind).toBe('cover')
    expect(showing(said({ condition: 'incompatible' }), undefined, false).kind).toBe('notice')
  })

  test('every state has its own plain sentence', () => {
    expect(COVER_WORDS).toEqual({
      starting: 'Starting…',
      installing: 'Installing what it needs — the first time takes a minute',
      updating: 'Updating — restarting on the new code…',
      restarting: 'Restarting…',
      loading: 'Loading…',
    })
    expect(new Set(Object.values(COVER_WORDS)).size).toBe(5)
  })

  test('nothing can say a page is stale yet', () => {
    expect(isStale({ id: 'a', version: '1.0.0' })).toBe(false)
  })
})

describe('arming the cover', () => {
  /** A clock the test turns by hand. */
  function clock() {
    let next = 1
    const timers = new Map<number, () => void>()
    return {
      after: (_ms: number, run: () => void) => {
        timers.set(next, run)
        return next++
      },
      cancel: (timer: unknown) => void timers.delete(timer as number),
      elapse: () => {
        for (const [id, run] of [...timers]) {
          timers.delete(id)
          run()
        }
      },
      pending: () => timers.size,
    }
  }
  const covers = () => {
    const time = clock()
    const dropped: string[] = []
    return { time, dropped, covers: new Covers((id) => dropped.push(id), 250, time.after, time.cancel) }
  }

  test('a document mounted from nothing is covered at once — the first load, and every time a module comes back', () => {
    const { covers: c, dropped } = covers()
    c.mounted('a')
    expect(dropped).toEqual(['a'])
    c.mounted('a')
    expect(dropped).toEqual(['a', 'a'])
  })

  test('a frame that goes away takes what its page had said with it, so coming back is never drawn as the old page', () => {
    const { covers: c, dropped } = covers()
    c.answered('a')
    c.unmounted('a')
    expect(dropped).toEqual(['a'])
  })

  test('a reload that answers within the grace shows no cover at all', () => {
    const { covers: c, dropped, time } = covers()
    c.loaded('a')
    expect(dropped).toEqual([])
    c.answered('a')
    time.elapse()
    expect(dropped).toEqual([])
    expect(time.pending()).toBe(0)
  })

  test('a reload that has not answered when the grace ends is covered, and every later reload arms again', () => {
    const { covers: c, dropped, time } = covers()
    c.loaded('a')
    time.elapse()
    expect(dropped).toEqual(['a'])
    c.answered('a')
    c.loaded('a')
    time.elapse()
    expect(dropped).toEqual(['a', 'a'])
  })

  test('two loads in a row are one pending cover, and a frame that goes away owes nothing', () => {
    const { covers: c, dropped, time } = covers()
    c.loaded('a')
    c.loaded('a')
    expect(time.pending()).toBe(1)
    c.unmounted('a')
    expect(dropped).toEqual(['a'])
    time.elapse()
    expect(dropped).toEqual(['a'])
  })

  test('one module answering does not let go of another’s cover', () => {
    const { covers: c, dropped, time } = covers()
    c.loaded('a')
    c.loaded('b')
    c.answered('a')
    time.elapse()
    expect(dropped).toEqual(['b'])
  })
})
