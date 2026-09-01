import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

/**
 * The page's end of the wake stream: what it does with each shape that arrives.
 *
 * ## Why this is worth a test at all, when there is no DOM here
 *
 * Because the fault this half was written for is invisible to everything else
 * in this suite, and because a completely dead page once shipped under six
 * hundred green tests — nothing in `test/` renders the app, so nothing in
 * `test/` can catch a page that has stopped working.
 *
 * This does not render anything either. It stubs the two globals
 * `watchCanvases` touches and drives the message handler by hand, which is
 * enough to say the thing worth saying: that a `registry` message reaches the
 * sweep, that a `kehikko` message does not reach it by accident, and that a
 * message this page does not understand reaches neither. Everything above the
 * callbacks — the effect in `App.tsx`, the container, the light — is still
 * unverified by anything but `dev/watch.probe.ts` and a person looking.
 */

/** The `EventSource` the page opens, kept so a test can post into it. */
class FakeSource {
  static last: FakeSource | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeSource.last = this
  }

  close(): void {
    this.closed = true
  }

  send(data: string): void {
    this.onmessage?.({ data })
  }
}

const had = {
  window: (globalThis as { window?: unknown }).window,
  source: (globalThis as { EventSource?: unknown }).EventSource,
}

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = { location: { origin: 'http://127.0.0.1:4181' } }
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeSource
})

afterAll(() => {
  ;(globalThis as { window?: unknown }).window = had.window
  ;(globalThis as { EventSource?: unknown }).EventSource = had.source
})

const { watchCanvases } = await import('../src/host/canvases.ts')

const listening = () => {
  const woke: number[] = []
  let looked = 0
  const stop = watchCanvases(7, (id) => woke.push(id), () => (looked += 1))
  const source = FakeSource.last
  if (!source) throw new Error('no stream was opened')
  return { woke, source, stop, looks: () => looked }
}

describe('what the page does with each kind of news', () => {
  test('a kehikko is re-read, and the sweep is not run', () => {
    const one = listening()
    one.source.send(JSON.stringify({ kehikko: 7 }))
    expect(one.woke).toEqual([7])
    /* The two are separate on purpose. Re-reading the kehikot is cheap and
       local; a sweep is a request to every registered program, and a page that
       swept on every arrangement an agent changed would be paying that price
       for news that says nothing about what is running. */
    expect(one.looks()).toBe(0)
    one.stop()
  })

  test('a changed registry runs the sweep, and re-reads no kehikko', () => {
    const one = listening()
    one.source.send(JSON.stringify({ registry: true }))
    expect(one.looks()).toBe(1)
    expect(one.woke).toEqual([])
    one.stop()
  })

  test('the stream carries what this page has open, so a reconnect re-asserts it', () => {
    const one = listening()
    expect(one.source.url).toContain('kehikko=7')
    expect(one.source.url).toContain('page=')
    one.stop()
    expect(one.source.closed).toBe(true)
  })

  test('news this page does not understand does nothing', () => {
    /* Both directions of "does nothing": no callback, and no throw. This end
       has to survive a server newer than itself, because a module left running
       across an upgrade and a bundle cached in a tab are both ordinary here. */
    const one = listening()
    one.source.send('not json at all')
    one.source.send(JSON.stringify({ registry: 'yes' }))
    one.source.send(JSON.stringify({ kehikko: 'seven' }))
    one.source.send(JSON.stringify({ somethingElse: true }))
    expect(one.looks()).toBe(0)
    expect(one.woke).toEqual([])
    one.stop()
  })

  test('a caller that wants only kehikot may pass no sweep, and nothing breaks', () => {
    /* The argument is optional, and a `registry` arriving at a listener that
       did not ask for it must not be a thrown error inside an event handler. */
    const woke: number[] = []
    const stop = watchCanvases(7, (id) => woke.push(id))
    const source = FakeSource.last
    source?.send(JSON.stringify({ registry: true }))
    source?.send(JSON.stringify({ kehikko: 7 }))
    expect(woke).toEqual([7])
    stop()
  })
})
