import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { DEFAULT_SETTINGS, type SettingsAnswer } from '../src/host/agentSettings.ts'

/*
 * "Keep modules up to date automatically", rendered: the toggle at the top of
 * the Updates menu, the rows that say what waits and what was updated, and the
 * switch in Settings › Modules. In a process of its own, for the reason
 * `updates-panel.test.tsx` gives (Radix decides at load whether it has a DOM).
 */

const inChild = process.env.AUTO_UPDATES_DOM === '1'
const TESTS = 5

if (!inChild) {
  test('automatic module updates, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, AUTO_UPDATES_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

type Json = Record<string, unknown>
let answer: (url: string, init?: RequestInit) => Promise<Json | Response>
const posts: { url: string; body: unknown }[] = []

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Updates: typeof import('../src/canvas/Updates.tsx').Updates
let Settings: typeof import('../src/canvas/Settings.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let announceUpdatesChanged: typeof import('../src/host/updates.ts').announceUpdatesChanged

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts.push({ url: String(url), body: JSON.parse(String(init.body ?? 'null')) })
    const body = await answer(String(url), init)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Updates } = await import('../src/canvas/Updates.tsx'))
  Settings = await import('../src/canvas/Settings.tsx')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  ;({ announceUpdatesChanged } = await import('../src/host/updates.ts'))
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
  posts.length = 0
  document.body.innerHTML = ''
})

const release = (over: Json = {}) => ({
  follows: 'release',
  installed: 'v1.5.0',
  newest: 'v1.6.0',
  target: 'v1.6.0',
  notes: ['v1.6.0'],
  needsNewer: null,
  repo: null,
  error: null,
  ...over,
})

const copy = (id: string, name: string, over: Json = {}) => ({
  id,
  name,
  dir: `/scratch/installed/${id}`,
  branch: null,
  commit: 'abc1234',
  dirty: false,
  upstream: 'v1.6.0',
  behind: 1,
  ahead: 0,
  incoming: [],
  fetchFailed: null,
  blocked: null,
  release: release(),
  ...over,
})

const updated = (at = new Date().toISOString()) => [{ id: 'kehikot.journeys', name: 'Journeys', from: '1.5.0', to: '1.6.0', at, major: false }]

function checkWith(auto: Json | undefined, checkouts: Json[]) {
  return { checked: new Date().toISOString(), checkouts, restartable: false, ...(auto ? { auto } : {}) }
}

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <Updates markMs={0} />
      </TooltipProvider>,
    )
  })
  unmount = () => root.unmount()
  return host
}

async function press(host: HTMLElement) {
  const button = host.querySelector('button[aria-label]') as HTMLButtonElement
  await act(async () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    button.click()
  })
}

const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 10)))
const indicatorText = () => document.querySelector('[data-testid="updates-indicator"]')?.textContent ?? ''
const waits = () => [...document.querySelectorAll('[data-testid="updates-auto-waiting"]')].map((one) => one.textContent)

