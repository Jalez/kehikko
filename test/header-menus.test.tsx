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
const TESTS = 46

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
    pinned?: boolean
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
          <Menus.HeaderMenus items={items} name="Paper" onPress={onPress} onKeyboard={() => { handed.n += 1 }} surface={more.surface} mode={more.mode ?? 'words'} pinned={more.pinned} note={note} />
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

  test('a result is separated from its label in the text, a failed run says its reason in its title, and a go label gives its state to the trigger', async () => {
    const { menusOf } = await import('../src/host/header.ts')
    await mount(paper({ compile: { state: 'failed', result: '2 errors' } }))
    await open('run')
    expect(row('compile')!.textContent).toContain('Compile — 2 errors')
    expect(row('compile')!.getAttribute('title')).toBe('2 errors')
    const items = headerItemsSchema.parse([
      { kind: 'go', id: 'sessions', label: 'Sessions · ◆ main · background', options: [{ id: 'a', label: 'A' }] },
      { kind: 'run', id: 'unit', label: 'Run unit', state: 'failed', result: '3 failed' },
    ])
    expect(Menus.where(menusOf(items))).toBe('◆ main · background')
    expect(Menus.failedWhy(menusOf(items))).toBe('Run unit — 3 failed')
    expect(Menus.where(menusOf(paper()))).toBe('')
  })

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

  async function container(collapsed: boolean, header: HeaderItem[], over: Partial<import('../src/host/registry.ts').Presence> = {}, onSkills?: () => void) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const nothing = () => {}
    await act(async () => {
      root.render(
        <TooltipProvider>
          <Box.Container
            presence={{ ...presence, ...over }}
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
            onSkills={onSkills}
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
  test('a module that offers skills has a Skills row beside Tools, in the Frame menu that stands on the header folded or not', async () => {
    const skills = [{ name: 'paper-cite', summary: 'Cite from the paper.', version: '1' }, { name: 'paper-build', summary: 'Build it.', version: '2' }]
    const module = { declares: { protocol: '>=2', uses: [], storage: false, skills } } as never
    let opened = 0
    for (const [collapsed, items, menus] of [
      [false, paper(), ['view', 'go', 'run', 'frame']],
      [true, paper(), ['frame']],
      [false, [], ['frame']],
    ] as const) {
      /* No mark of its own: the header gains nothing, at any width or folded. */
      expect(await container(collapsed, [...items], { module }, () => opened++)).toEqual([...menus])
      expect(document.querySelector('header [data-frame="skills"], header [aria-label*="skills" i]')).toBeNull()
      await open('frame')
      expect([...content('frame')!.querySelectorAll('[data-frame]')].map((el) => el.getAttribute('data-frame'))).toEqual(['tools', 'skills', 'feedback', 'prompts'])
      expect(content('frame')!.querySelector('[data-frame="skills"]')!.textContent).toContain('2 skills offered')
      act(() => unmount?.())
    }
    await container(false, [], { module }, () => opened++)
    await open('frame')
    await choose(content('frame')!.querySelector<HTMLElement>('[data-frame="skills"]')!)
    expect(opened).toBe(1)
    act(() => unmount?.())
    /* A module that offers none has no row. */
    await container(false, [], {}, () => opened++)
    await open('frame')
    expect(content('frame')!.querySelector('[data-frame="skills"]')).toBeNull()
  })
  test('the remove button is lifted over the handle in the top right corner, folded or not', async () => {
    const remove = () => document.querySelector('button[aria-label="take Paper off the canvas"]')!
    for (const folded of [true, false]) {
      await container(folded, [])
      expect(remove().className).toContain('relative z-10')
      act(() => unmount?.())
    }
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

/* ------------------------------------------------------------------ *
 * Pinned runs (protocol 1.6.0)
 * ------------------------------------------------------------------ */

const review = (over: Record<string, Record<string, unknown>> = {}): HeaderItem[] =>
  headerItemsSchema.parse([
    { kind: 'run', id: 'back', label: 'Previous edit', icon: 'chevron-left', pinned: true, ...(over.back ?? {}) },
    { kind: 'run', id: 'accept', label: 'Accept edit', icon: 'check', pinned: true, ...(over.accept ?? {}) },
    { kind: 'run', id: 'reject', label: 'Decline edit', icon: 'x', pinned: true, confirm: true, ...(over.reject ?? {}) },
    { kind: 'run', id: 'next', label: 'Next edit', icon: 'chevron-right', pinned: true, ...(over.next ?? {}) },
    { kind: 'run', id: 'fifth', label: 'Fifth thing', icon: 'play', pinned: true },
    { kind: 'run', id: 'menu', label: 'Only in the menu', icon: 'pencil' },
    { kind: 'toggle', id: 'auto', label: 'Auto', checked: false, pinned: true },
  ])

const pins = () => [...document.querySelectorAll<HTMLElement>('[data-pinned-run]')]
const pin = (id: string) => document.querySelector<HTMLElement>(`[data-pinned-run="${id}"]`)!

describe('pinned runs are icon buttons in the header row', () => {
  if (!inChild) return

  test('drawn left of the menus in declaration order, at most four, an item without pinned is menu-only', async () => {
    const { host } = await mount(review())
    expect(pins().map((el) => el.getAttribute('data-pinned-run'))).toEqual(['back', 'accept', 'reject', 'next'])
    const all = [...host.querySelectorAll('[data-pinned-run], [data-menu]')].map((el) => el.getAttribute('data-pinned-run') ?? el.getAttribute('data-menu'))
    expect(all).toEqual(['back', 'accept', 'reject', 'next', 'view', 'run'])
    /* Same size as every other control in the row. */
    expect(pin('accept').className).toContain('size-6')
    await open('run')
    /* The menu keeps every run, pinned or not. */
    expect([...content('run')!.querySelectorAll('[data-item]')].map((el) => el.getAttribute('data-item'))).toEqual(['back', 'accept', 'reject', 'next', 'fifth', 'menu'])
  })

  test('the label is the accessible name, the icon is drawn, an unknown or missing icon is the first letters', async () => {
    await mount(review({ next: { icon: 'no-such-icon' }, back: { icon: undefined } }))
    expect(pin('accept').getAttribute('aria-label')).toBe('Accept edit')
    expect(pin('accept').querySelector('[data-icon="check"]')).not.toBeNull()
    expect(pin('reject').querySelector('[data-icon="x"]')).not.toBeNull()
    expect(pin('next').querySelector('[data-initials]')!.textContent).toBe('Ne')
    expect(pin('back').querySelector('[data-initials]')!.textContent).toBe('Pr')
    expect(Menus.initials('★ 1')).toBe('1')
  })

  test('every name in the protocol vocabulary is known to the host', async () => {
    const { HEADER_ICONS: vocabulary } = await import('kehikot-module-protocol')
    for (const name of vocabulary) expect(Menus.HEADER_ICONS.has(name), name).toBe(true)
  })

  test('a press goes the same way the menu sends it, and then the keyboard is the module’s', async () => {
    const { presses, handed } = await mount(review())
    await choose(pin('accept'))
    expect(presses).toEqual([{ item: 'accept' }])
    expect(handed.n).toBe(1)
  })

  test('a refused press says why on the button and leaves the keyboard here', async () => {
    const { handed } = await mount(review(), { answer: () => ({ ok: false, why: 'The edit is gone.' }) })
    await choose(pin('accept'))
    expect(handed.n).toBe(0)
    expect(said()).toBe('The edit is gone.')
  })

  test('disabled is dimmed, inert, never hidden, and the reason is in the tooltip text', async () => {
    const { presses } = await mount(review({ accept: { disabled: 'No edit is open' } }))
    expect(pin('accept')).not.toBeNull()
    expect(pin('accept').getAttribute('aria-disabled')).toBe('true')
    expect(pin('accept').className.split(' ')).toContain('opacity-50')
    await choose(pin('accept'))
    expect(presses).toEqual([])
    const { TooltipProvider: _ } = { TooltipProvider }
    await act(async () => {
      pin('accept').dispatchEvent(new FocusEvent('focus'))
      pin('accept').focus()
    })
    expect(document.body.textContent).toContain('Accept edit — No edit is open')
  })

  test('busy is a spinner that takes no press, failed is the menu’s mark', async () => {
    const { presses } = await mount(review({ accept: { state: 'busy' }, next: { state: 'failed', result: '2 errors' } }))
    expect(pin('accept').querySelector('.animate-spin')).not.toBeNull()
    expect(pin('accept').getAttribute('aria-busy')).toBe('true')
    /* Busy is a mark of its own, not the dimmed look of a disabled one. */
    expect(pin('accept').className.split(' ')).not.toContain('opacity-50')
    await choose(pin('accept'))
    expect(presses).toEqual([])
    expect(pin('next').getAttribute('data-state-run')).toBe('failed')
    expect(pin('next').querySelector('.animate-spin')).toBeNull()
    expect(pin('next').querySelector('[class*="size-3"]')).not.toBeNull()
  })

  test('confirm arms on the first press, runs on the second, and Escape or a click elsewhere disarms', async () => {
    const { presses } = await mount(review())
    await choose(pin('reject'))
    expect(presses).toEqual([])
    expect(pin('reject').getAttribute('data-armed')).toBe('true')
    expect(document.body.textContent).toContain('press again to confirm')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(pin('reject').getAttribute('data-armed')).toBeNull()
    await choose(pin('reject'))
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(pin('reject').getAttribute('data-armed')).toBeNull()
    await choose(pin('reject'))
    await choose(pin('reject'))
    expect(presses).toEqual([{ item: 'reject' }])
    expect(pin('reject').getAttribute('data-armed')).toBeNull()
  })

  test('full screen is asked from the pinned button’s click, before the press', async () => {
    const order: string[] = []
    const surface = { enter: () => (order.push('enter'), Promise.resolve(true)), leave: () => void order.push('leave') }
    await mount(review({ accept: { surface: 'fullscreen' } }), { surface, order })
    await choose(pin('accept'))
    expect(order).toEqual(['enter', 'press'])
  })

  test('narrow: not drawn under icons or merged mode, and the menu keeps them', async () => {
    for (const mode of ['icons', 'merged'] as const) {
      const { host } = await mount(review(), { mode })
      expect(pins()).toHaveLength(0)
      expect(host.querySelector('[data-menu]')).not.toBeNull()
      act(() => unmount?.())
      document.body.innerHTML = ''
    }
    expect(Menus.PINNED_BELOW).toBe(360)
  })

  test('narrow: a container measured under 360 px draws none, and 360 draws them', async () => {
    const grip = document.createElement('div')
    grip.className = 'container-grip'
    let width = 340
    Object.defineProperty(grip, 'offsetWidth', { get: () => width })
    document.body.appendChild(grip)
    const root = createRoot(grip)
    unmount = () => root.unmount()
    const draw = () =>
      act(async () => {
        root.render(
          <TooltipProvider>
            <Menus.HeaderMenus items={review()} name="Paper" onPress={async () => ({ ok: true, why: '' })} />
          </TooltipProvider>,
        )
      })
    await draw()
    expect(pins()).toHaveLength(0)
    expect(trigger('run')).not.toBeNull()
    width = 360
    unmount()
    const again = createRoot(grip)
    unmount = () => again.unmount()
    await act(async () => {
      again.render(
        <TooltipProvider>
          <Menus.HeaderMenus items={review()} name="Paper" onPress={async () => ({ ok: true, why: '' })} />
        </TooltipProvider>,
      )
    })
    expect(pins()).toHaveLength(4)
  })

  test('a container folded draws no menus, and so no pinned buttons', async () => {
    const { host } = await mount(review(), { pinned: true })
    expect(pins().length).toBe(4)
    /* `Container` does not draw HeaderMenus when `collapsed`; see its header slot. */
    const source = await Bun.file(new URL('../src/canvas/Container.tsx', import.meta.url)).text()
    expect(source).toMatch(/showing\.kind === 'page' && !collapsed \? \(\s*<HeaderMenus/)
    expect(host).not.toBeNull()
  })
})
