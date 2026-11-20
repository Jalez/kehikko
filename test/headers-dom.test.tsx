import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A module's header as the page holds it (`app/useHeaders.ts`), run with the
 * page's own state around it:
 *
 *   - an agent's `press_item` handed to this page is judged again here against
 *     what the frame itself declared: an item marked for agents is pressed,
 *     said on the container and answered; one that is the person's is refused
 *     without reaching the module, whatever the server believed; an order for
 *     a kehikko or a module no longer on screen is refused; the same order
 *     heard twice is pressed once;
 *   - the person's press is not held to the agents' mark;
 *   - what is declared on the open kehikko is posted a moment after it
 *     changes, not again while it says the same, and again when the stream
 *     reopens.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.HEADERS_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('a module’s header as the page holds it, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, HEADERS_DOM: '1' },
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
let Hook: typeof import('../src/app/useHeaders.ts')
let Store: typeof import('../src/host/footerStore.ts')

type Headers = import('../src/host/header.ts').Headers
type PressOrder = import('../src/host/canvases.ts').PressOrder

const realFetch = globalThis.fetch
const posted: { url: string; body: Record<string, unknown> }[] = []

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ url: 'http://127.0.0.1:7700/', settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Hook = await import('../src/app/useHeaders.ts')
  Store = await import('../src/host/footerStore.ts')
})

afterAll(async () => {
  if (!inChild) return
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  if (!inChild) return
  posted.length = 0
  document.body.innerHTML = ''
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (id: string, label: string, agents = false) => ({ kind: 'run', id, label, agents, state: 'idle', result: null, disabled: null, confirm: false })
const HEADERS = { 'kehikot.a': [run('sync', 'Sync', true), run('wipe', 'Wipe')] } as unknown as Headers

/** The page around the hooks; what reached the module and what was said on the container, readable. */
async function mount() {
  const page = {
    sent: [] as unknown[],
    notes: {} as Record<string, unknown>,
    hook: null as unknown as ReturnType<typeof Hook.useHeaderPresses>,
    orderedRef: null as unknown as { current: ((order: PressOrder) => void) | null },
    repostRef: null as unknown as { current: (() => void) | null },
    setHeaders: (_: Headers) => {},
  }
  const presses = {
    item: (id: string, press: unknown) => {
      if (id !== 'kehikot.a') return null
      page.sent.push([id, press])
      return Promise.resolve({ ok: true, why: '' })
    },
  } as unknown as import('../src/host/presses.ts').Presses
  const footerStore = new Store.FooterStore()
  const byIdRef = { current: new Map([['kehikot.a', { id: 'kehikot.a', name: 'Alpha' }]]) as unknown as ReadonlyMap<string, import('../src/host/registry.ts').Presence> }
  const open = { id: 7, placements: [{ i: 'kehikot.a' }] }
  function Page() {
    const [headers, setHeaders] = React.useState<Headers>(HEADERS)
    const headersRef = React.useRef(headers)
    headersRef.current = headers
    const [pressNotes, setPressNotes] = React.useState<Readonly<Record<string, import('../src/canvas/HeaderMenus.tsx').PressNote>>>({})
    const orderedRef = React.useRef<((order: PressOrder) => void) | null>(null)
    const repostRef = React.useRef<(() => void) | null>(null)
    const openRef = React.useRef(open)
    const hook = Hook.useHeaderPresses({ headers, headersRef, footerStore, presses, byIdRef, openRef, setPressNotes, orderedRef })
    Hook.useHeaderPosting({ open, openId: 7, headers, footerStore, codeAt: '', addressAt: '', repostRef })
    Object.assign(page, { hook, orderedRef, repostRef, notes: pressNotes, setHeaders })
    return null
  }
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  await act(async () => root.render(<Page />))
  return { page, unmount: () => act(async () => root.unmount()) }
}

const answered = () => posted.filter((one) => one.url === '/host/pressed').map((one) => one.body)
const order = (id: string, item: string, more: Partial<PressOrder> = {}): PressOrder => ({ id, kehikko: 7, module: 'kehikot.a', item, ...more })

describe.if(inChild)('useHeaders', () => {
  test('an agent’s press of an item marked for agents is pressed, said on the container, answered, and made once', async () => {
    const { page, unmount } = await mount()
    await act(async () => {
      page.orderedRef.current!(order('o1', 'sync'))
      page.orderedRef.current!(order('o1', 'sync'))
      await wait(10)
    })
    expect(page.sent).toEqual([['kehikot.a', { item: 'sync' }]])
    expect(answered()).toEqual([expect.objectContaining({ id: 'o1', ok: true })])
    expect(page.notes['kehikot.a']).toEqual({ n: 1, item: 'sync', text: 'an agent pressed Sync' })
    expect(page.hook.agentPressedAt.current.has('kehikot.a')).toBe(true)
    await unmount()
  })

  test('the page judges again: the person’s item, another kehikko, a module gone, refused without reaching the module', async () => {
    const { page, unmount } = await mount()
    await act(async () => {
      page.orderedRef.current!(order('o2', 'wipe'))
      page.orderedRef.current!(order('o3', 'sync', { kehikko: 8 }))
      page.orderedRef.current!(order('o4', 'sync', { module: 'kehikot.z' }))
      await wait(10)
    })
    expect(page.sent).toEqual([])
    const said = answered()
    expect(said.map((one) => [one.id, one.ok])).toEqual([['o2', false], ['o3', false], ['o4', false]])
    expect(String(said[0]!.why)).toContain(`"wipe" is the person's: kehikot.a has not marked it for agents.`)
    expect(said[1]!.why).toBe('The page that was asked does not have kehikko 8 open any more, so nothing was pressed.')
    expect(said[2]!.why).toBe('kehikot.z is not on kehikko 7 any more, so nothing was pressed.')
    expect(page.notes).toEqual({})
    await unmount()
  })

  test('the person’s own press is not held to the agents’ mark', async () => {
    const { page, unmount } = await mount()
    let came: unknown
    await act(async () => {
      came = await page.hook.onPressItem('kehikot.a', { item: 'wipe' })
    })
    expect(came).toEqual({ ok: true, why: '' })
    expect(page.sent).toEqual([['kehikot.a', { item: 'wipe' }]])
    await unmount()
  })

  test('what is declared is posted a moment after a change, not again unchanged, and again when the stream reopens', async () => {
    const { page, unmount } = await mount()
    const postings = () => posted.filter((one) => one.url === '/host/headers')
    expect(postings()).toHaveLength(0)
    await act(async () => wait(300))
    expect(postings()).toHaveLength(1)
    expect(postings()[0]!.body).toMatchObject({ kehikko: 7, headers: HEADERS })
    /* The same declaration again is not news. */
    await act(async () => {
      page.setHeaders({ ...HEADERS })
      await wait(300)
    })
    expect(postings()).toHaveLength(1)
    await act(async () => page.repostRef.current!())
    expect(postings()).toHaveLength(2)
    await unmount()
  })
})
