import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityItem } from 'kehikot-module-protocol'

import { open as openDb } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'
import { addProject } from '../server/projects.ts'
import type { Entry } from '../src/host/inbox.ts'

/*
 * "Use inbox", rendered (`src/host/inboxUse.ts`):
 *
 *  - through `useInbox` against a real store over the real routes: a muted module's reports are
 *    kept and not shown — no item, no count, no Next, and `notify` (the chime and the toast) is
 *    never told; turning it back on shows what it says now, without sounding what happened meanwhile;
 *  - the Container menu's "Use inbox" row at every width and fold, its state, and the press;
 *  - the Inbox panel's "Stop showing <module> here" and "N modules muted" with Show again.
 *
 * In a process of its own, as `whats-new-dom.test.tsx` explains.
 */

const inChild = process.env.INBOX_USE_DOM === '1'
const TESTS = 5

if (!inChild) {
  test('"Use inbox", rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, INBOX_USE_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 120_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let useInbox: typeof import('../src/canvas/useInbox.ts').useInbox
let Box: typeof import('../src/canvas/Container.tsx')
let Panel: typeof import('../src/canvas/Inbox.tsx')
let Rules: typeof import('../src/host/inbox.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let WIDTH: PropertyDescriptor | undefined

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useInbox } = await import('../src/canvas/useInbox.ts'))
  Box = await import('../src/canvas/Container.tsx')
  Panel = await import('../src/canvas/Inbox.tsx')
  Rules = await import('../src/host/inbox.ts')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  WIDTH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
})

afterAll(async () => {
  if (!inChild) return
  if (WIDTH) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', WIDTH)
  await GlobalRegistrator.unregister()
})

const item = (id: string, state: ActivityItem['state'] = 'attention', since = 5): ActivityItem => ({ id, state, label: id, since })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const nothing = () => {}

type Hook = ReturnType<typeof useInbox>

