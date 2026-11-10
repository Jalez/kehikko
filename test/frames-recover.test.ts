import { describe, expect, test } from 'bun:test'
import { START_HEADER, WELL_KNOWN } from 'kehikot-module-protocol'

import { Conversation, type ConversationWatcher } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { frameOriginFor, routeOf } from '@/host/moduleAddress.ts'
import { RELOAD_CALM_MS, Runs } from '@/host/standing.ts'
import { ModuleProxy } from '../server/moduleProxy.ts'
import { framedFetch, quietEntry, whyQuiet } from '../server/quiet.ts'
import { InFlight, joinsStart } from '../server/startOnce.ts'

/**
 * After an app restart, containers stayed silent until Start was pressed, and
 * the silent sentence blamed the module. Three host faults, one file:
 *
 *  1. the quiet check asked the module's own port, while the frame was given
 *     its stable address through the host's proxy, so a proxy refusal was never
 *     reported;
 *  2. a frame loaded before its module listened was never loaded again;
 *  3. a module could be started several times within seconds.
 */

const ID = 'kehikot.example'
const PORT = 4170
const OWN = 'http://127.0.0.1:7920'
const OWN_ENTRY = `${OWN}/app`
const STABLE = frameOriginFor(ID, PORT)!
const TOKEN_A = 'a'.repeat(32)
const TOKEN_B = 'b'.repeat(32)

/** A frame route only, as the server asks for one. */
const frameRoute = (host: string, path: string) => {
  const route = routeOf(host, path)
  return route?.kind === 'frame' ? route : null
}

/** The host's proxy over a module that `moduleFetch` answers for, and the fetch `/host/quiet` gives `whyQuiet`. */
function proxied(moduleFetch: typeof fetch, token: string | null = TOKEN_A) {
  const proxy = new ModuleProxy({ port: PORT, target: () => ({ origin: OWN, token }), fetch: moduleFetch })
  const plain = (async (input: string | URL | Request) => {
    throw new Error(`asked outside the proxy: ${String(input)}`)
  }) as unknown as typeof fetch
  return framedFetch(frameRoute, (request, route) => proxy.answer(request, route), plain)
}

