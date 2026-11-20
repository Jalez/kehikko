import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * What a module may ask the canvas (`app/useCanvasControls.ts`), run with the
 * page's own state around it and asked through `controls`, as a module's
 * conversation asks:
 *
 *   - `view.fold`: only from a module on the open kehikko, never under a hand,
 *     signed with the module's name, and two asks before a render each start
 *     from what the one before left;
 *   - `address.open`: nowhere to show it is said, an asker not on the kehikko
 *     is refused, no module that shows pages is an offer to the person, and one
 *     that does is handed the address;
 *   - `settings.open`: only on the person's press and only a declared setting;
 *   - `controls` is made once, whatever renders.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.CANVAS_CONTROLS_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('what a module may ask the canvas, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CANVAS_CONTROLS_DOM: '1' },
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
let Hook: typeof import('../src/app/useCanvasControls.ts')
let Events: typeof import('../src/host/events.ts')

type Placement = import('../src/host/canvases.ts').Placement
type Canvas = import('../src/host/canvases.ts').Canvas

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ url: 'http://127.0.0.1:7700/', settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Hook = await import('../src/app/useCanvasControls.ts')
  Events = await import('../src/host/events.ts')
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  if (!inChild) return
  document.body.innerHTML = ''
})

const at = (i: string, x: number): Placement =>
  ({ i, x, y: 0, w: 8, h: 20, wish: 20, grow: false, pinned: false, prompt: '', promptFor: null, collapsed: false, selected: false, filters: {}, refreshEvery: null, version: null, scope: null }) as Placement

/** The page around the hook; what it changed, signed, offered and opened, readable. */
async function mount(options: { readers?: string[]; moving?: string | null } = {}) {
  const page = {
    placements: [at('kehikot.a', 0), at('kehikot.b', 8)],
    writes: [] as Placement[][],
    signed: [] as unknown[],
    offers: [] as unknown[],
    settings: [] as unknown[],
    controls: null as unknown as import('../src/host/ask.ts').CanvasControls,
    rerender: async () => {},
  }
  const byId = new Map([
    ['kehikot.a', { id: 'kehikot.a', name: 'Alpha', module: { declares: { settings: [{ key: 'theme', label: 'Theme', type: 'text' }] } } }],
    ['kehikot.b', { id: 'kehikot.b', name: 'Beta', module: {} }],
  ]) as unknown as ReadonlyMap<string, import('../src/host/registry.ts').Presence>
  const bus = new Events.EventBus()
  function Page({ tick }: { tick: number }) {
    void tick
    const [placements, setPlacements] = React.useState(page.placements)
    const open = { id: 7, key: 'k7', name: 'K7', project: 1, placements, connections: null } as unknown as Canvas
    const change = React.useCallback((edit: { placements?: Placement[] }) => {
      if (!edit.placements) return
      page.writes.push(edit.placements)
      setPlacements(edit.placements)
    }, [])
    const [addresses, setAddresses] = React.useState<import('../src/host/address.ts').Addresses>({})
    const addressesRef = React.useRef(addresses)
    addressesRef.current = addresses
    const [, setOffer] = React.useState<import('../src/host/address.ts').Offer | null>(null)
    const [, setExpanded] = React.useState<import('../src/host/expand.ts').Expanded | null>(null)
    const expandedRef = React.useRef<import('../src/host/expand.ts').Expanded | null>(null)
    const [, setKeptHere] = React.useState<ReadonlyMap<string, string>>(new Map())
    const nothing = { current: () => undefined } as never
    const hook = Hook.useCanvasControls({
      openId: 7,
      open,
      live: {},
      moving: options.moving ?? null,
      change,
      bus,
      reactsOf: (id) => ((options.readers ?? []).includes(id) ? ['address'] : []),
      addressesRef,
      setAddresses,
      setOffer: (next) => {
        page.offers.push(next)
        setOffer(next)
      },
      expandedRef,
      setExpanded,
      setKeptHere,
      openModuleSettings: (id, target) => page.settings.push([id, target]),
      noteFold: (kehikko, note) => page.signed.push([kehikko, note]),
      framingsRef: { current: [] },
      askingRef: { current: null },
      walkStepRef: nothing,
      changeSubjectRef: nothing,
      projectRef: { current: 1 },
      setSelectedByRef: nothing,
      setSaidRef: nothing,
      locateRef: nothing,
      pickRef: nothing,
      switchesRef: { current: null },
      kehikkoRef: { current: null } as never,
      legacyNoticeRef: nothing,
      later: { byId: () => byId },
    })
    page.controls = hook.controls
    page.placements = placements
    return null
  }
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  let tick = 0
  await act(async () => root.render(<Page tick={tick} />))
  page.rerender = () => act(async () => root.render(<Page tick={++tick} />))
  return { page, unmount: () => act(async () => root.unmount()) }
}