describe.if(inChild)('a muted module, through the page’s Inbox', () => {
  let db: Database
  let folder: string
  let project: number
  let inbox: Inbox
  let hook: Hook | null
  let told: Entry[]
  let unmount: () => void
  const realFetch = globalThis.fetch

  beforeEach(() => {
    db = openDb(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-inbox-use-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    inbox = new Inbox(db)
    const desk = inboxDesk({ inbox, pathOf: (id) => (id === project ? folder : undefined), changed: () => undefined })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1:4180')
      const response = await desk.route(new Request(url, init), url)
      return response ?? new Response('{}', { status: 404 })
    }) as typeof fetch
    hook = null
    told = []
  })
  afterEach(() => {
    act(() => unmount())
    globalThis.fetch = realFetch
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  async function mount() {
    function Probe() {
      hook = useInbox({
        project,
        projects: [{ id: project, name: 'a project', path: folder }],
        alive: new Set(['kehikot.one', 'kehikot.two']),
        at: { epic: null, parts: [], kehikko: null },
        nameOf: (module) => module,
        notify: (entry) => told.push(entry),
      })
      return null
    }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    await act(async () => root.render(<Probe />))
    unmount = () => root.unmount()
    await act(async () => wait(20))
  }

  test('hidden at once, kept, never told; no count and no Next for it', async () => {
    inbox.report(project, 'kehikot.one', 'One', [item('a')])
    inbox.report(project, 'kehikot.two', 'Two', [item('b')])
    await mount()
    expect(hook!.live.map((e) => e.id).sort()).toEqual(['a', 'b'])
    await act(async () => {
      hook!.use('kehikot.one', false)
      await wait(20)
    })
    /* Its open item is gone from what is drawn at once, and the store says it is muted. */
    expect(inbox.muted()).toEqual(['kehikot.one'])
    expect([...hook!.muted]).toEqual(['kehikot.one'])
    expect(hook!.open.map((e) => e.id)).toEqual(['b'])
    expect(hook!.all.map((e) => e.id).sort()).toEqual(['a', 'b'])
    /* A new thing that needs the person, from the muted module: kept, not told, not counted. */
    await act(async () => {
      void hook!.receive('kehikot.one', [item('a'), item('c', 'done', 9)])
      await wait(30)
    })
    expect(inbox.open(project).filter((e) => e.module === 'kehikot.one').map((e) => e.id).sort()).toEqual(['a', 'c'])
    expect(told).toEqual([])
    expect(hook!.open.map((e) => e.id)).toEqual(['b'])
    expect(Rules.tally(hook!.open, { epic: null, kehikko: null }).needHere + Rules.tally(hook!.open, { epic: null, kehikko: null }).needElsewhere).toBe(1)
    expect(Rules.nextOf(hook!.open, null)?.id).toBe('b')
    expect(Rules.nextOf(hook!.open, Rules.rowKey(Rules.nextOf(hook!.open, null)!))?.module).not.toBe('kehikot.one')
    /* The other module is still told. */
    await act(async () => {
      void hook!.receive('kehikot.two', [item('b'), item('d', 'done', 9)])
      await wait(30)
    })
    expect(told.map((e) => e.id)).toEqual(['d'])
  })

  test('turned back on: what it says now is shown, and what happened meanwhile is not sounded', async () => {
    inbox.report(project, 'kehikot.one', 'One', [item('a')])
    inbox.use('kehikot.one', false)
    await mount()
    expect([...hook!.muted]).toEqual(['kehikot.one'])
    expect(hook!.open).toEqual([])
    await act(async () => {
      void hook!.receive('kehikot.one', [item('later', 'done', 9)])
      await wait(30)
    })
    await act(async () => {
      hook!.use('kehikot.one', true)
      await wait(20)
    })
    expect(inbox.muted()).toEqual([])
    expect(hook!.open.map((e) => e.id)).toEqual(['later'])
    expect(told).toEqual([])
  })
})

describe.if(inChild)('the Container menu’s "Use inbox" row', () => {
  let unmount: (() => void) | null = null
  afterEach(() => {
    act(() => unmount?.())
    unmount = null
    document.body.innerHTML = ''
  })

  const presence = {
    id: 'kehikot.one',
    at: 'http://127.0.0.1:7870',
    condition: 'ready',
    reached: true,
    name: 'One',
    line: '',
    agent: { kind: 'none' },
    module: { name: 'One', declares: { protocol: '>=2', uses: ['activity:report'], storage: false } },
  } as unknown as import('../src/host/registry.ts').Presence

  async function header(width: number, collapsed: boolean, on: boolean, onChange: (on: boolean) => void) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains('container-grip') ? width : 0
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <TooltipProvider>
          <Box.Container
            presence={presence}
            showing={{ kind: 'page' }}
            fault={null}
            body={nothing}
            grow={false}
            onGrow={nothing}
            pinned={false}
            onPin={nothing}
            collapsed={collapsed}
            onCollapse={nothing}
            header={[]}
            filters={[]}
            chosen={{}}
            onChoose={nothing}
            onEverything={nothing}
            clear={null}
            onClear={nothing}
            refresh={undefined}
            refreshEvery={null}
            onRefresh={nothing}
            onRefreshEvery={nothing}
            selected={false}
            onSelect={nothing}
            onPrompts={nothing}
            onTools={nothing}
            onStarted={nothing}
            onRemove={nothing}
            kehikko="thesis"
            epic={null}
            inboxUse={{ on, onChange }}
          />
        </TooltipProvider>,
      )
    })
    unmount = () => root.unmount()
  }

  async function openMenu(): Promise<HTMLElement> {
    const trigger = [...document.querySelectorAll<HTMLElement>('header [data-menu]')].at(-1)!
    const which = trigger.getAttribute('data-menu')!
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    })
    return document.querySelector<HTMLElement>(`[data-menu-content="${which}"]`)!
  }

  test('reachable at 380, 280, 220, 200 and 160 pixels, open and folded, saying its state', async () => {
    for (const width of [380, 280, 220, 200, 160]) {
      for (const collapsed of [false, true]) {
        for (const on of [true, false]) {
          await header(width, collapsed, on, nothing)
          const content = await openMenu()
          const row = content.querySelector<HTMLElement>('[data-frame="inbox"]')
          const at = `${width} ${collapsed ? 'folded' : 'open'} ${on ? 'on' : 'off'}`
          expect(row, at).not.toBeNull()
          expect(row!.textContent, at).toContain('Use inbox')
          expect(row!.getAttribute('role'), at).toBe('menuitemcheckbox')
          expect(row!.getAttribute('aria-checked'), at).toBe(on ? 'true' : 'false')
          if (!on) expect(row!.textContent, at).toContain('muted')
          act(() => unmount?.())
          unmount = null
          document.body.innerHTML = ''
        }
      }
    }
  })

  test('a press asks for the other state', async () => {
    const asked: boolean[] = []
    await header(380, false, true, (on) => asked.push(on))
    const content = await openMenu()
    await act(async () => {
      content.querySelector<HTMLElement>('[data-frame="inbox"]')!.click()
    })
    expect(asked).toEqual([false])
  })
})

