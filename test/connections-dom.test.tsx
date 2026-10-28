import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ConnectionModule, ConnectionsSetting, OnKehikko } from '../src/host/connections.ts'

/*
 * Providers & Consumers, rendered: the tab of a module's settings window — with or without the
 * module's own settings — its rows grouped by kind, each connection a sentence and a switch with
 * "on"/"off" in words, the choice of provider, "Reset to automatic" per row, and "See all on this
 * kehikko": every module, grouped by module, searchable, with "Reset all to automatic".
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix decides at load
 * whether it has a DOM.
 */

const inChild = process.env.CONNECTIONS_DOM === '1'
const TESTS = 6

if (!inChild) {
  test('Providers & Consumers, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CONNECTIONS_DOM: '1' },
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
let C: typeof import('../src/host/connections.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  UI = await import('../src/canvas/ModuleSettings.tsx')
  C = await import('../src/host/connections.ts')
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

const fixture = (name: string): OnKehikko => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/manifests', `${name}.json`), 'utf8')) as ConnectionModule & { name: string }
  return { id: manifest.id, name: manifest.name, manifest }
}

/**
 * The window for one module on a kehikko of Paper, Notes and Learning, kept as the page keeps it: the
 * setting is state, and each change is drawn again.
 */
async function windowFor(module: string, { settings = false, start }: { settings?: boolean; start?: ConnectionsSetting } = {}) {
  const modules = ['paper', 'notes', 'learning'].map(fixture)
  const changes: ConnectionsSetting[] = []
  function Page() {
    const [setting, setSetting] = React.useState<ConnectionsSetting>(start ?? C.AUTOMATIC)
    const sides = C.sidesOf(modules, C.connectionsOf(modules, setting), setting)
    return (
      <UI.ModuleSettingsDialog
        open
        onOpenChange={() => {}}
        module={module}
        name={modules.find((m) => m.id === module)!.name}
        project={{ id: 7, name: 'thesis' }}
        hasSettings={settings}
        api={{ list: async () => [], read: async () => ({ ok: false, why: 'none' }) as never, set: async () => ({ outcome: 'refused', why: '' }), file: async () => ({ ok: false, why: '' }) }}
        connections={{
          sides,
          setting,
          onChange: (next) => {
            changes.push(next)
            setSetting(next)
          },
        }}
      />
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider><Page /></TooltipProvider>))
  await act(async () => {})
  unmount = () => root.unmount()
  return { changes }
}

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const NOTES_FROM_PAPER = 'passage|kehikot.paper|kehikot.notes|'

function choose(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('a module’s window', () => {
  if (!inChild) return

  test('with no settings of its own, it opens on Providers & Consumers: what Notes provides and consumes, by kind', async () => {
    await windowFor('kehikot.notes')
    expect(q('[data-tab]')).toBeNull()
    const tab = q('[data-connections-tab="kehikot.notes"]')!
    expect(tab).not.toBeNull()
    const provides = tab.querySelector('[data-side="provides"]')!
    const consumes = tab.querySelector('[data-side="consumes"]')!
    expect(provides.textContent).toContain('Paper follows the passage Notes points at.')
    expect(consumes.textContent).toContain('Notes follows the passage Paper points at.')
    expect(consumes.textContent).toContain('Notes narrows to the parts picked in the bar.')
    /* Grouped by kind: one row for the passage, with both providers in it. */
    const passage = [...consumes.querySelectorAll('[data-connection-row]')].find((row) => row.textContent?.includes('A passage'))!
    expect(passage.querySelectorAll('[data-connection]').length).toBe(2)
    /* Icons, and every switch named by its sentence. */
    expect(passage.querySelectorAll('[data-module-icon]').length).toBeGreaterThan(0)
    expect(passage.querySelector(`[data-connection="${NOTES_FROM_PAPER}"] [role="switch"]`)!.getAttribute('aria-label')).toBe('Notes follows the passage Paper points at.')
  })

  test('a switch turns one connection off: said in words, with "off" beside it, and a reset for the row', async () => {
    const { changes } = await windowFor('kehikot.notes')
    const row = () => q(`[data-connection="${NOTES_FROM_PAPER}"]`)!
    expect(row().getAttribute('data-on')).toBe('on')
    await act(async () => row().querySelector<HTMLElement>('[role="switch"]')!.click())
    expect(changes.at(-1)!.off).toEqual([{ kind: 'passage', from: 'kehikot.paper', to: 'kehikot.notes' }])
    expect(row().getAttribute('data-on')).toBe('off')
    expect(row().textContent).toContain('Notes doesn’t follow Paper’s passage here.')
    expect(row().textContent).toContain('off')
    expect(row().querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    const reset = row().closest('[data-connection-row]')!.querySelector<HTMLElement>('[data-reset-row]')!
    expect(reset.textContent).toContain('Reset to automatic')
    await act(async () => reset.click())
    expect(changes.at(-1)).toEqual(C.AUTOMATIC)
    expect(row().getAttribute('data-on')).toBe('on')
  })

  test('the provider is chosen where several provide: only Paper', async () => {
    const { changes } = await windowFor('kehikot.notes')
    const select = q<HTMLSelectElement>('[data-side="consumes"] [data-choose-provider]')!
    expect([...select.options].map((o) => o.textContent)).toEqual(['any module here that provides it', 'only Paper', 'only Learning'])
    await act(async () => choose(select, 'kehikot.paper'))
    expect(changes.at(-1)!.only).toEqual([{ kind: 'passage', to: 'kehikot.notes', from: ['kehikot.paper'] }])
    expect(q('[data-connection="passage|kehikot.learning|kehikot.notes|"]')!.getAttribute('data-on')).toBe('off')
    await act(async () => choose(q<HTMLSelectElement>('[data-side="consumes"] [data-choose-provider]')!, 'any'))
    expect(changes.at(-1)).toEqual(C.AUTOMATIC)
  })

  test('with settings of its own, two tabs: Settings first, and Providers & Consumers', async () => {
    await windowFor('kehikot.paper', { settings: true })
    expect(all('[data-tab]').map((t) => t.textContent)).toEqual(['Settings', 'Providers & Consumers'])
    expect(q('[data-connections-tab]')).toBeNull()
    const trigger = q('[data-tab="connections"]')!
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      trigger.click()
    })
    await act(async () => {})
    expect(q('[data-connections-tab="kehikot.paper"]')).not.toBeNull()
  })
})

describe('every module on the kehikko', () => {
  if (!inChild) return

  test('"See all on this kehikko": grouped by module, Kehikot among them, searchable', async () => {
    await windowFor('kehikot.notes')
    await act(async () => q('[data-see-all]')!.click())
    expect(all('[data-module-connections]').map((m) => m.getAttribute('data-module-connections'))).toEqual(['kehikot.paper', 'kehikot.notes', 'kehikot.learning', 'kehikko'])
    const search = q<HTMLInputElement>('[data-kehikko-connections] input[type="search"]')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(search, 'parts')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const kinds = all('[data-connection-row] h4').map((h) => h.textContent)
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds.every((k) => k === 'The picked parts')).toBe(true)
    await act(async () => q('[data-see-all]')!.click())
    expect(q('[data-connections-tab="kehikot.notes"]')).not.toBeNull()
  })

  test('"Reset all to automatic" is there only when something was changed, and clears it all', async () => {
    const start = C.switched(C.switched(C.AUTOMATIC, { kind: 'passage', from: 'kehikot.paper', to: 'kehikot.notes', about: '' }, false), { kind: 'parts', from: 'kehikko', to: 'kehikot.learning', about: '' }, false)
    const { changes } = await windowFor('kehikot.notes', { start })
    await act(async () => q('[data-see-all]')!.click())
    const button = q<HTMLButtonElement>('[data-reset-all]')!
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(changes.at(-1)).toEqual(C.AUTOMATIC)
    expect(q<HTMLButtonElement>('[data-reset-all]')!.disabled).toBe(true)
    expect(all('[data-connection][data-on="off"]')).toEqual([])
  })
})