describe.if(inChild)('useCanvasControls', () => {
  test('view.fold: only from the kehikko, signed with the name, and two asks before a render compose', async () => {
    const { page, unmount } = await mount()
    expect(page.controls.fold('kehikot.z', { fold: ['kehikot.a'], unfold: [] })).toMatchObject({ outcome: 'declined' })
    let first: unknown
    let second: unknown
    await act(async () => {
      first = page.controls.fold('kehikot.a', { fold: ['kehikot.a'], unfold: [] })
      second = page.controls.fold('kehikot.a', { fold: ['kehikot.b'], unfold: [] })
    })
    expect(first).toMatchObject({ outcome: 'changed', folded: ['kehikot.a'] })
    expect(second).toMatchObject({ outcome: 'changed', folded: ['kehikot.b'] })
    /* The second write carries the first fold too: it started from what the first left. */
    expect(page.writes.at(-1)!.map((p) => [p.i, p.collapsed])).toEqual([['kehikot.a', true], ['kehikot.b', true]])
    expect(page.signed[0]).toEqual([7, { by: 'Alpha', fold: ['kehikot.a'], unfold: [] }])
    await unmount()
  })

  test('view.fold under a hand is declined with its sentence', async () => {
    const { page, unmount } = await mount({ moving: 'kehikot.b' })
    expect(page.controls.fold('kehikot.a', { fold: ['kehikot.a'], unfold: [] })).toMatchObject({
      outcome: 'declined',
      why: 'A container is being moved or resized. Ask again when it has been let go.',
    })
    expect(page.writes).toEqual([])
    await unmount()
  })

  test('address.open: refused off the kehikko, offered with no reader, handed to one that shows pages', async () => {
    const none = await mount()
    expect(none.page.controls.openAddress('kehikot.z', 'https://example.com/', undefined, undefined)).toMatchObject({ outcome: 'declined' })
    let offered: unknown
    await act(async () => {
      offered = none.page.controls.openAddress('kehikot.a', 'https://example.com/', 'Example', undefined)
    })
    expect(offered).toMatchObject({ outcome: 'offered' })
    expect(none.page.offers.at(-1)).toMatchObject({ kehikko: 7, url: 'https://example.com/', by: 'kehikot.a' })
    await none.unmount()

    const reader = await mount({ readers: ['kehikot.b'] })
    let shown: unknown
    await act(async () => {
      shown = reader.page.controls.openAddress('kehikot.a', 'https://example.com/', undefined, undefined)
    })
    expect(shown).toMatchObject({ outcome: 'shown' })
    expect(reader.page.offers).toEqual([])
    await reader.unmount()
  })

  test('settings.open only on a press and a declared setting; controls made once', async () => {
    const { page, unmount } = await mount()
    const made = page.controls
    expect(page.controls.openSettings!('kehikot.a', { key: 'theme' }, false)).toMatchObject({ outcome: 'declined' })
    expect(page.controls.openSettings!('kehikot.a', { key: 'nope' }, true)).toMatchObject({ outcome: 'declined' })
    expect(page.controls.openSettings!('kehikot.b', {}, true)).toMatchObject({ outcome: 'declined' })
    expect(page.controls.openSettings!('kehikot.a', { key: 'theme' }, true)).toEqual({ outcome: 'opened', why: '' })
    expect(page.settings).toEqual([['kehikot.a', 'theme']])
    await page.rerender()
    expect(page.controls).toBe(made)
    await unmount()
  })
})
