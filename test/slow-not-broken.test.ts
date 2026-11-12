import { describe, expect, test } from 'bun:test'

import { Conversation, QUIET_FOR_MS, quietForLine, type ConversationWatcher } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { frameOriginFor } from '@/host/moduleAddress.ts'
import { EXIT_BACKOFF_MS, EXIT_RESTARTS_MAX, EXIT_RESTARTS_WINDOW_MS, ExitRestarts, toStart, type Standing } from '../server/lifecycle.ts'
import { filesFetched, movedFrom, pageMovedLine, whyQuiet } from '../server/quiet.ts'
import { sweepAfter } from '../server/sweepAfter.ts'

/**
 * "Whenever I restart the app, different modules complain", and "when I reload or restart the
 * modules, they still fail to load". Measured on a scratch host in WebKit with the person's own
 * module copies: the pages greet in tens of milliseconds; what failed was the host.
 *
 *  1. After a restart the page was handed a reading taken before the module answered, and held
 *     "Starting…" for half a minute over a module that was up (`sweepAfter.ts`).
 *  2. A frame left holding the page of a process that had since moved to another port was checked
 *     at the NEW port, found in order, and the module was blamed for "choosing not to answer".
 *  3. A page that was only slow was complained about at four seconds.
 *  4. A process that kept ending was started again at once, forever.
 */

const ID = 'kehikot.example'
const PORT = 4170
const STABLE = frameOriginFor(ID, PORT)!
const NOW = 'http://127.0.0.1:49836/app'
const BEFORE = 'http://127.0.0.1:49315/app?theme=dark'
const context = toWireContext({ epic: null, project: null }, 'dark')

describe('the quiet check does not blame a module across a restart', () => {
  test('a frame holding a page from another port than the module answers at has moved', () => {
    expect(movedFrom(NOW, BEFORE, STABLE)).toBe('http://127.0.0.1:49315')
    expect(movedFrom(NOW, BEFORE, null)).toBe('http://127.0.0.1:49315')
  })

  test('the module’s own address, its stable address, and a pinned version’s are current', () => {
    expect(movedFrom(NOW, `${NOW}?theme=dark`, STABLE)).toBeNull()
    expect(movedFrom(NOW, `${STABLE}/app`, STABLE)).toBeNull()
    expect(movedFrom(NOW, `http://v-2-0-0.example.kehikot.localhost:${PORT}/app`, STABLE)).toBeNull()
    expect(movedFrom(NOW, 'http://127.0.0.1:50000/app', STABLE, ['http://127.0.0.1:50000'])).toBeNull()
    /* Nothing said, or nothing readable: nothing to compare. */
    expect(movedFrom(NOW, null, STABLE)).toBeNull()
    expect(movedFrom(NOW, 'not a url', STABLE)).toBeNull()
  })

  test('the sentence says it was started again, names both addresses, and blames nothing', () => {
    const line = pageMovedLine('Example', 'http://127.0.0.1:49315', NOW)
    expect(line).toContain('started again')
    expect(line).toContain('http://127.0.0.1:49315')
    expect(line).toContain('http://127.0.0.1:49836')
    expect(line).not.toContain('choosing not to answer')
    expect(line).not.toContain('fault')
  })
})

describe('how many files were fetched, said as a sentence says it', () => {
  test('one file was, two files were', () => {
    expect(filesFetched(1)).toBe('1 file was fetched')
    expect(filesFetched(2)).toBe('2 files were fetched')
    expect(filesFetched(0)).toBe('0 files were fetched')
  })

  test('the sentence for a page that loads everything uses it, and blames no one', async () => {
    const entry = 'http://127.0.0.1:7920/app'
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === entry) return new Response('<script type="module" src="./assets/index.js"></script>', { headers: { 'content-type': 'text/html' } })
      return new Response('export {}', { headers: { 'content-type': 'text/javascript' } })
    }) as unknown as typeof fetch
    const said = await whyQuiet('Example', entry, fetcher)
    expect(said.kind).toBe('module')
    expect(said.line).toContain('1 file was fetched')
    expect(said.line).not.toContain('were fetched, following')
    expect(said.line).not.toContain('choosing not to answer')
  })
})

