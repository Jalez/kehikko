import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { DEFAULT_CHIME } from '../src/host/chime.ts'
import type { Entry } from '../src/host/inbox.ts'

/* The Inbox toast, rendered, in a process of its own (see `chime-dom.test.tsx`). */

const inChild = process.env.TOAST_DOM === '1'
const TESTS = 8

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
function Harness({ ms }: { ms: number }) {
  const toasts = UseToasts.useToasts(() => plays)
  offer = (id, state = 'done', more = {}) => {
    const one = entry(id, state, more)
    record.push(one)
    toasts.offer({ entry: one, project: 1, by: 'Claude', place: 'Wide · methods' })
  }
  return (
    <Toasts.InboxToasts
      toasts={toasts.toasts}
      ms={() => ms}
      onClose={toasts.close}
      onOpen={(toast) => {
        opened.push(toast.entry.id)
        toasts.close(toast.id)
      }}
    />
  )
}

async function mount(ms = 60_000) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => root.render(<Harness ms={ms} />))
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
    Store.setChime({ ...Store.chimeNow(), toast: false })
    await arrive(['b'])
    expect(cards()).toHaveLength(0)
    expect(Store.chimeNow().on).toBe(true)
    Store.setChime({ ...Store.chimeNow(), toast: true, on: false })
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

  test('every toast goes by itself, none sticks: a short one first', async () => {
    await mount(120)
    await arrive(['a', 'attention'])
    expect(cards()).toHaveLength(1)
    await wait(200)
    expect(cards()).toHaveLength(0)
  })

  test('hover or keyboard focus pauses the timer; leaving lets it run out', async () => {
    await mount(300)
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
})
