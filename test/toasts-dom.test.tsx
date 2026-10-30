import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { DEFAULT_CHIME } from '../src/host/chime.ts'
import type { Entry } from '../src/host/inbox.ts'

/* The Inbox toast, rendered, in a process of its own (see `chime-dom.test.tsx`). */

const inChild = process.env.TOAST_DOM === '1'
const TESTS = 15

if (!inChild) {
  test('the toast, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TOAST_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Toasts: typeof import('../src/canvas/InboxToasts.tsx')
let UseToasts: typeof import('../src/canvas/useToasts.ts')
let Store: typeof import('../src/host/chimeStore.ts')

const entry = (id: string, state: Entry['state'], more: Partial<Entry> = {}): Entry => ({
  module: 'kehikot.claude', name: 'Claude', id, state, label: id, priority: 'normal', refs: [],
  entered: 1, opened: 1, closed: null, how: null, seen: null, dismissed: null, origin: 'activity', ...more,
})

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Toasts = await import('../src/canvas/InboxToasts.tsx')
  UseToasts = await import('../src/canvas/useToasts.ts')
  Store = await import('../src/host/chimeStore.ts')
  Settled = (await import('../src/host/toasts.ts')).settledToasts
})
afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
let plays = true
let opened: string[] = []
/** The record the app holds: a toast never changes it. */
let record: Entry[] = []
let bump: () => void = () => {}
let Settled: typeof import('../src/host/toasts.ts').settledToasts
let offer: (id: string, state?: Entry['state'], more?: Partial<Entry>) => void = () => {}

beforeEach(() => {
  if (!inChild) return
  Store.setChime({ ...DEFAULT_CHIME })
  plays = true
  opened = []
  record = []
})
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
})

/* What the app does: the same news offered to the toast, the window decision asked at the moment of showing. */
function Harness({ scale }: { scale: number }) {
  const toasts = UseToasts.useToasts(() => plays)
  const [, setN] = React.useState(0)
  bump = () => setN((n) => n + 1)
  /* What the app does: an item seen, dismissed or closed in the Inbox closes its toast. */
  const { closeMany } = toasts
  React.useEffect(() => {
    const settled = Settled(toasts.toasts, record, 1)
    if (settled.length) closeMany(settled)
  })
  offer = (id, state = 'done', more = {}) => {
    const one = entry(id, state, more)
    record.push(one)
    toasts.offer({ entry: one, project: 1, by: 'Claude', place: 'Wide · methods' })
  }
  return (
    <Toasts.InboxToasts
      toasts={toasts.toasts}
      scale={scale}
      onClose={toasts.close}
      onCloseAll={toasts.closeAll}
      onOpen={(toast) => {
        opened.push(toast.entry.id)
        toasts.close(toast.id)
      }}
    />
  )
}

/** `scale` is ms to a "second": the default setting never expires, so it matters only for a timed one. */
async function mount(scale = 1000) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => root.render(<Harness scale={scale} />))
  unmount = () => root.unmount()
  return el
}
const wait = (ms: number) => act(async () => await new Promise((resolve) => setTimeout(resolve, ms)))
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-inbox-toast]')]
const arrive = async (...ids: [string, Entry['state']?, Partial<Entry>?][]) => {
  await act(async () => ids.forEach(([id, state, more]) => offer(id, state, more)))
  await wait(400)
}