describe.if(inChild)('the Inbox panel', () => {
  let unmount: (() => void) | null = null
  afterEach(() => {
    act(() => unmount?.())
    unmount = null
    document.body.innerHTML = ''
  })

  const entry = (module: string, id: string): Entry => ({
    module,
    name: module === 'kehikko' ? 'Kehikot' : 'One',
    id,
    state: 'attention',
    label: id,
    priority: 'normal',
    refs: [],
    entered: Date.now() - 60_000,
    opened: Date.now() - 60_000,
    closed: null,
    how: null,
    seen: null,
    dismissed: null,
    origin: 'activity',
  })

  test('“Stop showing” on a module’s row, not the host’s; “N modules muted” with Show again', async () => {
    const asked: [string, boolean][] = []
    const at = { epic: null, kehikko: null }
    const entries = [entry('kehikot.one', 'a'), entry('kehikko', 'place-ask:x')]
    const view: import('../src/canvas/Inbox.tsx').InboxView = {
      entries,
      earlierCount: 0,
      at,
      scope: 'everywhere',
      onScope: nothing,
      names: { epic: () => null, part: () => null, kehikko: () => null },
      tally: Rules.tally(entries, at),
      next: null,
      open: true,
      onOpenChange: nothing,
      onGo: nothing,
      onNext: nothing,
      onSee: nothing,
      onDismiss: nothing,
      onForget: nothing,
      onSeeAll: nothing,
      loadLog: async () => ({ rows: [], more: false, total: 0 }),
      rev: 1,
      shortcut: 'Alt+Shift+N',
      now: () => Date.now(),
      muted: [{ id: 'kehikot.two', name: 'Two' }, { id: 'kehikot.three', name: 'Three' }],
      onUse: (module, on) => asked.push([module, on]),
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<TooltipProvider><Panel.InboxPanel view={view} /></TooltipProvider>))
    unmount = () => root.unmount()

    const stops = [...document.querySelectorAll<HTMLElement>('[data-inbox-mute]')]
    expect(stops.map((one) => one.getAttribute('aria-label'))).toEqual(['Stop showing One here'])
    await act(async () => stops[0]!.click())
    expect(asked).toEqual([['kehikot.one', false]])

    const section = document.querySelector<HTMLElement>('[data-inbox-muted]')!
    expect(section.textContent).toContain('2 modules muted')
    await act(async () => section.querySelector<HTMLElement>('button')!.click())
    const again = document.querySelector<HTMLElement>('[data-inbox-muted-module="kehikot.two"] button')!
    expect(again.textContent).toBe('Show again')
    await act(async () => again.click())
    expect(asked.at(-1)).toEqual(['kehikot.two', true])
  })
})
