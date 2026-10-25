import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { forgetReports, reportOpen } from '../src/host/canvases.ts'
import { arrive, oneAfterAnother } from '../src/host/looks.ts'

/*
 * After a relaunch the modules on the open kehikko did not start until the
 * person switched apps and back, or pressed Start on one of them. The window of
 * an app relaunched behind another is not frontmost: no focus, possibly hidden,
 * and in a WKWebView no animation frames. What the page does on arriving must
 * need none of those.
 */

type Sent = { method: string; path: string; body: unknown }

const g = globalThis as Record<string, unknown>
const had: Record<string, unknown> = {}
let sent: Sent[] = []
let release: (() => void)[] = []

beforeEach(() => {
  forgetReports()
  for (const key of ['window', 'document', 'fetch', 'requestAnimationFrame']) had[key] = g[key]
  sent = []
  release = []
  const store = new Map<string, string>()
  g.window = {
    location: { origin: 'http://127.0.0.1:4290' },
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
  }
  /* Behind another app: not focused, hidden, and a frame that never comes. */
  g.document = { visibilityState: 'hidden', hidden: true, hasFocus: () => false }
  g.requestAnimationFrame = () => {
    throw new Error('arriving waited on an animation frame')
  }
  g.fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://127.0.0.1:4290')
    sent.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(had)) g[key] = value
})

/** A sweep that asks `/host/modules` and is held open until released. */
function sweepHeld(): () => Promise<void> {
  return async () => {
    await fetch('/host/modules')
    await new Promise<void>((done) => release.push(done))
  }
}

describe('arriving at a kehikko, with the window not frontmost', () => {
  test('the report and the sweep after it are sent without focus, visibility or a frame', async () => {
    let swept = 0
    await arrive(7, async () => {
      swept++
      await fetch('/host/modules')
    })
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /host/open', 'GET /host/modules'])
    expect((sent[0]!.body as { kehikko: number }).kehikko).toBe(7)
    expect(swept).toBe(1)
  })

  test('the sweep after the report happens even though the load sweep is still out', async () => {
    const look = oneAfterAnother(sweepHeld())
    /* The page sweeps on mount… */
    const first = look()
    /* …and the canvases arrive while it is out: the report, then a sweep. */
    const arrived = arrive(7, look)
    await Bun.sleep(0)
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /host/modules', 'POST /host/open'])
    release.shift()!()
    await first
    await Bun.sleep(0)
    /* The second sweep starts after the report landed, so the server is asked
       knowing what is open — which is what it starts modules from. */
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['GET /host/modules', 'POST /host/open', 'GET /host/modules'])
    release.shift()!()
    await arrived
  })
})

describe('a report that changes nothing', () => {
  const answering = (body: unknown) => {
    g.fetch = async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://127.0.0.1:4290')
      sent.push({ method: init?.method ?? 'GET', path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }
  }

  test('the host started nothing on it: no sweep after it', async () => {
    answering({ ok: true, started: false })
    await arrive(7, async () => {
      await fetch('/host/modules')
    })
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(['POST /host/open'])
  })

  test('the same report said again (focus, pageshow, StrictMode) is sent once; another kehikko is sent', async () => {
    answering({ ok: true, started: false })
    await Promise.all([reportOpen(7), reportOpen(7)])
    await reportOpen(7)
    await reportOpen(8)
    /* A reopened stream: the server may have forgotten it. */
    await reportOpen(8, { again: true })
    expect(sent.map((s) => (s.body as { kehikko: number }).kehikko)).toEqual([7, 8, 8])
  })

  test('a page that never reported has nothing to withdraw', async () => {
    answering({ ok: true, started: false })
    await reportOpen(null)
    expect(sent).toEqual([])
  })
})

describe('oneAfterAnother', () => {
  test('never two at once, and every call made meanwhile shares one more run', async () => {
    let running = 0
    let most = 0
    let runs = 0
    const look = oneAfterAnother(async () => {
      runs++
      running++
      most = Math.max(most, running)
      await new Promise<void>((done) => release.push(done))
      running--
    })
    const a = look()
    const b = look()
    const c = look()
    expect(b).toBe(c)
    release.shift()!()
    await a
    await Bun.sleep(0)
    release.shift()!()
    await Promise.all([b, c])
    expect(runs).toBe(2)
    expect(most).toBe(1)
  })

  test('a run that fails does not stop the one owed after it', async () => {
    let runs = 0
    const look = oneAfterAnother(async () => {
      runs++
      if (runs === 1) {
        await Bun.sleep(1)
        throw new Error('the host is not answering')
      }
    })
    const first = look().catch(() => 'failed')
    const second = look()
    expect(await first).toBe('failed')
    await second
    expect(runs).toBe(2)
  })
})
