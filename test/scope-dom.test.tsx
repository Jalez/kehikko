import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { manifestSchema, type ModuleScope } from 'kehikot-module-protocol'

import { scopeOfContainer } from '../src/host/scope.ts'
import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * A module's scope, drawn (protocol 2.29.0): the "Scope" control at the top of
 * its settings window — every scope it lists with its line and "(default)", the
 * pick sent, and read-only "This module only works for …" for one with one —
 * the scope beside the window's title and on its Providers & Consumers tab, and
 * the scope on each row of the modules menu with its line in the tooltip. The
 * header label and its Frame menu row are in `header-fit.test.tsx`.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix
 * decides at load whether it has a DOM.
 */

const inChild = process.env.SCOPE_DOM === '1'
const TESTS = 5

if (!inChild) {
  test('the scope, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, SCOPE_DOM: '1' },
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
let Lists: typeof import('../src/canvas/Modules.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  UI = await import('../src/canvas/ModuleSettings.tsx')
  Lists = await import('../src/canvas/Modules.tsx')
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

async function render(node: import('react').ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
}

const base = { kind: 'kehikot.module', protocol: 2, entry: '/', partless: 'x' }
const kanban = manifestSchema.parse({
  ...base,
  id: 'kehikot.kanban',
  name: 'Kanban',
  modes: [
    { id: 'board', label: 'Kanban', scope: 'epic', scopeSays: 'the open epic’s issues and changes' },
    { id: 'all', label: 'All epics', scope: 'project', scopeSays: 'every epic’s issues and changes, each labelled' },
  ],
})
const explorer = manifestSchema.parse({
  ...base,
  id: 'kehikot.explorer',
  name: 'Explorer',
  modes: [{ id: 'explorer', label: 'Explorer', scope: 'project', scopeSays: 'the files of this project, whatever epic is open' }],
})

const NO_API = {
  list: async () => [],
  read: async () => ({ ok: false, why: 'none' }) as never,
  set: async () => ({ outcome: 'refused' as const, why: '' }),
  file: async () => ({ ok: false as const, why: '' }),
}

describe('the settings window', () => {
  if (!inChild) return

  function Kanban({ picks }: { picks: ModuleScope[] }) {
    const [picked, setPicked] = React.useState<string | null>(null)
    return (
      <UI.ModuleSettingsDialog
        open
        onOpenChange={() => {}}
        module="kehikot.kanban"
        name="Kanban"
        project={{ id: 7, name: 'thesis' }}
        hasSettings={false}
        api={NO_API}
        connections={{ sides: [], setting: { off: [], only: [] } as never, onChange: () => {} }}
        scope={{
          value: scopeOfContainer(kanban, picked),
          onPick: (scope) => {
            picks.push(scope)
            setPicked(scope === 'epic' ? null : scope)
          },
        }}
      />
    )
  }

  test('lists every scope the module can work at, with its line, the default marked and the active one chosen', async () => {
    await render(<Kanban picks={[]} />)
    const control = document.querySelector<HTMLElement>('[data-testid="scope-control"]')!
    expect(control.querySelector('h3')?.textContent).toContain('Scope')
    const options = [...control.querySelectorAll<HTMLElement>('[data-scope-option]')]
    expect(options.map((one) => one.getAttribute('data-scope-option'))).toEqual(['epic', 'project'])
    expect(options[0]!.textContent).toContain('Epic(default)')
    expect(options[0]!.textContent).toContain('the open epic’s issues and changes')
    expect(options[1]!.textContent).not.toContain('(default)')
    expect(options[1]!.textContent).toContain('every epic’s issues and changes, each labelled')
    const radios = [...control.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    expect(radios.map((one) => one.checked)).toEqual([true, false])
    expect(control.querySelector('[role="radiogroup"]')).not.toBeNull()
  })

  test('a pick is sent, and the window and its title say the new scope', async () => {
    const picks: ModuleScope[] = []
    await render(<Kanban picks={picks} />)
    const project = document.querySelector<HTMLInputElement>('input[value="project"]')!
    await act(async () => project.click())
    expect(picks).toEqual(['project'])
    expect(document.querySelector<HTMLInputElement>('input[value="project"]')!.checked).toBe(true)
    const title = document.querySelector<HTMLElement>('[data-testid="settings-scope"]')!
    expect(title.getAttribute('data-scope')).toBe('project')
    expect(title.getAttribute('title')).toBe('Scope: Project (changed). Every epic’s issues and changes, each labelled.')
  })

  test('the Providers & Consumers tab shows the scope', async () => {
    await render(<Kanban picks={[]} />)
    /* The only tab, with no settings declared: the scope is above it, in the same window. */
    expect(document.querySelector('[data-module-settings-dialog] [data-tab="connections"], [data-module-settings-dialog]')?.textContent).toContain(
      'Scope',
    )
    expect(document.querySelector('[data-testid="scope-control"]')?.getAttribute('data-scope')).toBe('epic')
  })

  test('a module with one scope shows it read-only: "This module only works for Project"', async () => {
    await render(
      <UI.ModuleSettingsDialog
        open
        onOpenChange={() => {}}
        module="kehikot.explorer"
        name="Explorer"
        project={{ id: 7, name: 'thesis' }}
        hasSettings={false}
        api={NO_API}
        scope={{ value: scopeOfContainer(explorer, null), onPick: () => {} }}
      />,
    )
    const only = document.querySelector<HTMLElement>('[data-testid="scope-only"]')!
    expect(only.textContent).toContain('Project')
    expect(only.textContent).toContain('This module only works for Project.')
    expect(only.textContent).toContain('the files of this project, whatever epic is open')
    expect(document.querySelectorAll('[data-testid="scope-control"] input')).toHaveLength(0)
  })
})

describe('the modules menu', () => {
  if (!inChild) return

  test('each registered module’s row shows its scope with its icon, and the line and the others in its tooltip', async () => {
    const presence = (id: string, name: string, module: object): Presence =>
      ({ id, name, at: 'http://127.0.0.1:7870', condition: 'ready', reached: true, line: '', module }) as unknown as Presence
    const registry: RegistryView = {
      presences: [presence('kehikot.kanban', 'Kanban', kanban), presence('kehikot.explorer', 'Explorer', explorer)],
      sweep: { dir: '/tmp/modules', rejected: [] },
      protocol: 2,
    }
    await render(<Lists.ModuleList registry={registry} onCanvas={new Set()} canvases={[]} open={null} onPlace={() => {}} onUnplace={() => {}} />)
    const chips = [...document.querySelectorAll<HTMLElement>('[data-testid="module-scope"]')]
    expect(chips.map((one) => [one.getAttribute('data-scope'), one.textContent])).toEqual(
      expect.arrayContaining([
        ['epic', 'Epic'],
        ['project', 'Project'],
      ]),
    )
    for (const chip of chips) expect(chip.querySelector('svg')).not.toBeNull()
    const kanbanChip = chips.find((one) => one.getAttribute('data-scope') === 'epic')!
    expect(kanbanChip.getAttribute('aria-label')).toBe('Scope: Epic. The open epic’s issues and changes. Can also work for: Project.')
    expect(kanbanChip.tabIndex).toBe(0)
  })
})
