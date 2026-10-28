import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { headerItemsSchema, settingsDeclarationSchema, type HeaderItem, type SettingField } from 'kehikot-module-protocol'

import type { SetAnswer, SettingsAnswer, SettingsListed } from '../src/host/moduleSettings.ts'

/*
 * A module's settings, rendered (protocol 2.15.0): the form drawn from what the module declared —
 * a switch, a text field, a number, a select and a list — each change sent and said ("Saved", or
 * the module's sentence), "Open the file", the modal, Settings › Modules, and the gear in a
 * container's header at 380, 280 and 200 pixels, folded and unfolded.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix decides at load
 * whether it has a DOM.
 */

const inChild = process.env.MODULE_SETTINGS_DOM === '1'
const TESTS = 12

if (!inChild) {
  test('the module settings, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MODULE_SETTINGS_DOM: '1' },
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
let UI: typeof import('../src/canvas/ModuleSettings.tsx')
let Box: typeof import('../src/canvas/Container.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  WIDTH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  UI = await import('../src/canvas/ModuleSettings.tsx')
  Box = await import('../src/canvas/Container.tsx')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
let WIDTH: PropertyDescriptor | undefined
afterEach(() => {
  if (!inChild) return
  if (WIDTH) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', WIDTH)
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
  UI.setSettingsFileOpener(null)
})

const FIELDS: SettingField[] = settingsDeclarationSchema.parse([
  { key: 'judgeMerges', label: 'Let the judge merge', description: 'Merges an approved job.', type: 'boolean', default: false, personOnly: true },
  { key: 'defaultRule', label: 'Ready for another review', type: 'string', default: 'when they ask' },
  { key: 'rounds', label: 'Rounds', type: 'number', default: 3 },
  { key: 'door', label: 'Door', type: 'choice', choices: [{ value: 'one-way', label: 'One-way' }, { value: 'two-way', label: 'Two-way' }], default: 'one-way' },
  { key: 'doorRules', label: 'Door rules', type: 'list', default: ['label docs → two-way'] },
])

/** A module behind the form, kept in memory: it saves what it is sent, except what it refuses. */
function fakeApi(over: { refuse?: string; file?: { path: string; file: string; text: string } } = {}) {
  const values: Record<string, unknown> = { judgeMerges: false, defaultRule: 'when they ask', rounds: 3, door: 'one-way', doorRules: ['label docs → two-way'] }
  const sent: { module: string; project: number | null; key: string; value: unknown }[] = []
  const api: import('../src/canvas/ModuleSettings.tsx').SettingsApi = {
    list: async (): Promise<SettingsListed[]> => [
      { id: 'kehikot.factory', name: 'Factory', icon: 'lucide:factory', ready: true, fields: FIELDS },
      { id: 'kehikot.notes', name: 'Notes', icon: null, ready: true, fields: [] },
      { id: 'kehikot.flows', name: 'Flows', icon: null, ready: false, fields: [] },
    ],
    read: async (module): Promise<SettingsAnswer> => ({ ok: true, module, name: 'Factory', fields: FIELDS, values: { ...values }, file: '.kehikot/factory/settings.json', problem: null }),
    set: async (module, project, key, value): Promise<SetAnswer> => {
      sent.push({ module, project, key, value })
      if (over.refuse && key === over.refuse) return { outcome: 'refused', why: 'Factory will not take that.' }
      values[key] = value
      return { outcome: 'saved', why: '', values: { ...values } }
    },
    file: async () => (over.file ? { ok: true, ...over.file } : { ok: false, why: 'Factory does not say where it keeps its settings.' }),
  }
  return { api, sent, values }
}

async function render(element: import('react').ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<TooltipProvider>{element}</TooltipProvider>)
  })
  await act(async () => {})
  unmount = () => root.unmount()
  return host
}

const field = (key: string) => document.querySelector<HTMLElement>(`[data-setting="${key}"]`)
const note = (key: string) => field(key)?.querySelector('[data-setting-note]')?.textContent ?? ''

