import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

/*
 * The person's fresh press into a module's frame, as this page sees it (`host/gesture.ts`): the
 * window's blur with the frame left as the active element is a press the page witnessed itself, so a
 * request from that frame a moment later is fresh even where the engine gives this document no
 * activation (a webview that does not propagate it from a cross-origin frame). A module's own
 * `kehikot.pointer` is never one. `view.expand` and `messages.say` read the same witness.
 *
 * In a process of its own: the page's one record of presses is module state, and the DOM is global.
 */

const inChild = process.env.FRESH_PRESS_DOM === '1'
const TESTS = 8

if (!inChild) {
  test('the person’s fresh press into a frame, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, FRESH_PRESS_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

let Gesture: typeof import('../src/host/gesture.ts')
let Rows: typeof import('../src/host/rows.ts')
let Conv: typeof import('../src/host/conversation.ts')
let Ask: typeof import('../src/host/ask.ts')
let Expand: typeof import('../src/host/expand.ts')
let Protocol: typeof import('kehikot-module-protocol')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true } })
  Gesture = await import('../src/host/gesture.ts')
  Rows = await import('../src/host/rows.ts')
  Conv = await import('../src/host/conversation.ts')
  Ask = await import('../src/host/ask.ts')
  Expand = await import('../src/host/expand.ts')
  Protocol = await import('kehikot-module-protocol')
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const AGENT = 'kehikot.agent'
const OTHER = 'kehikot.other'
const POLL = 10
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const cleanups: (() => void)[] = []
let frames: Record<string, HTMLIFrameElement>

beforeEach(() => {
  if (!inChild) return
  /* The webview of the bug: no activation reaches this document from a press in a frame. */
  expect(Gesture.pressFresh()).toBe(false)
  frames = Object.fromEntries(
    [AGENT, OTHER].map((id) => {
      const layer = document.createElement('div')
      layer.setAttribute('data-frame', id)
      const frame = document.createElement('iframe')
      frame.tabIndex = 0
      layer.appendChild(frame)
      document.body.appendChild(layer)
      return [id, frame]
    }),
  )
  /* What App.tsx listens with: every move this document observed is offered to `sawPress`. */
  cleanups.push(Rows.watchClicks(document, window, (event) => Gesture.sawPress(event), POLL))
})

afterEach(() => {
  if (!inChild) return
  for (const clean of cleanups.splice(0)) clean()
  Gesture.framePresses.forget(AGENT)
  Gesture.framePresses.forget(OTHER)
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  window.dispatchEvent(new Event('focus'))
  document.body.innerHTML = ''
})

/* A press into a frame, as the engine tells the host: the frame takes the keyboard and this window blurs. */
async function pressInto(id: string) {
  frames[id]!.focus()
  window.dispatchEvent(new Event('blur'))
  await wait(POLL * 3)
}

const inert = new Proxy({}, { get: () => () => {} }) as never

/** A conversation as ModuleFrame makes it: no `pressed` given, so the page's own witness is read. */
function conversationFor(id: string, ask: import('../src/host/conversation.ts').Ask, watcher: object = inert) {
  const win = { postMessage: () => {} } as unknown as Window
  const conversation = new Conv.Conversation({ contentWindow: win }, id, null, ask, watcher as never)
  let n = 0
  return {
    request: (method: string, params: unknown) =>
      conversation.receive({ source: win, origin: 'null', data: { type: Protocol.MESSAGE.REQUEST, id: `r${++n}`, method, params } }),
    pointer: (phase: 'down' | 'up') => conversation.receive({ source: win, origin: 'null', data: { type: Protocol.MESSAGE.POINTER, phase, at: 1 } }),
  }
}

