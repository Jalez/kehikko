import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The updates panel, rendered: one panel under the button whose content
 * changes in place — checking, then the results — and never a second one.
 *
 * ## Why this file runs itself in a process of its own
 *
 * Radix decides at module load whether it has a DOM
 * (`@radix-ui/react-use-layout-effect` picks a no-op when `document` is
 * missing), and `bun test` loads every file into one process. Once another
 * file has imported Radix without a DOM, a popover can never open here. So in
 * the shared run this file only spawns `bun test` on itself with
 * `UPDATES_PANEL_DOM=1`, in a fresh process where happy-dom is registered
 * before anything imports React or Radix, and passes when that run passes.
 */

const inChild = process.env.UPDATES_PANEL_DOM === '1'

if (!inChild) {
  test('the updates panel, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, UPDATES_PANEL_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(/\b4 pass/)
  }, 60_000)
}

type Json = Record<string, unknown>
let answer: (url: string, init?: RequestInit) => Promise<Json>
let release: (() => void) | null = null

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Updates: typeof import('../src/canvas/Updates.tsx').Updates
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = await answer(String(url), init)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Updates } = await import('../src/canvas/Updates.tsx'))
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

const checkout = (id: string, behind: number, more: Json = {}) => ({
  id,
  name: id,
  dir: `/${id}`,
  branch: 'main',
  commit: 'abc1234',
  dirty: false,
  upstream: 'origin/main',
  behind,
  ahead: 0,
  incoming: Array.from({ length: behind }, (_, i) => ({ hash: `h${i}`, subject: `commit ${i}` })),
  fetchFailed: null,
  blocked: behind ? null : 'already up to date',
  ...more,
})

const check = (checkouts: Json[], restartable = false) => ({
  checked: new Date().toISOString(),
  checkouts,
  restartable,
})

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

const panels = () => document.querySelectorAll('[data-slot="popover-content"]')
const text = () => panels()[0]?.textContent ?? ''
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 10)))

describe.skipIf(!inChild)('the updates panel', () => {
  test('checking turns into the results in the same panel, listing only what needs attention', async () => {
    answer = (url) =>
      url.startsWith('/host/updates')
        ? new Promise((resolve) => {
            release = () =>
              resolve(check([checkout('host', 0), checkout('notes', 2), checkout('paper', 0), checkout('learning', 0)]))
          })
        : Promise.resolve({})
    const host = await mount()
    await press(host)

    expect(panels()).toHaveLength(1)
    expect(document.querySelector('[role="dialog"][data-slot="dialog-content"]')).toBeNull()
    const panel = panels()[0]
    expect(document.querySelector('[data-testid="updates-working"]')).not.toBeNull()
    expect(text()).toContain('Asking GitHub')
    expect(text()).toContain('Cancel')

    await act(async () => release?.())
    await settle()

    expect(panels()).toHaveLength(1)
    expect(panels()[0]).toBe(panel)
    expect(document.querySelector('[data-testid="updates-working"]')).toBeNull()
    const rows = document.querySelectorAll('[data-testid="updates-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('notes')
    expect(rows[0]?.textContent).toContain('2 new commits')
    expect(text()).toContain('3 others up to date')
    expect(text()).not.toContain('Everything is up to date')

    const show = [...document.querySelectorAll('button')].find((b) => b.textContent === 'show')!
    await act(async () => show.click())
    expect(document.querySelector('[data-testid="updates-level"]')?.textContent).toContain('learning')
  })

  test('nothing needing attention is one calm sentence and Check again', async () => {
    answer = async (url) => (url.startsWith('/host/updates') ? check([checkout('host', 0), checkout('notes', 0)]) : {})
    const host = await mount()
    await press(host)
    await settle()

    expect(document.querySelector('[data-testid="updates-calm"]')).not.toBeNull()
    expect(text()).toContain('Everything is up to date')
    expect(text()).toContain('Last checked just now')
    expect(text()).toContain('Check again')
    expect(document.querySelectorAll('[data-testid="updates-row"]')).toHaveLength(0)
    expect(text()).not.toContain('others up to date')
  })

  for (const restartable of [true, false]) {
    test(`Restart Kehikot after a host update ${restartable ? 'is' : 'is not'} offered when the app ${restartable ? 'can' : 'cannot'} restart`, async () => {
      answer = async (url, init) => {
        if (init?.method === 'POST') {
          return { checkout: checkout('host', 0), changed: ['server/x.ts'], installed: false, installFailed: null, restart: 'host' }
        }
        return url.startsWith('/host/updates') ? check([checkout('host', 1), checkout('notes', 0)], restartable) : {}
      }
      const host = await mount()
      await press(host)
      await settle()
      const update = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Update')!
      await act(async () => update.click())
      await settle()

      expect(panels()).toHaveLength(1)
      const row = document.querySelector('[data-testid="updates-row"]')
      expect(row?.textContent).toContain('Updated')
      const restart = [...document.querySelectorAll('button')].some((b) => b.textContent === 'Restart Kehikot')
      expect(restart).toBe(restartable)
    })
  }
})