function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  set.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the form', () => {
  if (!inChild) return

  test('draws each type as its control, with its label, description and who may change it', async () => {
    const { api } = fakeApi()
    await render(<UI.ModuleSettingsForm module="kehikot.factory" project={7} api={api} />)
    expect([...document.querySelectorAll('[data-setting]')].map((el) => [el.getAttribute('data-setting'), el.getAttribute('data-control')])).toEqual([
      ['judgeMerges', 'switch'],
      ['defaultRule', 'text'],
      ['rounds', 'number'],
      ['door', 'select'],
      ['doorRules', 'lines'],
    ])
    expect(field('judgeMerges')!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    expect(field('judgeMerges')!.textContent).toContain('Merges an approved job.')
    expect(field('judgeMerges')!.querySelector('[data-person-only]')).not.toBeNull()
    expect(field('defaultRule')!.querySelector('[data-person-only]')).toBeNull()
    expect(field('defaultRule')!.querySelector<HTMLInputElement>('input')!.value).toBe('when they ask')
    expect(field('rounds')!.querySelector<HTMLInputElement>('input')!.type).toBe('number')
    expect(field('door')!.querySelector<HTMLSelectElement>('select')!.value).toBe('one-way')
    expect(field('doorRules')!.querySelectorAll('input').length).toBe(2)
  })

  test('a switch, a select, a text and a number each save once, through the module, and say "Saved"', async () => {
    const { api, sent } = fakeApi()
    await render(<UI.ModuleSettingsForm module="kehikot.factory" project={7} api={api} />)
    await act(async () => field('judgeMerges')!.querySelector<HTMLElement>('[role="switch"]')!.click())
    await act(async () => {})
    expect(sent).toEqual([{ module: 'kehikot.factory', project: 7, key: 'judgeMerges', value: true }])
    expect(note('judgeMerges')).toBe('Saved')
    expect(field('judgeMerges')!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')

    const select = field('door')!.querySelector<HTMLSelectElement>('select')!
    await act(async () => {
      select.value = 'two-way'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {})
    expect(sent.at(-1)).toEqual({ module: 'kehikot.factory', project: 7, key: 'door', value: 'two-way' })

    const text = field('defaultRule')!.querySelector<HTMLInputElement>('input')!
    await act(async () => type(text, 'after two hours'))
    await act(async () => text.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await act(async () => {})
    expect(sent.at(-1)).toEqual({ module: 'kehikot.factory', project: 7, key: 'defaultRule', value: 'after two hours' })

    const number = field('rounds')!.querySelector<HTMLInputElement>('input')!
    await act(async () => type(number, '5'))
    await act(async () => number.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => {})
    expect(sent.at(-1)).toEqual({ module: 'kehikot.factory', project: 7, key: 'rounds', value: 5 })
    expect(sent.length).toBe(4)
  })

  test('the list editor adds a line and removes one, each as one change of the whole list', async () => {
    const { api, sent } = fakeApi()
    await render(<UI.ModuleSettingsForm module="kehikot.factory" project={7} api={api} />)
    const adding = field('doorRules')!.querySelector<HTMLInputElement>('input[placeholder="Add a line"]')!
    await act(async () => type(adding, 'path docs/** → two-way'))
    await act(async () => field('doorRules')!.querySelector<HTMLElement>('[aria-label="add the line"]')!.click())
    await act(async () => {})
    expect(sent.at(-1)!.value).toEqual(['label docs → two-way', 'path docs/** → two-way'])
    await act(async () => field('doorRules')!.querySelector<HTMLElement>('[aria-label="remove line 1"]')!.click())
    await act(async () => {})
    expect(sent.at(-1)!.value).toEqual(['path docs/** → two-way'])
  })

  test("a refusal says the module's sentence, and the value stays as the module keeps it", async () => {
    const { api } = fakeApi({ refuse: 'judgeMerges' })
    await render(<UI.ModuleSettingsForm module="kehikot.factory" project={7} api={api} />)
    await act(async () => field('judgeMerges')!.querySelector<HTMLElement>('[role="switch"]')!.click())
    await act(async () => {})
    expect(note('judgeMerges')).toBe('Factory will not take that.')
    expect(field('judgeMerges')!.querySelector('[data-setting-note]')!.getAttribute('data-setting-note')).toBe('refused')
    expect(field('judgeMerges')!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
  })

  test('a module that cannot be read says why, and draws no field', async () => {
    const { api } = fakeApi()
    await render(<UI.ModuleSettingsForm module="kehikot.factory" project={7} api={{ ...api, read: async () => ({ ok: false, why: 'kehikot.factory is not running.' }) }} />)
    expect(document.querySelector('[data-settings-why]')!.textContent).toBe('kehikot.factory is not running.')
    expect(document.querySelector('[data-setting]')).toBeNull()
  })
})

describe('open the file', () => {
  if (!inChild) return

  test('with no Editor on the kehikko, the file is shown read-only in a dialog', async () => {
    const { api } = fakeApi({ file: { path: '/p/.kehikot/factory/settings.json', file: '.kehikot/factory/settings.json', text: '{\n  "judgeMerges": false\n}\n' } })
    await render(<UI.ModuleSettingsForm module="kehikot.factory" project={7} api={api} />)
    await act(async () => document.querySelector<HTMLElement>('[data-settings-open-file]')!.click())
    await act(async () => {})
    const shown = document.querySelector('[data-settings-file]')!
    expect(shown.textContent).toContain('"judgeMerges": false')
    expect(shown.textContent).toContain('Read-only.')
    expect(shown.querySelector('textarea, input')).toBeNull()
  })

  test('with an Editor, the page is asked to point it at the file, and the modal may close', async () => {
    const { api } = fakeApi({ file: { path: '/p/.kehikot/factory/settings.json', file: '.kehikot/factory/settings.json', text: '{}' } })
    const opened: string[] = []
    UI.setSettingsFileOpener((path) => {
      opened.push(path)
      return true
    })
    let closed = 0
    await render(<UI.ModuleSettingsForm module="kehikot.factory" project={7} api={api} onOpened={() => (closed += 1)} />)
    await act(async () => document.querySelector<HTMLElement>('[data-settings-open-file]')!.click())
    await act(async () => {})
    expect(opened).toEqual(['/p/.kehikot/factory/settings.json'])
    expect(closed).toBe(1)
    expect(document.querySelector('[data-settings-file]')).toBeNull()
  })
})

describe('the modal and Settings › Modules', () => {
  if (!inChild) return

  test('the modal is titled "<Module> settings" and holds the form', async () => {
    const { api } = fakeApi()
    await render(<UI.ModuleSettingsDialog open onOpenChange={() => {}} module="kehikot.factory" name="Factory" project={{ id: 7, name: 'thesis' }} api={api} />)
    await act(async () => {})
    const dialog = document.querySelector('[data-module-settings-dialog="kehikot.factory"]')!
    expect(dialog.textContent).toContain('Factory settings')
    expect(dialog.textContent).toContain('For thesis.')
    expect(dialog.querySelectorAll('[data-setting]').length).toBe(5)
  })

  test('lists every installed module with its icon: a form, "No settings", or not running', async () => {
    const { api } = fakeApi()
    await render(<UI.ModulesSettings api={api} project={{ id: 7, name: 'thesis' }} />)
    await act(async () => {})
    const sections = [...document.querySelectorAll<HTMLElement>('[data-settings-module]')]
    expect(sections.map((one) => one.getAttribute('data-settings-module'))).toEqual(['kehikot.factory', 'kehikot.flows', 'kehikot.notes'])
    expect(sections[0]!.querySelector('[data-module-icon]')).not.toBeNull()
    expect(sections[0]!.querySelectorAll('[data-setting]').length).toBe(5)
    expect(sections[1]!.textContent).toContain('Not running')
    expect(sections[2]!.textContent).toContain('No settings.')
    expect(document.querySelector('[data-settings-modules]')!.textContent).toContain('for thesis')
  })
})

describe('the gear in the header', () => {
  if (!inChild) return

  const presence = (settings: boolean) =>
    ({
      id: 'kehikot.factory',
      at: 'http://127.0.0.1:7920',
      condition: 'ready',
      reached: true,
      name: 'Factory',
      line: '',
      agent: { kind: 'none' },
      module: { name: 'Factory', declares: { protocol: '>=2', uses: [], storage: false, ...(settings ? { settings: FIELDS } : {}) } },
    }) as unknown as import('../src/host/registry.ts').Presence

  const menus = (): HeaderItem[] => headerItemsSchema.parse([{ kind: 'switch', id: 'view', label: 'View', options: [{ id: 'board', label: 'Board' }, { id: 'runs', label: 'Runs' }], value: 'board' }])

  /** The header as wide as said: every `.container-grip` measures `width`. */
  async function header(width: number, collapsed: boolean, settings: boolean, onSettings: () => void) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains('container-grip') ? width : 0
      },
    })
    const nothing = () => {}
    await render(
      <Box.Container
        presence={presence(settings)}
        showing={{ kind: 'page' }}
        fault={null}
        body={nothing}
        grow={false}
        onGrow={nothing}
        pinned={false}
        onPin={nothing}
        collapsed={collapsed}
        onCollapse={nothing}
        header={menus()}
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
        onSettings={onSettings}
        onStarted={nothing}
        onRemove={nothing}
        kehikko="thesis"
        epic={null}
      />,
    )
  }

  async function openMenu(which: string) {
    await act(async () => {
      document.querySelector(`[data-menu="${which}"]`)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    })
    return document.querySelector<HTMLElement>(`[data-menu-content="${which}"]`)
  }

  const gear = () => document.querySelector<HTMLElement>('header [data-settings-button]')

  test('an icon at 380 and 280 pixels, folded or not, with "<Module> settings" as its name, opening the modal', async () => {
    for (const [width, collapsed] of [[380, false], [280, false], [380, true], [280, true]] as const) {
      let opened = 0
      await header(width, collapsed, true, () => (opened += 1))
      expect(gear(), `${width} ${collapsed ? 'folded' : 'unfolded'}`).not.toBeNull()
      expect(gear()!.getAttribute('aria-label')).toBe('Factory settings')
      expect(gear()!.textContent).toBe('')
      /* The module's own menus are as the width says, gear or no gear. */
      if (!collapsed) expect(document.querySelector('[data-header-menus]')!.getAttribute('data-header-menus')).toBe(width < 300 ? 'icons' : 'words')
      await act(async () => gear()!.click())
      expect(opened).toBe(1)
      act(() => unmount?.())
      unmount = null
    }
  })

  test('at 200 pixels it folds into the module’s "⋯", and folded into the Frame menu, which has it at every width', async () => {
    let opened = 0
    await header(200, false, true, () => (opened += 1))
    expect(gear()).toBeNull()
    const more = await openMenu('more')
    const row = more!.querySelector<HTMLElement>('[data-more="settings"]')!
    expect(row.textContent).toBe('Settings…')
    await act(async () => row.click())
    expect(opened).toBe(1)
    act(() => unmount?.())

    await header(200, true, true, () => (opened += 1))
    expect(gear()).toBeNull()
    expect(document.querySelector('[data-menu="more"]')).toBeNull()
    const frame = await openMenu('frame')
    const settings = frame!.querySelector<HTMLElement>('[data-frame="settings"]')!
    expect(settings.textContent).toBe('Settings…')
    await act(async () => settings.click())
    expect(opened).toBe(2)
  })

  test('a module that declared no settings still gets the gear, the "⋯" row and the Frame row: its window has Providers & Consumers', async () => {
    for (const [width, collapsed] of [[380, false], [280, false], [380, true]] as const) {
      let opened = 0
      await header(width, collapsed, false, () => (opened += 1))
      expect(gear(), `${width} ${collapsed ? 'folded' : 'unfolded'}`).not.toBeNull()
      expect(gear()!.getAttribute('aria-label')).toBe('Factory settings')
      await act(async () => gear()!.click())
      expect(opened).toBe(1)
      act(() => unmount?.())
      unmount = null
      document.body.innerHTML = ''
    }
    await header(200, true, false, () => {})
    expect(gear()).toBeNull()
    const frame = await openMenu('frame')
    expect(frame!.querySelector('[data-frame="settings"]')!.textContent).toBe('Settings…')
    act(() => unmount?.())
    unmount = null
    document.body.innerHTML = ''
  })
})
