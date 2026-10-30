import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The pinned places menu and the Pin button, rendered and pressed, wired to
 * the real hook (`usePinnedPlaces`) over a stand-in for the server's store:
 * the empty state, picking a pin (into another project too: it is handed to
 * the page's one navigator as the place to go), a stale pin greyed with its
 * reason and still unpinnable, unpin by its button and by Delete, the order by
 * Alt+↓, the Pin toggle and Alt+Shift+P, and the classes that make the label
 * give way first at narrow widths (measured for real on bee:
 * `dev/header-fit.drive.mjs`).
 *
 * In a process of its own, for the reason `parts-pressed.test.tsx` gives.
 */
const inChild = process.env.PINNED_DOM === '1'
const TESTS = 9

if (!inChild) {
  test('the pinned places menu and the Pin button, in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, PINNED_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

type PinnedPlace = import('../src/host/pinnedPlaces.ts').PinnedPlace
type PinTarget = import('../src/host/pinnedPlaces.ts').PinTarget
type Place = import('../src/host/jump.ts').Place

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let PinnedMenu: typeof import('../src/canvas/PinnedPlaces.tsx').PinnedMenu
let PinButton: typeof import('../src/canvas/PinnedPlaces.tsx').PinButton
let usePinnedPlaces: typeof import('../src/canvas/usePinnedPlaces.ts').usePinnedPlaces

/** The server's store, as far as the page sees it. */
let store: PinnedPlace[] = []
let posted: unknown[] = []
let nextId = 100

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  ;({ PinnedMenu, PinButton } = await import('../src/canvas/PinnedPlaces.tsx'))
  ;({ usePinnedPlaces } = await import('../src/canvas/usePinnedPlaces.ts'))
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const edit = JSON.parse(String(init.body)) as { pin?: PinTarget; unpin?: number; order?: number[] }
      posted.push(edit)
      if (edit.pin) store = [{ id: nextId++, target: edit.pin, label: 'Pinned here', stale: null, note: null }, ...store]
      if (edit.unpin) store = store.filter((one) => one.id !== edit.unpin)
      if (edit.order) store = edit.order.flatMap((id) => store.filter((one) => one.id === id))
    }
    return new Response(JSON.stringify({ pinned: store }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
  posted = []
})

const A: PinTarget = { project: 1, kehikko: 'wide', epic: 'thesis', scope: 'epic', parts: ['methods'] }
const B: PinTarget = { project: 2, kehikko: 'main', epic: 'draft', scope: 'epic', parts: [] }
const C: PinTarget = { project: 1, kehikko: 'gone', epic: 'thesis', scope: 'epic', parts: [] }

const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 0))))

/** The two controls, wired as `App.tsx` wires them; `went` is every place handed to the navigator. */
async function mount(here: PinTarget | null, pins: PinnedPlace[]) {
  store = pins
  const went: Place[] = []
  const troubles: string[] = []
  function Wired() {
    const view = usePinnedPlaces({ here, go: (place) => void went.push(place), trouble: (why) => void troubles.push(why) })
    return (
      <TooltipProvider>
        <PinnedMenu view={view} />
        <PinButton view={view} />
      </TooltipProvider>
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Wired />))
  await settle()
  unmount = () => root.unmount()
  return { went, troubles, host }
}

const trigger = () => document.querySelector('[data-testid="pinned-menu"]') as HTMLElement
const pinHere = () => document.querySelector('[data-testid="pin-here"]') as HTMLButtonElement
const row = (id: number) => document.querySelector(`[data-pinned="${id}"]`) as HTMLElement
const openMenu = async () => {
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger().click()
  })
  await settle()
}
const press = (el: HTMLElement) => act(async () => el.click())
const key = (el: HTMLElement, k: string, more: KeyboardEventInit = {}) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...more })))

