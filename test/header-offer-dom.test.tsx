import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * What a container's header offers, rendered: at 380, 280 and 200 pixels,
 * open, folded to one row and folded to two, every action the module declared
 * and every one of the host's is reachable — in the row or behind a trigger —
 * and none of them is drawn twice (`src/host/headerOffer.ts`).
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix
 * decides at load whether it has a DOM.
 */

const inChild = process.env.HEADER_OFFER_DOM === '1'
const TESTS = 3

if (!inChild) {
  test('what the header offers, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, HEADER_OFFER_DOM: '1' },
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
let Box: typeof import('../src/canvas/Container.tsx')
let Protocol: typeof import('kehikot-module-protocol')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let WIDTH: PropertyDescriptor | undefined

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  WIDTH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  Box = await import('../src/canvas/Container.tsx')
  Protocol = await import('kehikot-module-protocol')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})

afterAll(async () => {
  if (!inChild) return
  if (WIDTH) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', WIDTH)
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
})

const nothing = () => {}

const presence = {
  id: 'kehikot.paper',
  at: 'http://127.0.0.1:7870',
  condition: 'ready',
  reached: true,
  name: 'Paper',
  line: '',
  agent: { kind: 'untold' },
  module: {
    name: 'Paper',
    declares: { protocol: '>=2', uses: [], storage: false, skills: [{ name: 'paper-cite', summary: 'Cite.', version: '1' }] },
  },
} as unknown as import('../src/host/registry.ts').Presence

const items = () =>
  Protocol.headerItemsSchema.parse([
    { kind: 'switch', id: 'pane', label: 'Pane', options: [{ id: 'source', label: 'Source' }, { id: 'pdf', label: 'PDF' }], value: 'source' },
    { kind: 'toggle', id: 'wrap', label: 'Wrap', checked: false },
    { kind: 'go', id: 'section', label: 'Section', options: [{ id: 'intro', label: 'Intro' }, { id: 'end', label: 'End' }] },
    { kind: 'run', id: 'compile', label: 'Compile', pinned: true, icon: 'play' },
    { kind: 'run', id: 'clean', label: 'Clean', disabled: 'Nothing to clean.' },
  ])

const footer = () =>
  Protocol.footerItemsSchema.parse([
    { kind: 'text', id: 'status', text: 'Synced' },
    { kind: 'run', id: 'retry', label: 'Retry', align: 'end', actsOn: 'status' },
  ])

type Fold = 'open' | 'one row' | 'two rows'

async function header(width: number, fold: Fold) {
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
          collapsed={fold !== 'open'}
          foldRows={fold === 'two rows' ? 2 : 1}
          footer={footer()}
          onFold={nothing}
          onCollapse={nothing}
          header={items()}
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
          onSkills={nothing}
          onSettings={nothing}
          showRows={null}
          barRows="always"
          onShowRows={nothing}
          onStarted={nothing}
          onRemove={nothing}
          kehikko="thesis"
          epic={null}
        />
      </TooltipProvider>,
    )
  })
  unmount = () => root.unmount()
}

/** Every action the header offers, each with every place it was found: the row, or a trigger's menu. */
async function offered(): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>()
  const note = (key: string, place: string) => found.set(key, [...(found.get(key) ?? []), place])
  const head = document.querySelector('header')!
  for (const pin of head.querySelectorAll('[data-pinned-run]')) note(`item:${pin.getAttribute('data-pinned-run')}`, 'row')
  if (head.querySelector('[data-settings-button]')) note('frame:settings', 'row')
  for (const trigger of [...head.querySelectorAll<HTMLElement>('[data-menu]')]) {
    const which = trigger.getAttribute('data-menu')!
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    })
    const content = document.querySelector<HTMLElement>(`[data-menu-content="${which}"]`)!
    expect(content, which).not.toBeNull()
    const ids = new Set([...content.querySelectorAll('[data-item], [data-item-label]')].map((el) => el.getAttribute('data-item') ?? el.getAttribute('data-item-label')))
    for (const id of ids) note(`item:${id}`, which)
    for (const row of content.querySelectorAll('[data-frame]')) note(`frame:${row.getAttribute('data-frame')}`, which)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  }
  return found
}

const EVERYTHING = [
  'frame:feedback',
  'frame:prompts',
  'frame:rows',
  'frame:settings',
  'frame:skills',
  'frame:tools',
  'item:clean',
  'item:compile',
  'item:pane',
  'item:section',
  'item:wrap',
]

describe('the same header at every width and fold', () => {
  if (!inChild) return

  test('everything is reachable at 380, 280 and 200 pixels, open, one row and two rows', async () => {
    for (const width of [380, 280, 200]) {
      for (const fold of ['open', 'one row', 'two rows'] as const) {
        await header(width, fold)
        if (fold === 'two rows') expect(document.querySelector('[data-fold]')!.getAttribute('data-fold')).toBe('2')
        const found = await offered()
        expect([...found.keys()].sort(), `${width} ${fold}`).toEqual(EVERYTHING)
        act(() => unmount?.())
        unmount = null
        document.body.innerHTML = ''
      }
    }
  })

  test('nothing appears twice: one place per action, Settings included', async () => {
    for (const width of [380, 280, 200]) {
      for (const fold of ['open', 'one row', 'two rows'] as const) {
        await header(width, fold)
        const found = await offered()
        for (const [key, places] of found) expect(places, `${key} at ${width} ${fold}`).toHaveLength(1)
        act(() => unmount?.())
        unmount = null
        document.body.innerHTML = ''
      }
    }
  })

  test('under 220 one "⋯" holds the module’s menus and then Frame, in the order the separate menus have', async () => {
    await header(380, 'open')
    const wide = [...document.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))
    expect(wide).toEqual(['view', 'go', 'run', 'frame'])
    act(() => unmount?.())
    document.body.innerHTML = ''
    for (const fold of ['open', 'one row'] as const) {
      await header(200, fold)
      expect([...document.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))).toEqual(['more'])
      const trigger = document.querySelector<HTMLElement>('header [data-menu="more"]')!
      /* The Frame trigger's dot for tools nobody connected comes with its rows. */
      expect(trigger.getAttribute('data-tools')).toBe('loud')
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      })
      const content = document.querySelector<HTMLElement>('[data-menu-content="more"]')!
      const sections = [...content.querySelectorAll(':scope > [data-section]')]
      expect(sections.map((one) => one.getAttribute('data-section'))).toEqual(['view', 'go', 'run', 'frame'])
      expect(sections.map((one) => one.querySelector('[data-slot="dropdown-menu-label"]')!.textContent)).toEqual(['View', 'Go', 'Run', 'Frame'])
      expect([...sections.at(-1)!.querySelectorAll('[data-frame]')].map((el) => el.getAttribute('data-frame'))).toEqual(['settings', 'tools', 'skills', 'rows', 'feedback', 'prompts'])
      /* A disabled run keeps its reason in the overflow. */
      expect(content.querySelector('[data-item="clean"]')!.textContent).toContain('Nothing to clean.')
      act(() => unmount?.())
      unmount = null
      document.body.innerHTML = ''
    }
  })
})