/** A conversation over a frame that answers only when told to. */
function aFrame(options: { behind?: boolean; quietForMs?: number } = {}) {
  const said: string[] = []
  const counts = { retries: 0, behind: 0, asked: 0 }
  const watcher: ConversationWatcher = {
    ready: () => {},
    silent: (line) => said.push(line),
    fault: () => {},
    height: () => {},
    filters: () => {},
    clearable: () => {},
    refreshable: () => {},
    header: () => {},
    retry: () => {
      counts.retries++
    },
    ...(options.behind === false
      ? {}
      : {
          behind: () => {
            counts.behind++
          },
        }),
  }
  const contentWindow = { postMessage() {} } as unknown as Window
  const conversation = new Conversation({ contentWindow }, ID, null, async () => ({ ok: true, data: null }), watcher, {
    name: 'Example',
    readyTimeoutMs: 20,
    quietForMs: options.quietForMs ?? 200,
    entry: BEFORE,
  })
  /** The page answers the next greeting. */
  const answer = () => conversation.receive({ source: contentWindow, origin: 'null', data: { type: 'kehikot.ready', id: ID, protocol: 2 } })
  return { conversation, said, counts, answer }
}

/** The host's server, as `/host/quiet` answers, for the frames below. */
function serving(answer: (url: string) => { kind: string; line: string } | null, asked: { n: number }) {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.n++
    const said = answer(String(input))
    return said ? new Response(JSON.stringify({ ok: true, ...said })) : new Response('no', { status: 500 })
  }) as unknown as typeof fetch
  return () => (globalThis.fetch = real)
}

describe('a page that is only slow is not complained about', () => {
  test('quiet with everything loading: one reload, then nothing said until QUIET_FOR_MS', async () => {
    const asked = { n: 0 }
    const restore = serving(() => ({ kind: 'module', line: 'Example serves its page and the page has not answered.' }), asked)
    const at = aFrame()
    try {
      at.conversation.greet(context)
      await Bun.sleep(60)
      /* The one reload, for a page loaded before its module listened. */
      expect(at.counts.retries).toBe(1)
      at.conversation.greet(context)
      await Bun.sleep(80)
      expect(at.said).toEqual([])
      await Bun.sleep(200)
      /* Past the last resort: said, as what it is, and never a restart. */
      expect(at.said).toHaveLength(1)
      expect(at.said[0]).toContain('has said nothing for')
      expect(at.said[0]).toContain('Reload the page')
    } finally {
      restore()
      at.conversation.close()
    }
  })

  test('a slow page that answers inside the last resort is never said to be quiet', async () => {
    const asked = { n: 0 }
    const restore = serving(() => ({ kind: 'module', line: 'quiet' }), asked)
    const at = aFrame()
    try {
      at.conversation.greet(context)
      await Bun.sleep(60)
      at.conversation.greet(context)
      await Bun.sleep(100)
      at.answer()
      await Bun.sleep(250)
      expect(at.said).toEqual([])
    } finally {
      restore()
      at.conversation.close()
    }
  })

  test('the last resort is a minute, and its sentence names no fault in the module', () => {
    expect(QUIET_FOR_MS).toBe(60_000)
    const line = quietForLine('Example', QUIET_FOR_MS)
    expect(line).toContain('60 seconds')
    expect(line).not.toContain('choosing')
  })

  test('a page from before a restart reads the modules again, says nothing and reloads nothing', async () => {
    const asked = { n: 0 }
    const restore = serving(() => ({ kind: 'moved', line: 'Example was started again since this container loaded its page.' }), asked)
    const at = aFrame()
    try {
      at.conversation.greet(context)
      await Bun.sleep(60)
      expect(at.counts.behind).toBe(1)
      expect(at.counts.retries).toBe(0)
      expect(at.said).toEqual([])
    } finally {
      restore()
      at.conversation.close()
    }
  })

  test('without a way to read again, the moved sentence is said instead of a blame', async () => {
    const asked = { n: 0 }
    const restore = serving(() => ({ kind: 'moved', line: 'Example was started again since this container loaded its page.' }), asked)
    const at = aFrame({ behind: false })
    try {
      at.conversation.greet(context)
      await Bun.sleep(60)
      expect(at.said).toEqual(['Example was started again since this container loaded its page.'])
    } finally {
      restore()
      at.conversation.close()
    }
  })
})