describe.skipIf(!inChild)('the Inbox toast, rendered', () => {
  test('a new item shows a toast: kind as icon and word, module, label, place, Open and Dismiss, in a polite region', async () => {
    await mount()
    await arrive(['Deploy the reel', 'attention', { priority: 'urgent' }])
    const region = document.querySelector('[data-inbox-toasts]')!
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.className).toContain('bottom-4')
    expect(region.className).toContain('right-4')
    const [card] = cards()
    expect(card!.getAttribute('data-inbox-toast')).toBe('urgent')
    expect(card!.querySelector('[data-toast-kind]')!.textContent).toBe('Urgent')
    expect(card!.querySelector('svg')).not.toBeNull()
    expect(card!.querySelector('[data-toast-by]')!.textContent).toBe('Claude')
    expect(card!.querySelector('[data-toast-label]')!.textContent).toBe('Deploy the reel')
    expect(card!.querySelector('[data-toast-place]')!.textContent).toBe('Wide · methods')
    expect(card!.querySelector('[data-toast-open]')!.textContent).toBe('Open')
    expect(card!.querySelector('[data-toast-dismiss]')!.textContent).toContain('Dismiss')
  })

  test('a named event heads the toast by its own words, as text, with the kind’s icon', async () => {
    await mount()
    await arrive(['Protocol audit', 'done', { named: { id: 'research-complete', says: 'Research complete' } }])
    const [card] = cards()
    expect(card!.getAttribute('data-inbox-toast')).toBe('done')
    const word = card!.querySelector('[data-toast-kind]')!
    expect(word.textContent).toBe('Research complete')
    expect(word.hasAttribute('data-toast-event')).toBe(true)
    expect(card!.getAttribute('aria-label')).toBe('Research complete: Protocol audit')
    expect(card!.querySelector('svg')).not.toBeNull()
    await arrive(['Plain', 'done'])
    expect(cards()[1]!.querySelector('[data-toast-kind]')!.textContent).toBe('Finished')
  })

  test('a label is text: markup in it is not rendered', async () => {
    await mount()
    await arrive(['<img src=x onerror=alert(1)> <a href="http://evil">go</a>'])
    const [card] = cards()
    expect(card!.querySelector('img, a')).toBeNull()
    expect(card!.querySelector('[data-toast-label]')!.textContent).toContain('<img')
  })

  test('a burst is one toast that says how many, the most urgent first', async () => {
    await mount()
    await arrive(['a', 'done'], ['b', 'attention', { priority: 'urgent', label: 'Deploy' }], ['c', 'attention'])
    expect(cards()).toHaveLength(1)
    expect(cards()[0]!.getAttribute('data-count')).toBe('3')
    expect(cards()[0]!.textContent).toContain('3 new in the Inbox')
    expect(cards()[0]!.querySelector('[data-toast-label]')!.textContent).toBe('Deploy')
  })

  test('another window plays: no toast. The setting off: no toast, though the sound is not muted. Working is nothing', async () => {
    await mount()
    plays = false
    await arrive(['a'])
    expect(cards()).toHaveLength(0)
    plays = true
    await act(async () => Store.setChime({ ...Store.chimeNow(), toast: false }))
    await arrive(['b'])
    expect(cards()).toHaveLength(0)
    expect(Store.chimeNow().on).toBe(true)
    await act(async () => Store.setChime({ ...Store.chimeNow(), toast: true, on: false }))
    await arrive(['w', 'working'])
    expect(cards()).toHaveLength(0)
    /* Muted sound, toast on: the toast shows. */
    await arrive(['c'])
    expect(cards()).toHaveLength(1)
  })

  test('at most three; a newer one replaces the oldest', async () => {
    await mount()
    for (const id of ['one', 'two', 'three', 'four']) await arrive([id])
    expect(cards().map((one) => one.querySelector('[data-toast-label]')!.textContent)).toEqual(['two', 'three', 'four'])
  })

  test('Open goes to the item and closes the toast; Dismiss closes the toast and changes nothing else', async () => {
    await mount()
    await arrive(['a'], )
    await arrive(['b'])
    const before = JSON.stringify(record)
    await act(async () => cards()[1]!.querySelector<HTMLElement>('[data-toast-dismiss]')!.click())
    expect(cards()).toHaveLength(1)
    expect(opened).toEqual([])
    expect(JSON.stringify(record)).toBe(before)
    await act(async () => cards()[0]!.querySelector<HTMLElement>('[data-toast-open]')!.click())
    expect(opened).toEqual(['a'])
    expect(cards()).toHaveLength(0)
  })

  test('a timed toast goes by itself, urgent ones no later than the rest', async () => {
    await mount(24)
    await act(async () => Store.setChime({ ...Store.chimeNow(), toastFor: 5 }))
    await arrive(['a', 'attention'])
    expect(cards()).toHaveLength(1)
    await wait(200)
    expect(cards()).toHaveLength(0)
  })

  test('hover or keyboard focus pauses the timer; leaving lets it run out', async () => {
    await mount(60)
    await act(async () => Store.setChime({ ...Store.chimeNow(), toastFor: 5 }))
    await arrive(['a'])
    const card = cards()[0]!
    await act(async () => card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await wait(500)
    expect(cards()).toHaveLength(1)
    await act(async () => card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })))
    await wait(500)
    expect(cards()).toHaveLength(0)
    /* Focus holds it too, and Escape on it closes it. */
    await arrive(['b'])
    const next = cards()[0]!
    const open = next.querySelector<HTMLElement>('[data-toast-open]')!
    await act(async () => open.focus())
    await wait(450)
    expect(cards()).toHaveLength(1)
    await act(async () => open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(cards()).toHaveLength(0)
  })

  test('by default a toast stays until dismissed', async () => {
    expect(Store.chimeNow().toastFor).toBe('dismiss')
    await mount(1)
    await arrive(['a', 'attention', { priority: 'urgent' }], )
    await arrive(['b'])
    await wait(600)
    expect(cards()).toHaveLength(2)
  })

  test('each timed option expires: 5, 10 and 30 s', async () => {
    /* A "second" is 10 ms here, so 5 s is 50 ms, 10 s is 100 ms and 30 s is 300 ms. */
    await mount(10)
    for (const [stay, ms] of [[5, 50], [10, 100], [30, 300]] as const) {
      await act(async () => Store.setChime({ ...Store.chimeNow(), toastFor: stay }))
      await arrive([`n${stay}`])
      expect(cards()).toHaveLength(1)
      await wait(ms / 2)
      expect(cards()).toHaveLength(1)
      await wait(ms + 150)
      expect(cards()).toHaveLength(0)
    }
  })

  test('the setting persists and is read: set, sent to the host, adopted from its answer', async () => {
    const sent: unknown[] = []
    const was = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { chime: Record<string, unknown> }
      sent.push(body.chime)
      return Response.json({ ok: true, chime: { ...Store.chimeNow(), ...body.chime } })
    }) as unknown as typeof fetch
    try {
      await Store.setToastFor(10)
      expect(sent).toEqual([{ toastFor: 10 }])
      expect(Store.chimeNow().toastFor).toBe(10)
      /* A host that says nothing of it (or an older one) reads as until dismissed. */
      Store.adoptChime({})
      expect(Store.chimeNow().toastFor).toBe('dismiss')
      /* One the host refuses goes back. */
      globalThis.fetch = (async () => Response.json({ ok: false, why: 'no' }, { status: 400 })) as unknown as typeof fetch
      await expect(Store.setToastFor(30)).rejects.toThrow()
      expect(Store.chimeNow().toastFor).toBe('dismiss')
    } finally {
      globalThis.fetch = was
    }
  })

  test('with Until dismissed the cap of three holds, and what was replaced is still in the record', async () => {
    await mount()
    for (const id of ['one', 'two', 'three', 'four', 'five']) await arrive([id])
    expect(cards().map((one) => one.querySelector('[data-toast-label]')!.textContent)).toEqual(['three', 'four', 'five'])
    expect(record.map((one) => one.id)).toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  test('Dismiss all shows when more than one is on screen, and closes them all', async () => {
    await mount()
    await arrive(['a'])
    expect(document.querySelector('[data-toast-dismiss-all]')).toBeNull()
    await arrive(['b'])
    const all = document.querySelector<HTMLElement>('[data-toast-dismiss-all]')!
    expect(all.textContent).toContain('Dismiss all')
    const before = JSON.stringify(record)
    await act(async () => all.click())
    expect(cards()).toHaveLength(0)
    expect(document.querySelector('[data-toast-dismiss-all]')).toBeNull()
    expect(JSON.stringify(record)).toBe(before)
  })

  test('opening the item closes its toast, and so does seeing or dismissing it in the Inbox', async () => {
    await mount()
    await arrive(['a'])
    await arrive(['b'])
    await arrive(['c'])
    await act(async () => cards()[0]!.querySelector<HTMLElement>('[data-toast-open]')!.click())
    expect(opened).toEqual(['a'])
    expect(cards().map((one) => one.querySelector('[data-toast-label]')!.textContent)).toEqual(['b', 'c'])
    /* Seen in the Inbox. */
    record.find((one) => one.id === 'b')!.seen = 1
    await act(async () => bump())
    expect(cards().map((one) => one.querySelector('[data-toast-label]')!.textContent)).toEqual(['c'])
    /* Dismissed in the Inbox. */
    record.find((one) => one.id === 'c')!.dismissed = 1
    await act(async () => bump())
    expect(cards()).toHaveLength(0)
  })
})
