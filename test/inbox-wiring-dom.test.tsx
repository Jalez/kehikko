import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The Inbox as the page wires it (`useInboxWiring`, `app/useInboxWiring.ts`),
 * run with the page's own state around it:
 *
 *   - "Next that needs me" is Alt+Shift+N, by `code`, never in a text field
 *     and never with Ctrl or ⌘: with the Inbox's module not on this kehikko it
 *     opens the bar's panel; with it here, it lights that container, hands it
 *     the keyboard and tells it the next item, and the next press the one after;
 *   - the item Next told is the one a module's page may open without a press
 *     of its own (`inbox.open`), and no other;
 *   - the bar's count says how many need the person and offers to add the
 *     Inbox's module where it is not.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.INBOX_WIRING_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('the Inbox as the page wires it, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, INBOX_WIRING_DOM: '1' },
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
let Hook: typeof import('../src/app/useInboxWiring.ts')

type Entry = import('../src/host/inbox.ts').Entry

const realFetch = globalThis.fetch

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ url: 'http://127.0.0.1:7700/', settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Hook = await import('../src/app/useInboxWiring.ts')
})

afterAll(async () => {
  if (!inChild) return
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  if (!inChild) return
  document.body.innerHTML = ''
})

const INBOX = 'kehikot.inbox'
const entry = (id: string, entered: number): Entry =>
  ({
    module: 'kehikot.agent',
    name: 'Agent',
    id,
    state: 'attention',
    label: `Item ${id}`,
    priority: 'normal',
    refs: [],
    entered,
    opened: entered,
    closed: null,
    how: null,
    seen: null,
    dismissed: null,
  }) as unknown as Entry
const ENTRIES = [entry('a', 1), entry('b', 2)]

/** The page around the hook: what it pressed, lit, opened and drew, readable. */
async function mount({ placed }: { placed: boolean }) {
  const page = {
    told: [] as unknown[],
    opened: [] as Entry[],
    inboxOpen: false,
    hook: null as unknown as ReturnType<typeof Hook.useInboxWiring>,
    inboxAskRef: null as unknown as { current: NonNullable<import('../src/host/ask.ts').CanvasControls['inbox']> },
  }
  const presses = {
    inbox: (id: string, signal: unknown) => {
      page.told.push(['inbox', id, signal])
      return true
    },
    focus: (id: string) => {
      page.told.push(['focus', id])
      return true
    },
  } as unknown as import('../src/host/presses.ts').Presses
  const inbox = {
    open: ENTRIES,
    others: [],
    all: ENTRIES,
    live: ENTRIES,
    earlier: [],
    rev: 1,
    muted: new Set<string>(),
    act: () => {},
    answer: () => {},
    use: () => {},
    see: () => {},
  } as unknown as Parameters<typeof Hook.useInboxWiring>[0]['inbox']
  const registry = {
    presences: [{ id: INBOX, name: 'Inbox', condition: 'ready', icon: null, module: { version: '1.0.0', declares: { uses: ['inbox:person'] } } }],
    sweep: { dir: '', rejected: [] },
  } as unknown as import('../src/host/registry.ts').RegistryView
  const open = { key: 'main', placements: placed ? [{ i: INBOX }] : [] }
  const about = { epic: null, parts: [], selection: [] } as unknown as Parameters<typeof Hook.useInboxWiring>[0]['about']
  function Page() {
    const [inboxOpen, setInboxOpen] = React.useState(false)
    const inboxAskRef = React.useRef<NonNullable<import('../src/host/ask.ts').CanvasControls['inbox']>>(() => Promise.resolve({ ok: false, reason: 'failed', error: '' }) as never)
    const hook = Hook.useInboxWiring({
      inbox,
      registry,
      open,
      projectId: 1,
      project: { name: 'p1' },
      projects: [{ id: 1, name: 'p1', path: '/w/p1', epics: true, git: true, shared: false }],
      about,
      presses,
      moduleName: (id) => id,
      activityNames: { epic: () => null, part: () => null, kehikko: () => null },
      flashContainer: (module) => page.told.push(['flash', module]),
      inboxOpen,
      setInboxOpen,
      goToEntry: (one) => page.opened.push(one),
      setTrouble: () => {},
      onPlaceRef: { current: () => {} },
      inboxAskRef,
    })
    Object.assign(page, { inboxOpen, hook, inboxAskRef })
    return null
  }
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  await act(async () => root.render(<Page />))
  return { page, unmount: () => act(async () => root.unmount()) }
}