describe.if(inChild)('the menu', () => {
  test('empty: says how to pin', async () => {
    await mount(A, [])
    expect(trigger().getAttribute('aria-label')).toBe('Pinned places')
    await openMenu()
    expect(document.querySelector('[data-testid="pinned-empty"]')?.textContent).toBe('Pin a place to come back to it in one click.')
  })

  test('rows say their labels; picking one hands its place to the navigator, into another project too', async () => {
    const { went } = await mount(A, [
      { id: 1, target: B, label: 'Paper › Draft · Main', stale: null, note: null },
      { id: 2, target: A, label: 'CS-DEGREE › thesis › methods · Wide', stale: null, note: null },
    ])
    expect(trigger().getAttribute('aria-label')).toBe('Pinned places — 2')
    await openMenu()
    expect([...document.querySelectorAll('[data-testid="pinned-row-label"]')].map((el) => el.textContent)).toEqual([
      'Paper › Draft · Main',
      'CS-DEGREE › thesis › methods · Wide',
    ])
    await press(row(1))
    expect(went).toEqual([{ project: 2, kehikko: 'main', epic: 'draft', parts: [], step: null }])
  })

  test('a stale pin is greyed with its reason, goes nowhere, and is still unpinned by its button', async () => {
    const { went } = await mount(A, [{ id: 3, target: C, label: 'CS-DEGREE › thesis · Gone', stale: 'The kehikko Gone is gone.', note: null }])
    await openMenu()
    expect(row(3).getAttribute('aria-disabled')).toBe('true')
    expect(row(3).querySelector('[data-testid="pinned-row-why"]')?.textContent).toBe('The kehikko Gone is gone.')
    await press(row(3))
    expect(went).toEqual([])
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    const unpin = row(3).querySelector('[data-testid="pinned-unpin"]') as HTMLElement
    expect(unpin.getAttribute('aria-label')).toBe('Unpin CS-DEGREE › thesis · Gone')
    await press(unpin)
    await settle()
    expect(posted).toEqual([{ unpin: 3 }])
    expect(went).toEqual([])
    expect(document.querySelector('[data-testid="pinned-empty"]')).not.toBeNull()
  })

  test('a pin with some parts gone says so and still goes to the rest', async () => {
    const { went } = await mount(A, [{ id: 4, target: { ...A, parts: ['results'] }, label: 'CS-DEGREE › thesis › methods, results · Wide', stale: null, note: 'methods is gone from the epic; the rest are kept.' }])
    await openMenu()
    expect(row(4).querySelector('[data-testid="pinned-row-why"]')?.textContent).toBe('methods is gone from the epic; the rest are kept.')
    await press(row(4))
    expect(went).toEqual([{ project: 1, kehikko: 'wide', epic: 'thesis', parts: ['results'], step: null }])
  })

  test('on the keyboard: Delete unpins, Alt+↓ moves a row down', async () => {
    await mount(A, [
      { id: 1, target: B, label: 'one', stale: null, note: null },
      { id: 2, target: A, label: 'two', stale: null, note: null },
      { id: 3, target: C, label: 'three', stale: null, note: null },
    ])
    await openMenu()
    await key(row(1), 'ArrowDown', { altKey: true })
    await settle()
    expect(posted).toEqual([{ order: [2, 1, 3] }])
    expect([...document.querySelectorAll('[data-pinned]')].map((el) => el.getAttribute('data-pinned'))).toEqual(['2', '1', '3'])
    await key(row(3), 'Delete')
    await settle()
    expect(posted).toEqual([{ order: [2, 1, 3] }, { unpin: 3 }])
    expect([...document.querySelectorAll('[data-pinned]')].map((el) => el.getAttribute('data-pinned'))).toEqual(['2', '1'])
    /* Up and down have their names for a screen reader, and the first row's up is flat. */
    expect(row(2).querySelector('[aria-label="Move two up"]')?.getAttribute('aria-disabled')).toBe('true')
    expect(row(2).querySelector('[aria-label="Move two down"]')?.getAttribute('aria-disabled')).toBeNull()
  })
})

describe.if(inChild)('the Pin button', () => {
  test('pins the place on screen, then is filled and unpins it', async () => {
    await mount(A, [])
    expect(pinHere().getAttribute('aria-label')).toBe('Pin this place')
    expect(pinHere().getAttribute('aria-pressed')).toBe('false')
    expect(pinHere().getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+P')
    await press(pinHere())
    await settle()
    expect(posted).toEqual([{ pin: A }])
    expect(pinHere().getAttribute('aria-label')).toBe('Unpin this place')
    expect(pinHere().getAttribute('aria-pressed')).toBe('true')
    expect(pinHere().querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
    await press(pinHere())
    await settle()
    expect(posted).toEqual([{ pin: A }, { unpin: 100 }])
    expect(pinHere().getAttribute('aria-pressed')).toBe('false')
  })

  test('Alt+Shift+P does the same, and not in a text field', async () => {
    await mount(A, [])
    const field = document.createElement('input')
    document.body.append(field)
    await key(field, 'P', { altKey: true, shiftKey: true, code: 'KeyP' })
    await settle()
    expect(posted).toEqual([])
    await key(document.body, 'P', { altKey: true, shiftKey: true, code: 'KeyP' })
    await settle()
    expect(posted.length).toBe(1)
    expect(pinHere().getAttribute('aria-pressed')).toBe('true')
  })

  test('with no project open it is flat and says why', async () => {
    await mount(null, [])
    expect(pinHere().disabled).toBe(true)
    await press(pinHere())
    expect(posted).toEqual([])
  })
})

describe.if(inChild)('at narrow widths', () => {
  test('the word gives way to the icon under 900 pixels; the Pin button and the menu’s icon stay', async () => {
    await mount(A, [{ id: 1, target: B, label: 'one', stale: null, note: null }])
    expect(document.querySelector('[data-testid="pinned-label"]')?.className).toContain('max-[900px]:hidden')
    expect(trigger().className).toContain('shrink-0')
    expect(trigger().querySelector('svg')?.getAttribute('class') ?? '').not.toContain('hidden')
    expect(pinHere().className).toContain('shrink-0')
    expect(pinHere().className).not.toMatch(/max-\[\d+px\]:hidden/)
  })
})
