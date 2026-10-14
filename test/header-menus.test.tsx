import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { headerItemsSchema, type HeaderItem } from 'kehikot-module-protocol'

import type { Pressed, Pressing } from '../src/host/header.ts'

/*
 * A container's menus, rendered and pressed: each kind of item drawn as its
 * shadcn part, the confirmed run armed by the host, a press sent and the
 * module's re-declaration shown in the menu that is open, and the three
 * widths.
 *
 * In a process of its own, for the reason `updates-panel.test.tsx` gives:
 * Radix decides at load whether it has a DOM, and another file in the shared
 * run has already loaded it without one.
 */

const inChild = process.env.HEADER_MENUS_DOM === '1'
const TESTS = 32

if (!inChild) {
  test('the header menus, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, HEADER_MENUS_DOM: '1' },
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
let Menus: typeof import('../src/canvas/HeaderMenus.tsx')
let Box: typeof import('../src/canvas/Container.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Menus = await import('../src/canvas/HeaderMenus.tsx')
  Box = await import('../src/canvas/Container.tsx')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
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
})

const sections = Array.from({ length: 12 }, (_, n) => ({ id: `s${n}`, label: `Section ${n}` }))
const paper = (over: { pane?: string; wrap?: boolean; compile?: Record<string, unknown>; commit?: string } = {}): HeaderItem[] =>
  headerItemsSchema.parse([
    { kind: 'switch', id: 'pane', label: 'Pane', icon: 'columns-2', value: over.pane ?? 'source', options: [{ id: 'source', label: 'Source' }, { id: 'pdf', label: 'PDF' }] },
    { kind: 'toggle', id: 'wrap', label: 'Wrap long lines', shortcut: '⌥Z', checked: over.wrap ?? false, group: 'Editor' },
    { kind: 'go', id: 'section', label: 'Sections', options: sections },
    { kind: 'run', id: 'compile', label: 'Compile', icon: 'play', shortcut: '⌘B', result: '1.2 s · p. 3/12', ...(over.compile ?? {}) },
    { kind: 'run', id: 'commit', label: over.commit ?? 'Commit', icon: 'no-such-icon', confirm: true },
    { kind: 'run', id: 'export', label: 'Export PDF', disabled: 'Compile the paper first.' },
  ])

type Mode = import('../src/canvas/HeaderMenus.tsx').MenuMode

/** The menus on a page, with a module behind them that answers as told and can declare again. */
async function mount(
  first: HeaderItem[],
  more: {
    mode?: Mode
    answer?: (press: Pressing) => Pressed | Promise<Pressed>
    surface?: import('../src/canvas/HeaderMenus.tsx').Surface
    order?: string[]
  } = {},
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const presses: Pressing[] = []
  const handed = { n: 0 }
  const onPress = async (press: Pressing): Promise<Pressed> => {
    presses.push(press)
    more.order?.push('press')
    return more.answer ? more.answer(press) : { ok: true, why: '' }
  }
  const draw = (items: HeaderItem[], note: import('../src/canvas/HeaderMenus.tsx').PressNote | null = null) =>
    act(async () => {
      root.render(
        <TooltipProvider>
          <Menus.HeaderMenus items={items} name="Paper" onPress={onPress} onKeyboard={() => { handed.n += 1 }} surface={more.surface} mode={more.mode ?? 'words'} note={note} />
        </TooltipProvider>,
      )
    })
  await draw(first)
  unmount = () => root.unmount()
  return { host, presses, handed, declare: draw }
}

const trigger = (menu: string) => document.querySelector<HTMLElement>(`[data-menu="${menu}"]`)
const content = (menu: string) => document.querySelector<HTMLElement>(`[data-menu-content="${menu}"]`)
const row = (item: string, option?: string) =>
  document.querySelector<HTMLElement>(option ? `[data-item="${item}"][data-option="${option}"]` : `[data-item="${item}"]`)
const said = () => document.querySelector('[data-testid="header-said"]')?.textContent ?? ''

async function open(menu: string) {
  await act(async () => {
    trigger(menu)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    /* And let go: the tooltip holds off for as long as it believes the pointer is down. */
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
  })
  expect(content(menu), `the ${menu} menu did not open`).not.toBeNull()
}

async function choose(element: HTMLElement | null) {
  expect(element).not.toBeNull()
  await act(async () => element!.click())
  /* The press is answered a tick later. */
  await act(async () => {})
}

describe('the kind decides the menu, and nothing is drawn for nothing', () => {
  if (!inChild) return

  test('View, Go and Run, in that order, each a trigger', async () => {
    const { host } = await mount(paper())
    expect([...host.querySelectorAll('[data-menu]')].map((el) => el.getAttribute('data-menu'))).toEqual(['view', 'go', 'run'])
    expect([...host.querySelectorAll('[data-menu]')].map((el) => el.textContent)).toEqual(['View', 'Go', 'Run'])
  })

  test('an empty menu is not drawn, and a module that declares nothing has no menus at all', async () => {
    const some = await mount(paper().filter((item) => item.kind !== 'go'))
    expect([...some.host.querySelectorAll('[data-menu]')].map((el) => el.getAttribute('data-menu'))).toEqual(['view', 'run'])
    await some.declare([])
    expect(some.host.innerHTML).toBe('')
  })
})

describe('each kind is drawn as its part', () => {
  if (!inChild) return

  test('a switch is a radio group with the option it is on, and a toggle is a checkbox item', async () => {
    await mount(paper())
    await open('view')
    expect(row('pane', 'source')!.getAttribute('role')).toBe('menuitemradio')
    expect(row('pane', 'source')!.getAttribute('aria-checked')).toBe('true')
    expect(row('pane', 'pdf')!.getAttribute('aria-checked')).toBe('false')
    expect(row('wrap')!.getAttribute('role')).toBe('menuitemcheckbox')
    expect(row('wrap')!.getAttribute('aria-checked')).toBe('false')
    /* The item's label heads its options, its group heads the toggle, and the shortcut is in its slot. */
    expect(content('view')!.querySelector('[data-item-label="pane"]')!.textContent).toBe('Pane')
    expect(content('view')!.querySelector('[data-group="Editor"]')!.textContent).toContain('Editor')
    expect(row('wrap')!.querySelector('[data-slot="dropdown-menu-shortcut"]')!.textContent).toBe('⌥Z')
    /* No run and no jump in View. */
    expect(content('view')!.querySelector('[data-item="compile"], [data-item="section"]')).toBeNull()
  })

  test('a go item is a list of plain items, drawn in the menu when it is alone there', async () => {
    await mount(paper())
    await open('go')
    const places = [...content('go')!.querySelectorAll('[data-item="section"]')]
    expect(places).toHaveLength(12)
    expect(places.every((place) => place.getAttribute('role') === 'menuitem')).toBe(true)
    expect(places[3]!.textContent).toBe('Section 3')
  })

  test('a run says its result and its shortcut; a disabled one is flat and says why', async () => {
    await mount(paper())
    await open('run')
    expect(row('compile')!.getAttribute('role')).toBe('menuitem')
    expect(row('compile')!.querySelector('[data-result]')!.textContent).toBe('1.2 s · p. 3/12')
    expect(row('compile')!.querySelector('[data-slot="dropdown-menu-shortcut"]')!.textContent).toBe('⌘B')
    expect(row('export')!.getAttribute('aria-disabled')).toBe('true')
    expect(row('export')!.getAttribute('title')).toBe('Compile the paper first.')
    expect(row('export')!.querySelector('[data-reason]')!.textContent).toBe('Compile the paper first.')
  })

  test('busy and failed show in the row and on the trigger, and a busy run cannot be pressed again', async () => {
    const page = await mount(paper({ compile: { state: 'busy' } }))
    expect(trigger('run')!.getAttribute('data-run')).toBe('busy')
    expect(trigger('view')!.getAttribute('data-run')).toBeNull()
    await open('run')
    expect(row('compile')!.getAttribute('aria-disabled')).toBe('true')
    expect(row('compile')!.querySelector('[aria-label="running"]')).not.toBeNull()
    await choose(row('compile'))
    expect(page.presses).toEqual([])
    /* Declared again as failed, in the menu that is open. */
    await page.declare(paper({ compile: { state: 'failed', result: '2 errors' } }))
    expect(content('run')).not.toBeNull()
    expect(trigger('run')!.getAttribute('data-run')).toBe('failed')
    expect(row('compile')!.querySelector('[aria-label="failed"]')).not.toBeNull()
    expect(row('compile')!.querySelector('[data-result]')!.textContent).toBe('2 errors')
    expect(row('compile')!.getAttribute('aria-disabled')).toBeNull()
  })

  test('an icon is a name looked up in a fixed table, and an unknown name draws none', async () => {
    await mount(paper())
    expect(Menus.HEADER_ICONS.has('play')).toBe(true)
    expect(Menus.HEADER_ICONS.has('constructor')).toBe(false)
    await open('run')
    expect(row('compile')!.querySelector('svg[data-icon="play"]')).not.toBeNull()
    expect(row('commit')!.querySelector('svg')).toBeNull()
  })

  test('a module’s words are text: markup in a label is letters, not elements', async () => {
    const hostile = headerItemsSchema.parse([
      { kind: 'run', id: 'x', label: '<img src=x onerror=alert(1)>', result: '<b>bold</b>', disabled: '<a href="http://evil.example">click</a>' },
      { kind: 'toggle', id: 'y', label: '<script>1</script>', checked: false, group: '<i>g</i>' },
    ])
    await mount(hostile)
    await open('run')
    expect(content('run')!.querySelector('img, b, a, script, i')).toBeNull()
    expect(row('x')!.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(row('x')!.querySelector('[data-reason]')!.textContent).toBe('<a href="http://evil.example">click</a>')
  })
})

describe('a press, the module’s answer, and its header declared again', () => {
  if (!inChild) return

  test('a toggle sends the state wanted, the menu stays open, and the tick moves when the module declares it', async () => {
    const page = await mount(paper())
    await open('view')
    await choose(row('wrap'))
    expect(page.presses).toEqual([{ item: 'wrap', value: true }])
    /* The host holds no state: until the module declares, nothing has changed. */
    expect(row('wrap')!.getAttribute('aria-checked')).toBe('false')
    await page.declare(paper({ wrap: true }))
    expect(content('view')).not.toBeNull()
    expect(row('wrap')!.getAttribute('aria-checked')).toBe('true')
    await choose(row('wrap'))
    expect(page.presses[1]).toEqual({ item: 'wrap', value: false })
  })

  test('a switch sends the option, stays open, and the radio moves on the re-declaration', async () => {
    const page = await mount(paper())
    await open('view')
    await choose(row('pane', 'pdf'))
    expect(page.presses).toEqual([{ item: 'pane', value: 'pdf' }])
    await page.declare(paper({ pane: 'pdf' }))
    expect(content('view')).not.toBeNull()
    expect(row('pane', 'pdf')!.getAttribute('aria-checked')).toBe('true')
    expect(row('pane', 'source')!.getAttribute('aria-checked')).toBe('false')
  })

  test('a jump and a run send their press and close the menu', async () => {
    const page = await mount(paper())
    await open('go')
    await choose(row('section', 's4'))
    expect(content('go')).toBeNull()
    await open('run')
    await choose(row('compile'))
    expect(content('run')).toBeNull()
    expect(page.presses).toEqual([{ item: 'section', value: 's4' }, { item: 'compile' }])
  })

  test('a press the module does not take says why on the row and for a screen reader, and sends nothing twice', async () => {
    const page = await mount(paper(), { answer: () => ({ ok: false, why: 'This paper is read-only.' }) })
    await open('view')
    await choose(row('wrap'))
    expect(said()).toBe('This paper is read-only.')
    expect(content('view')!.querySelector('[data-why="wrap"]')!.textContent).toBe('This paper is read-only.')
    expect(page.presses).toHaveLength(1)
  })

  test('an agent’s press is said where a refusal is said', async () => {
    const page = await mount(paper())
    expect(said()).toBe('')
    await page.declare(paper(), { n: 1, item: 'compile', text: 'an agent pressed Compile' })
    expect(said()).toBe('an agent pressed Compile')
  })
})

describe('a toggle shows its box, and a switch takes a press on the option it is on', () => {
  if (!inChild) return

  const box = (item: string) => row(item)!.querySelector('[data-slot="dropdown-menu-checkbox-box"]')

  test('an unchecked toggle draws an empty box, and the tick goes in it when the module declares it on', async () => {
    const page = await mount(paper())
    await open('view')
    expect(box('wrap')).not.toBeNull()
    expect(box('wrap')!.className).toContain('border')
    expect(box('wrap')!.querySelector('svg')).toBeNull()
    await page.declare(paper({ wrap: true }))
    expect(box('wrap')!.querySelector('svg')).not.toBeNull()
    /* A radio row has no box: its dot is what says which one is on. */
    expect(row('pane', 'pdf')!.querySelector('[data-slot="dropdown-menu-checkbox-box"]')).toBeNull()
  })

  test('a press on the option a switch is already on is sent like any other', async () => {
    const page = await mount(paper())
    await open('view')
    expect(row('pane', 'source')!.getAttribute('aria-checked')).toBe('true')
    await choose(row('pane', 'source'))
    expect(page.presses).toEqual([{ item: 'pane', value: 'source' }])
    expect(content('view')).not.toBeNull()
    /* And again, once the first has been answered: it is a press, not a change. */
    await choose(row('pane', 'source'))
    expect(page.presses).toHaveLength(2)
  })

  test('…and in a sub-menu, where a long switch is drawn', async () => {
    const long = headerItemsSchema.parse([
      { kind: 'switch', id: 'file', label: 'File', value: 's2', options: sections },
      { kind: 'toggle', id: 'wrap', label: 'Wrap', checked: false },
    ])
    const page = await mount(long)
    await open('view')
    expect(row('file')!.getAttribute('data-nested')).toBe('true')
    await act(async () => {
      row('file')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await choose(row('file', 's2'))
    expect(page.presses).toEqual([{ item: 'file', value: 's2' }])
  })
})

describe('where the keyboard is after a menu closes, and the tooltip that does not come with it', () => {
  if (!inChild) return

  const escape = () =>
    act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
  /* Radix returns focus a task after the menu is gone. */
  const settled = () => act(async () => { await new Promise((done) => setTimeout(done, 20)) })
  const tip = () => document.querySelector('[role="tooltip"]')

  test('tabbing to a trigger says what it is', async () => {
    await mount(paper())
    await act(async () => trigger('view')!.focus())
    expect(tip()!.textContent).toBe('view: what Paper shows')
  })

  test('Escape leaves focus on the trigger, and no tooltip comes up over the module', async () => {
    const page = await mount(paper())
    await open('view')
    await escape()
    await settled()
    expect(content('view')).toBeNull()
    expect(document.activeElement).toBe(trigger('view'))
    expect(tip()).toBeNull()
    expect(page.handed.n).toBe(0)
    /* It was that one return, not the trigger: leaving and tabbing back says the label again. */
    await act(async () => trigger('view')!.blur())
    await act(async () => trigger('view')!.focus())
    expect(tip()).not.toBeNull()
  })

  test('a setting pressed and then Escape is still Escape: the trigger, quietly', async () => {
    const page = await mount(paper())
    await open('view')
    await choose(row('wrap'))
    await choose(row('pane', 'pdf'))
    await escape()
    await settled()
    expect(document.activeElement).toBe(trigger('view'))
    expect(tip()).toBeNull()
    expect(page.handed.n).toBe(0)
  })

  test('a run and a jump that were sent hand the keyboard to the module, and focus is not put on the trigger', async () => {
    const page = await mount(paper())
    await open('run')
    await choose(row('compile'))
    await settled()
    expect(content('run')).toBeNull()
    expect(page.handed.n).toBe(1)
    expect(document.activeElement).not.toBe(trigger('run'))
    expect(tip()).toBeNull()
    await open('go')
    await choose(row('section', 's4'))
    await settled()
    expect(page.handed.n).toBe(2)
    expect(document.activeElement).not.toBe(trigger('go'))
    /* A confirmed run: the arming press hands nothing over, the press that sends does. */
    await open('run')
    await choose(row('commit'))
    await settled()
    expect(page.handed.n).toBe(2)
    await choose(row('commit'))
    await settled()
    expect(page.handed.n).toBe(3)
  })

  test('a press that was not taken leaves focus on the trigger, where the reason is said', async () => {
    const page = await mount(paper(), { answer: () => ({ ok: false, why: 'Nothing to compile.' }) })
    await open('run')
    await choose(row('compile'))
    await settled()
    expect(page.handed.n).toBe(0)
    expect(document.activeElement).toBe(trigger('run'))
    expect(tip()!.textContent).toBe('Nothing to compile.')
  })
})

describe('a run that has to be confirmed is armed by the host', () => {
  if (!inChild) return

  test('the first press arms and sends nothing; the row says so; the second sends', async () => {
    const page = await mount(paper())
    await open('run')
    await choose(row('commit'))
    expect(page.presses).toEqual([])
    expect(content('run')).not.toBeNull()
    expect(row('commit')!.getAttribute('data-armed')).toBe('true')
    expect(row('commit')!.textContent).toContain('Press again to confirm.')
    await choose(row('commit'))
    expect(page.presses).toEqual([{ item: 'commit' }])
    expect(content('run')).toBeNull()
  })

  test('it comes down when the item is declared differently, and when the menu closes', async () => {
    const page = await mount(paper())
    await open('run')
    await choose(row('commit'))
    expect(row('commit')!.getAttribute('data-armed')).toBe('true')
    /* What somebody aimed at is not what the second press would hit. */
    await page.declare(paper({ commit: 'Commit 4 files' }))
    expect(row('commit')!.getAttribute('data-armed')).toBeNull()
    await choose(row('commit'))
    expect(row('commit')!.getAttribute('data-armed')).toBe('true')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(content('run')).toBeNull()
    await open('run')
    expect(row('commit')!.getAttribute('data-armed')).toBeNull()
    expect(page.presses).toEqual([])
  })
})

describe('narrow', () => {
  if (!inChild) return

  test('words above 300 pixels, icons under it, one menu under 220', () => {
    expect([null, 780, 380, 300, 299, 280, 220, 219, 200].map(Menus.modeFor)).toEqual([
      'words', 'words', 'words', 'words', 'icons', 'icons', 'icons', 'merged', 'merged',
    ])
  })

  test('as icons, a trigger has no words in it and still has its name', async () => {
    const { host } = await mount(paper({ compile: { state: 'busy' } }), { mode: 'icons' })
    const triggers = [...host.querySelectorAll<HTMLElement>('[data-menu]')]
    expect(triggers.map((el) => el.getAttribute('data-menu'))).toEqual(['view', 'go', 'run'])
    expect(triggers.every((el) => el.textContent === '' && el.querySelector('svg') !== null)).toBe(true)
    expect(triggers.map((el) => el.getAttribute('aria-label'))).toEqual(['view of Paper', 'go of Paper', 'run of Paper — running'])
  })

  test('merged, View, Go and Run are labelled sections of one menu, and a long list opens beside it', async () => {
    const page = await mount(paper({ compile: { state: 'failed' } }), { mode: 'merged' })
    expect([...page.host.querySelectorAll('[data-menu]')].map((el) => el.getAttribute('data-menu'))).toEqual(['more'])
    expect(trigger('more')!.getAttribute('data-run')).toBe('failed')
    await open('more')
    const parts = [...content('more')!.querySelectorAll(':scope > [data-section]')]
    expect(parts.map((part) => part.getAttribute('data-section'))).toEqual(['view', 'go', 'run'])
    expect(parts.map((part) => part.querySelector('[data-slot="dropdown-menu-label"]')!.textContent)).toEqual(['View', 'Go', 'Run'])
    /* Twelve sections are one row here, not twelve. */
    expect(content('more')!.querySelectorAll('[data-item="section"]')).toHaveLength(1)
    expect(row('section')!.getAttribute('data-nested')).toBe('true')
    await choose(row('wrap'))
    expect(page.presses).toEqual([{ item: 'wrap', value: true }])
  })
})

describe('in the container', () => {
  if (!inChild) return

  const presence = {
    id: 'kehikot.paper',
    at: 'http://127.0.0.1:7870',
    condition: 'ready',
    reached: true,
    name: 'Paper',
    line: '',
    agent: { kind: 'untold' },
  } as unknown as import('../src/host/registry.ts').Presence

  async function container(collapsed: boolean, header: HeaderItem[]) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const nothing = () => {}
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
            header={header}
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
          />
        </TooltipProvider>,
      )
    })
    unmount = () => root.unmount()
    return [...host.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))
  }

  test('the module’s menus stand before the host’s Frame, hide when folded, and a module that declares nothing has only Frame', async () => {
    expect(await container(false, paper())).toEqual(['view', 'go', 'run', 'frame'])
    act(() => unmount?.())
    expect(await container(true, paper())).toEqual(['frame'])
    act(() => unmount?.())
    expect(await container(false, [])).toEqual(['frame'])
    /* Tools nobody has been told about are said on the trigger, as the plug said them. */
    expect(trigger('frame')!.getAttribute('data-tools')).toBe('loud')
    expect(trigger('frame')!.getAttribute('aria-label')).toBe('frame menu of Paper — not connected')
    await open('frame')
    expect([...content('frame')!.querySelectorAll('[data-frame]')].map((el) => el.getAttribute('data-frame'))).toEqual(['tools', 'feedback', 'prompts'])
    expect(Menus.toolsSaying({ kind: 'told', as: 'paper' }, 'Paper')).toMatchObject({ state: 'connected', loud: false })
    expect(Menus.toolsSaying({ kind: 'none' }, 'Paper')).toBeNull()
  })
  test('folded, the remove button is lifted over the grid’s resize handle, which otherwise lies on its lower half', async () => {
    const remove = () => document.querySelector('button[aria-label="take Paper off the canvas"]')!
    await container(true, [])
    expect(remove().hasAttribute('data-over-handle')).toBe(true)
    expect(remove().className).toContain('data-[over-handle]:z-10')
    act(() => unmount?.())
    await container(false, [])
    expect(remove().hasAttribute('data-over-handle')).toBe(false)
  })
})