describe('the quiet check asks the address the frame was given', () => {
  test('the stable address when the page says it was framed there; the path is always the module’s own', () => {
    expect(quietEntry(OWN_ENTRY, `${STABLE}/elsewhere?x=1`, STABLE)).toBe(`${STABLE}/app`)
  })

  test('anything else the page says is held to the module’s own entry', () => {
    expect(quietEntry(OWN_ENTRY, 'http://evil.example/app', STABLE)).toBe(OWN_ENTRY)
    expect(quietEntry(OWN_ENTRY, 'not a url', STABLE)).toBe(OWN_ENTRY)
    expect(quietEntry(OWN_ENTRY, null, STABLE)).toBe(OWN_ENTRY)
    /* The addresses off: never the stable one. */
    expect(quietEntry(OWN_ENTRY, `${STABLE}/app`, null)).toBe(OWN_ENTRY)
  })

  test('a proxy 503 — nothing answers where the module is registered — is said, with the address checked', async () => {
    const nothing = (async () => {
      throw new TypeError('Unable to connect')
    }) as unknown as typeof fetch
    const entry = quietEntry(OWN_ENTRY, `${STABLE}/app`, STABLE)
    const said = await whyQuiet('Example', entry, proxied(nothing))
    expect(said.kind).toBe('refused')
    expect(said.line).toContain(`${STABLE}/app`)
    expect(said.line).toContain('503')
    expect(said.line).toContain(`not running: nothing answers at ${OWN}`)
    expect(said.line).not.toContain('choosing not to answer')
  })

  test('a proxy 502 — another process than the one the host started — is said', async () => {
    const another = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === `${OWN}${WELL_KNOWN}`) return new Response(JSON.stringify({ id: ID }), { headers: { 'content-type': 'application/json', [START_HEADER]: TOKEN_B } })
      return new Response('<script src="/main.js"></script>', { headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch
    const said = await whyQuiet('Example', `${STABLE}/app`, proxied(another, TOKEN_A))
    expect(said.kind).toBe('refused')
    expect(said.line).toContain('502')
    expect(said.line).toContain('not the process this host started')
  })

  test('a module’s own 503 is not the host’s refusal', async () => {
    const own = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch
    const said = await whyQuiet('Example', OWN_ENTRY, own)
    expect(said.kind).toBe('page')
  })

  test('the shrug names the address that was checked', async () => {
    const fine = (async () => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const said = await whyQuiet('Example', `${STABLE}/app`, fine)
    expect(said.kind).toBe('module')
    expect(said.line).toContain(`${STABLE}/app`)
  })
})

describe('a frame loaded before its module listened is loaded again', () => {
  type Seen = Parameters<Runs['seen']>[0][number]
  const ready = (run?: number, at = OWN): Seen => ({ id: ID, condition: 'ready', run, at })
  const down: Seen = { id: ID, condition: 'silent', at: OWN }
  const clock = () => {
    let now = 1_000_000
    return { now: () => now, elapse: (ms: number) => void (now += ms) }
  }

  test('a module that comes up after a reading said it was down: its frame gets a new document', () => {
    const time = clock()
    const runs = new Runs(time.now)
    expect(runs.seen([down])).toEqual([])
    expect(runs.seen([ready()])).toEqual([ID])
  })

  test('not while nothing changed', () => {
    const time = clock()
    const runs = new Runs(time.now)
    runs.seen([ready(100)])
    for (let i = 0; i < 5; i++) {
      time.elapse(RELOAD_CALM_MS)
      expect(runs.seen([ready(100)])).toEqual([])
    }
  })

  test('not when its page answers: a page that answers lost nothing', () => {
    const runs = new Runs(clock().now)
    runs.seen([ready(100)])
    runs.seen([down])
    expect(runs.seen([ready(100)], () => true)).toEqual([])
  })

  test('a new process, or another address, does', () => {
    const time = clock()
    const runs = new Runs(time.now)
    runs.seen([ready(100)])
    expect(runs.seen([ready(200)])).toEqual([ID])
    time.elapse(RELOAD_CALM_MS)
    expect(runs.seen([ready(200, 'http://127.0.0.1:7999')])).toEqual([ID])
  })

  test('debounced: a starting module that flaps is not reloaded in a loop, and the last change is owed', () => {
    const time = clock()
    const runs = new Runs(time.now)
    runs.seen([down])
    expect(runs.seen([ready(1)])).toEqual([ID])
    time.elapse(100)
    runs.seen([down])
    expect(runs.seen([ready(2)])).toEqual([])
    time.elapse(100)
    expect(runs.seen([ready(2)])).toEqual([])
    time.elapse(RELOAD_CALM_MS)
    expect(runs.seen([ready(2)])).toEqual([ID])
    time.elapse(RELOAD_CALM_MS)
    expect(runs.seen([ready(2)])).toEqual([])
  })
})

describe('a silent page is retried once before it is reported', () => {
  function aConversation(quiet: { kind: string; line: string }) {
    const said: string[] = []
    let retries = 0
    const realFetch = globalThis.fetch
    const asked: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push(String(input))
      return new Response(JSON.stringify({ ok: true, ...quiet }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
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
        retries++
      },
    }
    const conversation = new Conversation({ contentWindow: { postMessage() {} } as unknown as Window }, ID, null, async () => ({ ok: true, data: null }), watcher, {
      readyTimeoutMs: 20,
      entry: `${STABLE}/app`,
    })
    return { conversation, said, asked, retries: () => retries, restore: () => (globalThis.fetch = realFetch) }
  }
  const context = toWireContext({ epic: null, project: null }, 'dark')

  test('the module answers now: the page is loaded again, once, and then the diagnosis is said', async () => {
    const at = aConversation({ kind: 'refused', line: 'The host did not pass on the page.' })
    try {
      at.conversation.greet(context)
      await Bun.sleep(60)
      expect(at.retries()).toBe(1)
      expect(at.said).toEqual([])
      /* The reload's `load` greets again; still nothing: now it is said. */
      at.conversation.greet(context)
      await Bun.sleep(60)
      expect(at.retries()).toBe(1)
      /* The general sentence at the deadline, then what the server found. */
      expect(at.said.at(-1)).toBe('The host did not pass on the page.')
      /* And the server was told which address the frame was given. */
      expect(at.asked[0]).toContain(`framed=${encodeURIComponent(`${STABLE}/app`)}`)
    } finally {
      at.restore()
      at.conversation.close()
    }
  })

  test('the module is gone: nothing to retry, the sentence is said at once', async () => {
    const at = aConversation({ kind: 'gone', line: 'Example is not running.' })
    try {
      at.conversation.greet(context)
      await Bun.sleep(60)
      expect(at.retries()).toBe(0)
      expect(at.said).toEqual(['Example is not running.'])
    } finally {
      at.restore()
      at.conversation.close()
    }
  })
})

describe('one start of a module at a time', () => {
  test('concurrent starts collapse into one', async () => {
    const starts = new InFlight<string>()
    let ran = 0
    const work = async () => {
      ran++
      await Bun.sleep(20)
      return 'started'
    }
    const all = await Promise.all([starts.run(ID, work), starts.run(ID, work), starts.run(ID, work)])
    expect(ran).toBe(1)
    expect(all).toEqual(['started', 'started', 'started'])
    /* Another module is its own start. */
    await Promise.all([starts.run(ID, work), starts.run('kehikot.other', work)])
    expect(ran).toBe(3)
  })

  test('the next start after one settles runs again, and a failed one does not stick', async () => {
    const starts = new InFlight<string>()
    await expect(starts.run(ID, async () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(starts.has(ID)).toBe(false)
    expect(await starts.run(ID, async () => 'again')).toBe('again')
  })

  test('a press while the host’s own start is coming up waits for it instead of stopping it', () => {
    expect(joinsStart({ held: true, starting: true, inHand: false })).toBe(true)
    /* Answered already: a press is a restart, as before. */
    expect(joinsStart({ held: true, starting: false, inHand: false })).toBe(false)
    /* An update or a restart has it: those decide. */
    expect(joinsStart({ held: true, starting: true, inHand: true })).toBe(false)
    expect(joinsStart({ held: false, starting: true, inHand: false })).toBe(false)
  })
})
