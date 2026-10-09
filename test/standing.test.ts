import { describe, expect, test } from 'bun:test'

import { COVER_WORDS, Covers, isStale, registryBehind, Replacing, Runs, showing, type Said } from '../src/host/standing.ts'

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

})

describe('a page older than its server', () => {
  const build = (started: string, commit: string | null = 'abc1234') => ({ version: '1.0.0', commit, started, protocol: '0.36.0' })
  const first = build('2026-10-09T10:00:00.000Z')
  const second = build('2026-10-09T10:05:00.000Z')

  test('the same process is not stale, and neither is a side that did not say', () => {
    expect(isStale(first, first)).toBe(false)
    expect(isStale(first, { ...first })).toBe(false)
    /* A module from before build identities, on either side: never a false "stale". */
    expect(isStale(null, second)).toBe(false)
    expect(isStale(undefined, second)).toBe(false)
    expect(isStale(first, null)).toBe(false)
    expect(isStale(undefined, undefined)).toBe(false)
  })

  test('a later server process is, whether or not its code changed', () => {
    expect(isStale(first, second)).toBe(true)
    expect(isStale(first, build('2026-10-09T10:05:00.000Z', 'def5678'))).toBe(true)
  })

  test('a page AHEAD of what the registry last read is not stale: the registry is behind', () => {
    expect(isStale(second, first)).toBe(false)
    expect(registryBehind(second, first)).toBe(true)
    expect(registryBehind(first, second)).toBe(false)
    expect(registryBehind(first, first)).toBe(false)
    expect(registryBehind(null, first)).toBe(false)
  })

  test('a stale page is covered as restarting, and one that is not is the page', () => {
    const told = { condition: 'ready' as const, line: 'x' }
    expect(showing(told, { condition: 'ready', line: null, stale: true })).toEqual({ kind: 'cover', state: 'restarting' })
    expect(showing(told, { condition: 'ready', line: null, stale: false })).toEqual({ kind: 'page' })
    expect(showing(told, { condition: 'ready', line: null })).toEqual({ kind: 'page' })
  })

  test('it is replaced once per server process', () => {
    const replacing = new Replacing()
    expect(replacing.stale('a', first, second)).toBe(true)
    expect(replacing.take('a', first, second)).toBe(true)
    /* Until the new document answers, it is still the old page: covered, not replaced again. */
    expect(replacing.stale('a', first, second)).toBe(true)
    expect(replacing.take('a', first, second)).toBe(false)
    /* The new document, from the new server. */
    expect(replacing.stale('a', second, second)).toBe(false)
    expect(replacing.take('a', second, second)).toBe(false)
    /* And the server restarts again. */
    const third = build('2026-10-09T10:09:00.000Z')
    expect(replacing.take('a', second, third)).toBe(true)
  })

  test('a new document that is STILL another process is shown, not covered for good', () => {
    const replacing = new Replacing()
    const third = build('2026-10-09T10:09:00.000Z')
    expect(replacing.take('a', first, third)).toBe(true)
    /* The replacement announces a build that is not the server's either. */
    expect(replacing.stale('a', second, third)).toBe(false)
    expect(replacing.take('a', second, third)).toBe(false)
  })

  test('a module that states no build is never replaced', () => {
    const replacing = new Replacing()
    expect(replacing.take('a', null, second)).toBe(false)
    expect(replacing.take('a', first, undefined)).toBe(false)
    expect(replacing.stale('a', undefined, undefined)).toBe(false)
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

describe('a restart that was over before anything said the module was down', () => {
  const ready = (id: string, run?: number) => ({ id, condition: 'ready' as const, run })

  test('a module ready on a new process of the host’s gets a new document', () => {
    const runs = new Runs()
    expect(runs.seen([ready('a', 100), ready('b', 100)])).toEqual([])
    expect(runs.seen([ready('a', 200), ready('b', 100)])).toEqual(['a'])
    expect(runs.seen([ready('a', 200), ready('b', 100)])).toEqual([])
  })

  test('one the host inherited and then restarted does too', () => {
    const runs = new Runs()
    runs.seen([ready('a')])
    expect(runs.seen([ready('a', 300)])).toEqual(['a'])
  })

  test('not while the host still has it in hand: the new document waits for a server that answers', () => {
    const runs = new Runs()
    runs.seen([ready('a', 100)])
    expect(runs.seen([{ ...ready('a', 200), lifecycle: 'updating' }])).toEqual([])
    expect(runs.seen([{ id: 'a', condition: 'silent', run: 200 }])).toEqual([])
    expect(runs.seen([ready('a', 200)])).toEqual(['a'])
  })

  test('not on first sight, and not when the HOST restarted and holds nothing: that would reload every page', () => {
    const runs = new Runs()
    expect(runs.seen([ready('a', 100)])).toEqual([])
    expect(runs.seen([ready('a')])).toEqual([])
    /* A stop the host was refused starts nothing, so nothing is reloaded — a kept terminal keeps its page. */
    expect(runs.seen([ready('a')])).toEqual([])
  })
})