describe.skipIf(!inChild)('the Updates menu', () => {
  test('the toggle is at the top, says the switch, and turning it off posts the machine setting', async () => {
    let on = true
    answer = async (url, init) => {
      if (url === '/host/settings' && init?.method === 'POST') {
        on = (JSON.parse(String(init.body)) as { updates: { auto: boolean } }).updates.auto
        return { ok: true, settings: {}, updates: { auto: on } }
      }
      if (url.startsWith('/host/updates')) return checkWith({ on, waiting: {}, updated: [] }, [copy('kehikot.journeys', 'Journeys', { release: release({ target: null }) })])
      return {}
    }
    const host = await mount()
    await press(host)
    await settle()
    const toggle = document.querySelector<HTMLButtonElement>('[data-testid="updates-auto-switch"]')!
    expect(toggle).not.toBeNull()
    expect(toggle.getAttribute('aria-label')).toBe('Keep modules up to date automatically')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-testid="updates-auto"]')?.textContent).toContain('Update modules automatically')
    await act(async () => toggle.click())
    await settle()
    expect(posts).toEqual([{ url: '/host/settings', body: { updates: { auto: false } } }])
    expect(document.querySelector('[data-testid="updates-auto-switch"]')!.getAttribute('aria-checked')).toBe('false')
  })

  test('what waits says why, and a scheduled one is not counted in the header', async () => {
    answer = async (url) => {
      if (!url.startsWith('/host/updates')) return {}
      return checkWith(
        {
          on: true,
          waiting: {
            'kehikot.terminal': { until: 'stopped', target: 'v1.6.0', detail: null, shells: true },
            'kehikot.paper': { until: 'app', target: 'v2.0.0', detail: '0.1.70' },
          },
          updated: [],
        },
        [
          copy('kehikot.terminal', 'Terminal'),
          copy('kehikot.paper', 'Paper', { release: release({ installed: 'v1.9.0', newest: 'v1.9.0', target: null, needsNewer: { tag: 'v2.0.0', protocol: '3.0.0' } }), behind: 0 }),
        ],
      )
    }
    const host = await mount()
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 5_200)))
    /* The quiet check found Terminal's update, which the switch takes when its sessions end: nothing to press. */
    expect(indicatorText()).not.toContain('update')
    await press(host)
    await settle()
    expect(waits().sort()).toEqual(['Paper waits for Kehikot 0.1.70', 'Terminal updates when its sessions end'])
  }, 15_000)

  test('"Updated automatically" lists what the switch updated, and a wake reads it again', async () => {
    let done: Json[] = []
    answer = async (url) => {
      if (!url.startsWith('/host/updates')) return {}
      return checkWith({ on: true, waiting: {}, updated: done }, [copy('kehikot.journeys', 'Journeys', { release: release({ installed: 'v1.6.0', target: null }), behind: 0 })])
    }
    const host = await mount()
    await press(host)
    await settle()
    expect(document.querySelector('[data-testid="updates-auto-updated"]')).toBeNull()
    done = updated()
    await act(async () => announceUpdatesChanged())
    await settle()
    const rows = [...document.querySelectorAll('[data-testid="updates-auto-row"]')]
    expect(rows.map((one) => one.getAttribute('data-module'))).toEqual(['kehikot.journeys'])
    expect(rows[0]!.textContent).toContain('Journeys 1.5.0 → 1.6.0')
    expect(rows[0]!.textContent).toContain('just now')
  })

  test('off: the menu is as it was — the update waits for a press, and nothing says it is automatic', async () => {
    answer = async (url) => {
      if (!url.startsWith('/host/updates')) return {}
      return checkWith({ on: false, waiting: {}, updated: [] }, [copy('kehikot.journeys', 'Journeys')])
    }
    const host = await mount()
    await press(host)
    await settle()
    expect(document.querySelector('[data-testid="updates-auto-switch"]')!.getAttribute('aria-checked')).toBe('false')
    expect(waits()).toEqual([])
    expect([...document.querySelectorAll('button')].some((one) => one.textContent?.trim() === 'Update')).toBe(true)
  })
})

describe.skipIf(!inChild)('Settings › Modules', () => {
  test('the switch is there, machine-wide, and a change is sent as { updates: { auto } }', async () => {
    const changes: unknown[] = []
    const answered: SettingsAnswer = {
      ok: true,
      settings: { ...DEFAULT_SETTINGS, asked: true },
      status: { at: 1, running: false, problems: [], modules: [] },
      hook: { file: '/scratch/.claude/settings.json', on: false },
      skillsAt: '/scratch/.claude/skills',
      updates: { auto: true },
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    answer = async () => ({ ok: true, modules: [] })
    await act(async () =>
      root.render(
        <Settings.SettingsDialog
          open
          onOpenChange={() => {}}
          section="modules"
          load={async () => answered}
          save={async (change) => {
            changes.push(change)
            return answered
          }}
        />,
      ),
    )
    unmount = () => root.unmount()
    await settle()
    const row = document.querySelector('[data-auto-updates-setting]')!
    expect(row.textContent).toContain('Keep modules up to date automatically')
    expect(row.textContent).toContain('Pinned modules are left alone')
    const toggle = row.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle.click())
    expect(changes).toEqual([{ updates: { auto: false } }])
  })
})