describe('a run that asks for full screen (protocol 1.4.0)', () => {
  if (!inChild) return

  const present = () =>
    headerItemsSchema.parse([{ kind: 'run', id: 'present', label: 'Present', surface: 'fullscreen' }, { kind: 'run', id: 'plain', label: 'Plain' }])

  test('the host asks for full screen in the click, before the press is sent', async () => {
    const order: string[] = []
    const surface = { enter: () => (order.push('enter'), Promise.resolve(true)), leave: () => void order.push('leave') }
    const { presses } = await mount(present(), { surface, order })
    await open('run')
    await choose(row('present'))
    expect(order).toEqual(['enter', 'press'])
    expect(presses).toEqual([{ item: 'present' }])
  })

  test('a run without a surface does not ask for it', async () => {
    const order: string[] = []
    const surface = { enter: () => (order.push('enter'), Promise.resolve(true)), leave: () => void order.push('leave') }
    await mount(present(), { surface, order })
    await open('run')
    await choose(row('plain'))
    expect(order).toEqual(['press'])
  })

  test('a refused press gives the screen back, and says why', async () => {
    const order: string[] = []
    const surface = { enter: () => (order.push('enter'), Promise.resolve(true)), leave: () => void order.push('leave') }
    await mount(present(), { surface, order, answer: () => ({ ok: false, why: 'Nothing to present.' }) })
    await open('run')
    await choose(row('present'))
    expect(order).toEqual(['enter', 'press', 'leave'])
    expect(said()).toBe('Nothing to present.')
  })

  test('a webview that refuses full screen costs only the full screen: the press is delivered', async () => {
    const surface = { enter: () => Promise.resolve(false), leave: () => {} }
    const { presses } = await mount(present(), { surface })
    await open('run')
    await choose(row('present'))
    expect(presses).toEqual([{ item: 'present' }])
  })
})