describe('a fresh press into a frame', () => {
  if (!inChild) return

  test('a press into a frame that this page saw is fresh for that frame alone, for a moment', async () => {
    await pressInto(AGENT)
    expect(Gesture.framePresses.freshFor(AGENT)).toBe(true)
    expect(Gesture.pressFreshFor(AGENT)).toBe(true)
    expect(Gesture.pressFreshFor(OTHER)).toBe(false)
    expect(Gesture.pressFreshFor(AGENT, { now: Date.now() + Gesture.FRESH_PRESS_MS + 100 })).toBe(false)
  })

  test('a press on a container’s own chrome is one too; the browser’s activation still counts alone', async () => {
    const chrome = document.createElement('div')
    chrome.setAttribute('data-module', OTHER)
    document.body.appendChild(chrome)
    chrome.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(Gesture.pressFreshFor(OTHER)).toBe(true)
    expect(Gesture.pressFreshFor(AGENT, { nav: { userActivation: { isActive: true } } })).toBe(true)
  })

  test('a module’s own kehikot.pointer is not a press: the request after it is not fresh', async () => {
    const hows: unknown[] = []
    /* Even a consumer that hands the page's claim to `sawPress` records nothing from it. */
    const watcher = new Proxy({}, { get: (_t, key) => (key === 'pointer' ? () => Gesture.sawPress({ kind: 'press', id: AGENT }) : () => {}) })
    const frame = conversationFor(
      AGENT,
      async (_method, _params, how) => {
        hows.push(how)
        return { ok: true, data: null }
      },
      watcher,
    )
    expect(frame.pointer('down')).toBe(true)
    expect(frame.pointer('up')).toBe(true)
    frame.request('view.expand', { expand: true })
    expect(hows).toEqual([{ pressed: false }])
    expect(Gesture.framePresses.freshFor(AGENT)).toBe(false)
  })

  /* The canvas's half of `view.expand`, as App.tsx answers it, on the open kehikko. */
  function expandCanvas(record: { now: import('../src/host/expand.ts').Expanded | null }) {
    return {
      expand: (from: string, call: { expand: boolean }, pressed: boolean) => {
        const { result, next } = Expand.expandAsked(record.now, { from, expand: call.expand, pressed, kehikko: 1, onOpen: true })
        record.now = next
        if (result.outcome === 'declined' && result.why === Expand.EXPAND_NO_PRESS) Gesture.letGoOfFrame(document, from)
        return result
      },
    } as unknown as import('../src/host/ask.ts').CanvasControls
  }

  async function expandThrough(record: { now: import('../src/host/expand.ts').Expanded | null }) {
    const ask = Ask.makeAsk(AGENT, expandCanvas(record), (capability) => capability === 'view:expand')
    const answers: unknown[] = []
    const frame = conversationFor(AGENT, async (method, params, how) => {
      const answer = await ask(method, params, how)
      answers.push(answer)
      return answer
    })
    frame.request('view.expand', { expand: true })
    await wait(5)
    return answers
  }

  test('view.expand on a press this page saw: expanded', async () => {
    const record: { now: import('../src/host/expand.ts').Expanded | null } = { now: null }
    await pressInto(AGENT)
    expect(await expandThrough(record)).toEqual([{ ok: true, data: { outcome: 'expanded', why: '' } }])
    expect(record.now).toEqual({ kehikko: 1, id: AGENT })
  })

  test('view.expand with no press: declined with a sentence for the tile, and the frame lets go of the keyboard', async () => {
    const record: { now: import('../src/host/expand.ts').Expanded | null } = { now: null }
    await pressInto(AGENT)
    /* The press was long ago: still in the frame, but not fresh. */
    Gesture.framePresses.saw(AGENT, Date.now() - Gesture.FRESH_PRESS_MS - 500)
    expect(document.activeElement).toBe(frames[AGENT]!)
    expect(await expandThrough(record)).toEqual([{ ok: true, data: { outcome: 'declined', why: Expand.EXPAND_NO_PRESS } }])
    expect(record.now).toBeNull()
    /* So the person's next press into it is a blur this page sees, and is granted. */
    expect(document.activeElement).not.toBe(frames[AGENT]!)
    window.dispatchEvent(new Event('focus'))
    await pressInto(AGENT)
    expect(await expandThrough(record)).toEqual([{ ok: true, data: { outcome: 'expanded', why: '' } }])
  })

  test('a press seen into ANOTHER frame does not let this one expand', async () => {
    const record: { now: import('../src/host/expand.ts').Expanded | null } = { now: null }
    await pressInto(OTHER)
    expect(await expandThrough(record)).toEqual([{ ok: true, data: { outcome: 'declined', why: Expand.EXPAND_NO_PRESS } }])
  })

  test('messages.say reads the same witness: sent on a press this page saw, declined without one', async () => {
    const posted: unknown[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)))
      return Response.json({ ok: true, data: { outcome: 'sent', id: 1, why: '' } })
    }) as unknown as typeof fetch
    cleanups.push(() => {
      globalThis.fetch = realFetch
    })
    const canvas = { project: () => 1, place: () => ({ epic: null, parts: [], kehikko: 'k' }) } as unknown as import('../src/host/ask.ts').CanvasControls
    const ask = Ask.makeAsk(AGENT, canvas, (capability) => capability === 'messages:as-person')
    const answers: unknown[] = []
    const frame = conversationFor(AGENT, async (method, params, how) => {
      const answer = await ask(method, params, how)
      answers.push(answer)
      return answer
    })
    const params = { body: 'Use SQLite', to: { project: true } }
    frame.request('messages.say', params)
    await wait(5)
    expect(answers[0]).toMatchObject({ ok: true, data: { outcome: 'declined', why: Ask.SAY_SAYS.noPress } })
    expect(posted).toEqual([])
    await pressInto(AGENT)
    frame.request('messages.say', params)
    await wait(5)
    expect(answers[1]).toEqual({ ok: true, data: { outcome: 'sent', id: 1, why: '' } })
    expect(posted).toHaveLength(1)
  })

  test('letGoOfFrame touches only the frame it names', async () => {
    await pressInto(OTHER)
    expect(Gesture.letGoOfFrame(document, AGENT)).toBe(false)
    expect(document.activeElement).toBe(frames[OTHER]!)
    expect(Gesture.letGoOfFrame(document, OTHER)).toBe(true)
    expect(document.activeElement).not.toBe(frames[OTHER]!)
  })
})
