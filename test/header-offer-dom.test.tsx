import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * What a container's header offers, rendered: at 380, 280, 220, 200 and 160
 * pixels, open, folded to one row and folded to two, every action the module
 * declared and every one of the host's is reachable — in the row or behind a
 * trigger — and none of them is drawn twice (`src/host/headerOffer.ts`). The
 * checkbox, the module's icon, the overflow, the fold button and the name are
 * in the row at every one of them (`ROW_PRIORITY`), and there is no scope chip.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix
 * decides at load whether it has a DOM.
 */

const inChild = process.env.HEADER_OFFER_DOM === '1'
const TESTS = 10

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
let Scope: typeof import('../src/host/scope.ts')
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
  Scope = await import('../src/host/scope.ts')
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
    help: { summary: 'How it works.', sections: [{ title: 'Use', points: ['Press things.'] }] },
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

const scope = () => Scope.scopeOfContainer({ modes: [{ id: 'paper', scope: 'epic', scopeSays: 'the open epic’s paper' }, { id: 'all', scope: 'project', scopeSays: 'every paper' }] }, null)

const footer = () =>
  Protocol.footerItemsSchema.parse([
    { kind: 'text', id: 'status', text: 'Synced' },
    { kind: 'run', id: 'retry', label: 'Retry', align: 'end', actsOn: 'status' },
  ])

type Fold = 'open' | 'one row' | 'two rows'

/** The module's own row controls, when a test offers them. */
interface Controls {
  filters?: import('kehikot-module-protocol').FilterGroup[]
  clear?: string | null
  refresh?: { can: boolean; at: string | null; busy: boolean }
  onClear?(): void
  onRemove?(): void
}

const CONTROLS = (): Controls => ({
  filters: [{ id: 'state', label: 'State', options: [{ id: 'open', label: 'Open' }, { id: 'all', label: 'All' }], fallback: 'open' }],
  clear: 'forget 3 shown',
  refresh: { can: true, at: null, busy: false },
})

async function header(width: number, fold: Fold, declared: () => ReturnType<typeof items> = items, controls: Controls = {}) {
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
          header={declared()}
          filters={controls.filters ?? []}
          chosen={{}}
          onChoose={nothing}
          onEverything={nothing}
          clear={controls.clear ?? null}
          onClear={controls.onClear ?? nothing}
          refresh={controls.refresh}
          refreshEvery={null}
          onRefresh={nothing}
          onRefreshEvery={nothing}
          selected={false}
          onSelect={nothing}
          onPrompts={nothing}
          onTools={nothing}
          onSkills={nothing}
          onHelp={nothing}
          onSettings={nothing}
          showRows={null}
          barRows="always"
          onShowRows={nothing}
          onStarted={nothing}
          onRemove={controls.onRemove ?? nothing}
          kehikko="thesis"
          epic={null}
          scope={scope()}
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
  if (head.querySelector('[data-remove-button]')) note('frame:remove', 'row')
  for (const control of head.querySelectorAll('button[data-control]')) note(`control:${control.getAttribute('data-control')}`, 'row')
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
    for (const row of content.querySelectorAll('[data-control]')) note(`control:${row.getAttribute('data-control')}`, which)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  }
  return found
}

const EVERYTHING = [
  'frame:feedback',
  'frame:help',
  'frame:prompts',
  'frame:remove',
  'frame:rows',
  'frame:scope',
  'frame:settings',
  'frame:skills',
  'frame:tools',
  'item:clean',
  'item:compile',
  'item:pane',
  'item:section',
  'item:wrap',
]

const WIDTHS = [380, 280, 220, 200, 160] as const