describe('a cold start of fifteen modules, some slow to greet, is quiet', () => {
  test('no container says anything, and nothing is restarted', async () => {
    const asked = { n: 0 }
    const restore = serving(() => ({ kind: 'module', line: 'quiet' }), asked)
    /* Greeting delays in the shape a busy machine gives them: most at once, a few seconds for
       some, one heavy page well past the old four-second verdict. Scaled down 1:40. */
    const delays = [5, 5, 10, 10, 15, 20, 25, 30, 40, 60, 80, 100, 120, 150, 180]
    const frames = delays.map(() => aFrame({ quietForMs: 1500 }))
    try {
      for (const [i, frame] of frames.entries()) {
        frame.conversation.greet(context)
        setTimeout(() => frame.answer(), delays[i]!)
      }
      /* The one reload a slow page may get re-greets it; it answers in its own time again. */
      await Bun.sleep(400)
      for (const [i, frame] of frames.entries()) {
        if (frame.counts.retries > 0) {
          frame.conversation.greet(context)
          setTimeout(() => frame.answer(), delays[i]!)
        }
      }
      await Bun.sleep(1700)
      expect(frames.flatMap((frame) => frame.said)).toEqual([])
    } finally {
      restore()
      for (const frame of frames) frame.conversation.close()
    }

    /* And the process side: fifteen modules the host started, all running, none answering its
       page yet — the host starts none of them again. It only ever starts what nothing answers for. */
    const standings: Standing[] = delays.map((_, i) => ({
      id: `kehikot.m${i}`,
      needed: true,
      answering: true,
      startable: true,
      ours: true,
      keep: false,
      idleSince: 0,
      starting: i % 2 === 0,
    }))
    expect(toStart(standings)).toEqual([])
    /* Even while their manifests are slow to come back: a process the host holds is never doubled. */
    expect(toStart(standings.map((one) => ({ ...one, answering: false })))).toEqual([])
  })
})

describe('a reading taken after the module answered, not before', () => {
  test('a sweep out that began before the answer is waited for, and a new one read', async () => {
    let out: { running: Promise<string>; since: number } | null = null
    let finish: (value: string) => void = () => {}
    out = { running: new Promise<string>((done) => (finish = done)), since: 100 }
    let started = 0
    const reading = sweepAfter(() => out, 200, async () => {
      started++
      return 'after'
    })
    finish('before')
    out = null
    expect(await reading).toBe('after')
    expect(started).toBe(1)
  })

  test('a sweep out that began after the answer is shared', async () => {
    const out = { running: Promise.resolve('shared'), since: 300 }
    let started = 0
    expect(
      await sweepAfter(() => out, 200, async () => {
        started++
        return 'new'
      }),
    ).toBe('shared')
    expect(started).toBe(0)
  })
})

describe('a process that keeps ending is not started forever', () => {
  test('each start after an end waits longer, and after the cap it is not started again', () => {
    let now = 0
    const ends = new ExitRestarts(() => now)
    const waits: (number | null)[] = []
    for (let i = 0; i <= EXIT_RESTARTS_MAX; i++) {
      waits.push(ends.ended(ID).wait)
      now += 1000
    }
    expect(waits).toEqual([...EXIT_BACKOFF_MS.slice(0, EXIT_RESTARTS_MAX), null])
  })

  test('ends outside the window are forgotten, and a press starts the count again', () => {
    let now = 0
    const ends = new ExitRestarts(() => now)
    for (let i = 0; i < EXIT_RESTARTS_MAX; i++) ends.ended(ID)
    now += EXIT_RESTARTS_WINDOW_MS
    expect(ends.ended(ID)).toEqual({ wait: 0, times: 1 })
    for (let i = 0; i < EXIT_RESTARTS_MAX; i++) ends.ended(ID)
    ends.forget(ID)
    expect(ends.ended(ID).wait).toBe(0)
  })
})