const chord = (more: Partial<KeyboardEventInit> = {}, target: EventTarget = window) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'N', altKey: true, shiftKey: true, bubbles: true, ...more }))
  })

describe.if(inChild)('useInboxWiring', () => {
  test('Next with the Inbox not on this kehikko opens the panel; not from a text field, not with Ctrl', async () => {
    const { page, unmount } = await mount({ placed: false })
    const field = document.createElement('input')
    document.body.append(field)
    await chord({}, field)
    await chord({ ctrlKey: true })
    expect(page.inboxOpen).toBe(false)
    await chord()
    expect(page.inboxOpen).toBe(true)
    expect(page.told.filter((one) => (one as unknown[])[0] === 'inbox' && ((one as unknown[])[2] as { kind: string }).kind === 'next')).toEqual([])
    await unmount()
  })

  test('Next with the Inbox here lights it, hands it the keyboard and tells it the next item, then the one after', async () => {
    const { page, unmount } = await mount({ placed: true })
    page.told.length = 0
    await chord()
    expect(page.inboxOpen).toBe(false)
    expect(page.told).toEqual([
      ['flash', INBOX],
      ['focus', INBOX],
      ['inbox', INBOX, { kind: 'next', rev: 1, next: { module: 'kehikot.agent', id: 'a' } }],
      /* The next item moved on, which is news to the Inbox modules here. */
      ['inbox', INBOX, { kind: 'changed', rev: 1 }],
    ])
    page.told.length = 0
    await chord()
    expect(page.told).toContainEqual(['inbox', INBOX, { kind: 'next', rev: 1, next: { module: 'kehikot.agent', id: 'b' } }])
    await unmount()
  })

  test('the item Next told may be opened by the Inbox page without a press, and no other', async () => {
    const { page, unmount } = await mount({ placed: true })
    const refused = await page.inboxAskRef.current(INBOX, 'inbox.open', { module: 'kehikot.agent', id: 'a' }, false)
    expect(refused).toMatchObject({ ok: true, data: { outcome: 'declined' } })
    expect(page.opened).toEqual([])
    await chord()
    const other = await page.inboxAskRef.current(INBOX, 'inbox.open', { module: 'kehikot.agent', id: 'b' }, false)
    expect(other).toMatchObject({ ok: true, data: { outcome: 'declined' } })
    const told = await page.inboxAskRef.current(INBOX, 'inbox.open', { module: 'kehikot.agent', id: 'a' }, false)
    expect(told).toMatchObject({ ok: true, data: { outcome: 'opened' } })
    expect(page.opened.map((one) => one.id)).toEqual(['a'])
    await unmount()
  })

  test('the bar’s count says what needs the person, and offers to add the Inbox where it is not', async () => {
    const away = await mount({ placed: false })
    expect(away.page.hook.inboxCount?.placedHere).toBe(false)
    expect(away.page.hook.inboxCount?.offer?.label).toBe('Add Inbox to this kehikko')
    expect(away.page.hook.inboxCount?.items.length).toBe(2)
    await away.unmount()
    const here = await mount({ placed: true })
    expect(here.page.hook.inboxCount?.placedHere).toBe(true)
    expect(here.page.hook.inboxCount?.offer).toBeNull()
    await here.unmount()
  })
})