describe('the same header at every width and fold', () => {
  if (!inChild) return

  test('everything is reachable at 380, 280, 220, 200 and 160 pixels, open, one row and two rows', async () => {
    for (const width of WIDTHS) {
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
    for (const width of WIDTHS) {
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

  test('under 220 one "⋯" holds the module’s menus and then Container, in the order the separate menus have', async () => {
    await header(380, 'open')
    const wide = [...document.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))
    expect(wide).toEqual(['view', 'go', 'run', 'frame'])
    act(() => unmount?.())
    document.body.innerHTML = ''
    for (const [width, fold] of [[200, 'open'], [200, 'one row'], [160, 'open'], [160, 'two rows']] as const) {
      await header(width, fold)
      expect([...document.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))).toEqual(['more'])
      const trigger = document.querySelector<HTMLElement>('header [data-menu="more"]')!
      /* The Container trigger's dot for tools nobody connected comes with its rows. */
      expect(trigger.getAttribute('data-tools')).toBe('loud')
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      })
      const content = document.querySelector<HTMLElement>('[data-menu-content="more"]')!
      const sections = [...content.querySelectorAll(':scope > [data-section]')]
      expect(sections.map((one) => one.getAttribute('data-section'))).toEqual(['view', 'go', 'run', 'frame'])
      expect(sections.map((one) => one.querySelector('[data-slot="dropdown-menu-label"]')!.textContent)).toEqual(['View', 'Go', 'Run', 'Container'])
      expect([...sections.at(-1)!.querySelectorAll('[data-frame]')].map((el) => el.getAttribute('data-frame'))).toEqual(['scope', 'settings', 'tools', 'skills', 'rows', 'help', 'feedback', 'prompts', 'remove'])
      /* A disabled run keeps its reason in the overflow. */
      expect(content.querySelector('[data-item="clean"]')!.textContent).toContain('Nothing to clean.')
      act(() => unmount?.())
      unmount = null
      document.body.innerHTML = ''
    }
  })

  test('the row keeps the checkbox, the icon, the overflow, the fold button and the name at every width, open and folded; no scope chip', async () => {
    for (const width of WIDTHS) {
      for (const fold of ['open', 'one row', 'two rows'] as const) {
        await header(width, fold)
        const head = document.querySelector('header')!
        const at = `${width} ${fold}`
        expect(head.querySelector('[role="checkbox"]'), at).not.toBeNull()
        expect(head.querySelector('[data-module-icon]'), at).not.toBeNull()
        expect(head.querySelector('[data-tour="fold"]'), at).not.toBeNull()
        expect(head.querySelector('[data-testid="header-name"]')?.className, at).toMatch(/truncate/)
        const triggers = [...head.querySelectorAll('[data-menu]')].map((el) => el.getAttribute('data-menu'))
        expect(triggers.at(-1), at).toBe(width < 220 ? 'more' : 'frame')
        if (width < 220) expect(triggers, at).toEqual(['more'])
        expect(head.querySelector('[data-testid="header-scope"]'), at).toBeNull()
        /* Left to right: checkbox, icon, name … overflow, fold. */
        const order = [...head.querySelectorAll('[role="checkbox"], [data-module-icon], [data-testid="header-name"], [data-menu], [data-tour="fold"]')]
        const index = (el: Element | null) => order.indexOf(el!)
        expect(index(head.querySelector('[role="checkbox"]')) < index(head.querySelector('[data-module-icon]')), at).toBe(true)
        expect(index(head.querySelector('[data-module-icon]')) < index(head.querySelector('[data-testid="header-name"]')), at).toBe(true)
        expect(index(head.querySelector(`[data-menu="${triggers.at(-1)}"]`)) < index(head.querySelector('[data-tour="fold"]')), at).toBe(true)
        act(() => unmount?.())
        unmount = null
        document.body.innerHTML = ''
      }
    }
  })

  test('a module with no menus: under 220 its Container rows are a section of a "⋯", not a trigger of their own', async () => {
    const none = () => Protocol.headerItemsSchema.parse([])
    await header(380, 'open', none)
    const wide = document.querySelector<HTMLElement>('header [data-menu="frame"]')!
    expect(wide.getAttribute('aria-label')).toBe('container menu of Paper — tools not connected')
    expect([...document.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))).toEqual(['frame'])
    act(() => unmount?.())
    document.body.innerHTML = ''
    for (const width of [200, 160]) {
      for (const fold of ['open', 'one row'] as const) {
        await header(width, fold, none)
        expect([...document.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))).toEqual(['more'])
        const trigger = document.querySelector<HTMLElement>('header [data-menu="more"]')!
        expect(trigger.getAttribute('aria-label')).toBe('menus of Paper — tools not connected')
        await act(async () => {
          trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
          document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
        })
        const content = document.querySelector<HTMLElement>('[data-menu-content="more"]')!
        const section = content.querySelector('[data-section="frame"]')!
        expect(section.querySelector('[data-slot="dropdown-menu-label"]')!.textContent).toBe('Container')
        expect([...section.querySelectorAll('[data-frame]')].map((el) => el.getAttribute('data-frame'))).toEqual(['scope', 'settings', 'tools', 'skills', 'rows', 'help', 'feedback', 'prompts', 'remove'])
        act(() => unmount?.())
        unmount = null
        document.body.innerHTML = ''
      }
    }
  })

  test('the Container trigger’s tooltip says what it holds', async () => {
    await header(380, 'open')
    const trigger = document.querySelector<HTMLElement>('header [data-menu="frame"]')!
    expect(trigger.getAttribute('aria-label')).toBe('container menu of Paper — tools not connected')
    /* Without a pointer the tooltip is not mounted; the words are the one rule's (`frameHint`). */
    const { frameHint } = await import('../src/host/headerOffer.ts')
    expect(frameHint(['scope', 'tools', 'skills', 'rows', 'help', 'feedback', 'prompts'])).toBe('This container: scope, tools, skills, header and footer, how to use it, feedback, prompts')
  })

  test('filter, clear, refresh and remove: buttons in the row at 220 and wider, and every one reachable once at every width', async () => {
    const all = [...EVERYTHING, 'control:clear', 'control:filter', 'control:refresh'].sort()
    for (const width of WIDTHS) {
      for (const fold of ['open', 'one row'] as const) {
        await header(width, fold, items, CONTROLS())
        const found = await offered()
        expect([...found.keys()].sort(), `${width} ${fold}`).toEqual(all)
        for (const [key, places] of found) expect(places, `${key} at ${width} ${fold}`).toHaveLength(1)
        for (const key of ['control:filter', 'control:clear', 'control:refresh', 'frame:remove']) expect(found.get(key), `${key} ${width}`).toEqual([width < 220 ? 'more' : 'row'])
        act(() => unmount?.())
        unmount = null
        document.body.innerHTML = ''
      }
    }
  })

  test('at 160 and 200 a module with filter, clear and refresh pushes nothing past the edge: the row is the five, the rest is in "⋯"', async () => {
    for (const declared of [items, () => Protocol.headerItemsSchema.parse([])]) {
      for (const width of [200, 160]) {
        for (const fold of ['open', 'one row', 'two rows'] as const) {
          await header(width, fold, declared, CONTROLS())
          const head = document.querySelector('header')!
          const at = `${width} ${fold} ${declared === items ? 'menus' : 'no menus'}`
          /* No control of the module's, no gear, no ×, no pinned run in the row. */
          expect(head.querySelectorAll('button[data-control], [data-remove-button], [data-settings-button], [data-pinned-run]'), at).toHaveLength(0)
          /* Outside the box that clips its own tail (name, version, branch), the row has only the checkbox, the "⋯" and the fold. */
          const left = head.querySelector<HTMLElement>('[data-header-left]')!
          expect(left.className, at).toMatch(/min-w-0/)
          expect(left.className, at).toMatch(/overflow-hidden/)
          expect(left.contains(head.querySelector('[data-testid="header-name"]')), at).toBe(true)
          const outside = [...head.querySelectorAll('button')].filter((el) => !left.contains(el))
          expect(outside.map((el) => el.getAttribute('role') === 'checkbox' ? 'select' : el.hasAttribute('data-menu') ? el.getAttribute('data-menu') : el.getAttribute('data-tour')), at).toEqual(['select', 'more', 'fold'])
          expect(head.querySelector('[data-module-icon]'), at).not.toBeNull()
          /* The "⋯": the module's menus, then "Shown" with filter, clear and refresh, then Container ending in remove. */
          const trigger = head.querySelector<HTMLElement>('[data-menu="more"]')!
          await act(async () => {
            trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
            document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
          })
          const content = document.querySelector<HTMLElement>('[data-menu-content="more"]')!
          const sections = [...content.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section')).filter((one) => one !== null)
          expect(sections.slice(-2), at).toEqual(['controls', 'frame'])
          const shown = content.querySelector('[data-section="controls"]')!
          expect(shown.querySelector('[data-slot="dropdown-menu-label"]')!.textContent).toBe('Shown')
          expect([...shown.querySelectorAll('[data-control]')].map((el) => el.getAttribute('data-control'))).toEqual(['filter', 'clear', 'refresh'])
          expect(content.querySelector('[data-frame="remove"]')!.textContent).toContain('Remove from this kehikko')
          act(() => unmount?.())
          unmount = null
          document.body.innerHTML = ''
        }
      }
    }
  })

  test('in "⋯", clear and remove each take two presses, and the first leaves the menu open', async () => {
    let cleared = 0
    let removed = 0
    await header(160, 'open', items, { ...CONTROLS(), onClear: () => cleared++, onRemove: () => removed++ })
    const open = async () => {
      const trigger = document.querySelector<HTMLElement>('header [data-menu="more"]')!
      await act(async () => {
        trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
        document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      })
    }
    const press = async (selector: string) => {
      const row = document.querySelector<HTMLElement>(selector)!
      await act(async () => {
        row.click()
      })
    }
    for (const [selector, count, armed] of [
      ['[data-menu-content="more"] [data-control="clear"]', () => cleared, 'Press again to forget 3 shown'],
      ['[data-menu-content="more"] [data-frame="remove"]', () => removed, 'Press again to remove'],
    ] as const) {
      await open()
      await press(selector)
      expect(count()).toBe(0)
      /* Still open, and armed. */
      const row = document.querySelector<HTMLElement>(selector)!
      expect(row.getAttribute('data-armed')).toBe('true')
      expect(row.textContent).toContain(armed)
      await press(selector)
      expect(count()).toBe(1)
    }
  })

  /*
   * View and Run drawn on top of one another in a folded header: the dense rule
   * that fits a folded header into one grid row squared every button to
   * eighteen pixels, so a word trigger ("View", "Run") kept its text and lost
   * its width, and its letters spilled over the next trigger. Layout cannot be
   * measured here, so this holds what keeps the row one flow: every control is
   * an item of the header's own flex row (through flex rows or boxes with no box of their own, nothing
   * positioned, no negative margin), and no control that shows words is given a
   * width by a rule from `index.css`.
   */
  test('folded or open, every control is one flow in the header row, and nothing that shows words is squared by the dense rule', async () => {
    const css = (await Bun.file(new URL('../src/index.css', import.meta.url)).text()).replace(/\/\*[\s\S]*?\*\//g, '')
    const sizing = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, , body]) => /(^|[\s;])inline-size\s*:/.test(body!))
      .flatMap(([, selectors]) => selectors!.split(',').map((one) => one.trim()))
      .filter((one) => one.startsWith('.container-grip'))
    expect(sizing.length).toBeGreaterThan(0)
    const words = (el: Element): boolean =>
      [...el.childNodes].some((node): boolean => (node.nodeType === 3 ? (node.textContent ?? '').trim() !== '' : node instanceof HTMLElement && node.getAttribute('aria-hidden') !== 'true' && !node.classList.contains('sr-only') && words(node)))
    const CONTROLS_IN_ROW = '[data-menu], [data-pinned-run], [data-control], [data-settings-button], [data-remove-button], [data-tour="fold"]'
    for (const width of [380, 280, 220, 200] as const) {
      for (const fold of ['one row', 'two rows', 'open'] as const) {
        await header(width, fold, items, CONTROLS())
        const head = document.querySelector<HTMLElement>('header.container-grip')!
        const at = `${width} ${fold}`
        expect(head.className, at).toMatch(/(^|\s)flex(\s|$)/)
        const controls = [...head.querySelectorAll<HTMLElement>(CONTROLS_IN_ROW)]
        expect(controls.length, at).toBeGreaterThan(1)
        if (width >= 300) expect(controls.filter((el) => el.hasAttribute('data-menu') && words(el)).map((el) => el.textContent), at).toEqual(['View', 'Go', 'Run'])
        for (const control of controls) {
          const which = `${control.getAttribute('data-menu') ?? control.getAttribute('data-pinned-run') ?? control.getAttribute('data-control') ?? control.getAttribute('data-tour') ?? 'remove'} at ${at}`
          /* Up to the header: flex rows only, nothing taken out of the flow. */
          for (let el: HTMLElement | null = control; el && el !== head; el = el.parentElement) {
            expect(el.className, which).not.toMatch(/(^|\s)(absolute|fixed|sticky|float-\w+)(\s|$)/)
            expect(el.style.position, which).toBe('')
            /* The × keeps its lift over the corner's resize handle, and it is the last thing in the row. */
            if (!el.hasAttribute('data-remove-button')) expect(el.className, which).not.toMatch(/(^|\s)-m[trblxyse]?-/)
            /* `contents` draws no box: what is in it is laid out by the row it is in. */
            if (el !== control && !/(^|\s)contents(\s|$)/.test(el.className)) {
              expect(el.className, which).toMatch(/(^|\s)flex(\s|$)/)
              expect(el.className, which).not.toMatch(/(^|\s)(flex-col|flex-wrap|grid)(\s|$)/)
            }
          }
          if (control.hasAttribute('data-remove-button')) expect(control.nextElementSibling, which).toBeNull()
          /* A control that shows words and is not square by its own classes keeps its width when folded. */
          if (words(control) && !/(^|\s)size-\d/.test(control.className)) {
            for (const selector of sizing) expect(control.matches(selector), `${which}: ${selector}`).toBe(false)
          }
        }
        act(() => unmount?.())
        unmount = null
        document.body.innerHTML = ''
      }
    }
  })
})
