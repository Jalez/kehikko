import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

import { DEFAULT_SETTINGS, type SettingsAnswer } from '../src/host/agentSettings.ts'
import { APPEARANCE_DEFAULT } from '../src/host/appearance.ts'

/*
 * Settings › Appearance, rendered: its sections and controls, each drawn on
 * `<html>` the moment it is chosen and then saved. In a process of its own for
 * the reason `header-menus.test.tsx` gives (Radix decides at load whether it
 * has a DOM).
 */

const inChild = process.env.APPEARANCE_DOM === '1'
const TESTS = 5

if (!inChild) {
  test('Settings › Appearance, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, APPEARANCE_DOM: '1' },
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
let Settings: typeof import('../src/canvas/Settings.tsx')
let Look: typeof import('../src/host/appearanceStore.ts')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Settings = await import('../src/canvas/Settings.tsx')
  Look = await import('../src/host/appearanceStore.ts')
})

afterAll(async () => {
  if (!inChild) return
  /* Let React's scheduler finish what the last press queued before the DOM goes. */
  await new Promise((resolve) => setTimeout(resolve, 50))
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  Look.appearance.set(APPEARANCE_DEFAULT)
  document.body.innerHTML = ''
})

function answer(): SettingsAnswer {
  return {
    ok: true,
    settings: { ...DEFAULT_SETTINGS, asked: true },
    status: { at: 1, running: false, problems: [], modules: [] },
    hook: { file: '/scratch/.claude/settings.json', on: false },
    skillsAt: '/scratch/.claude/skills',
    appearance: { ...APPEARANCE_DEFAULT, stored: true },
  }
}

async function tab() {
  const changes: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(<Settings.SettingsBody answer={answer()} busy={false} section="appearance" onSection={() => {}} onChange={(what) => void changes.push(what)} />),
  )
  unmount = () => root.unmount()
  return changes
}

const group = (name: string) => document.querySelector<HTMLElement>(`[data-appearance="${name}"]`)!
const choice = (name: string, value: string) => group(name).querySelector<HTMLButtonElement>(`[data-choice="${value}"]`)!
const html = () => document.documentElement

test('a tab of its own, after Modules: header and footer, folds, theme, borders with a preview, background', async () => {
  if (!inChild) return
  await tab()
  const tabs = [...document.querySelectorAll('[data-section]')].map((one) => one.getAttribute('data-section'))
  expect(tabs.slice(-2)).toEqual(['appearance', 'about'])
  expect(document.querySelector('#settings-appearance')!.textContent).toBe('Appearance')
  const values = (name: string) => [...group(name).querySelectorAll('[data-choice]')].map((one) => one.getAttribute('data-choice'))
  expect(values('rows')).toEqual(['always', 'hover', 'click', 'longpress'])
  expect(values('foldRows')).toEqual(['1', '2'])
  expect(values('theme')).toEqual(['system', 'light', 'dark'])
  expect(values('border')).toEqual(['none', 'solid', 'rounded', 'dotted', 'dashed'])
  expect(group('background').getAttribute('role')).toBe('switch')
  expect(document.querySelector('[data-appearance-preview]')).not.toBeNull()
  /* The defaults, checked. */
  expect(choice('rows', 'always').getAttribute('aria-checked')).toBe('true')
  expect(choice('theme', 'dark').getAttribute('aria-checked')).toBe('true')
  expect(choice('border', 'rounded').getAttribute('aria-checked')).toBe('true')
  expect(group('background').getAttribute('aria-checked')).toBe('true')
  /* Not the agents' one-time-question banner: this tab is not about them. */
  expect(document.querySelector('[data-unasked]')).toBeNull()
})

test('every border and the background draw on <html> at once, and are saved', async () => {
  if (!inChild) return
  const changes = await tab()
  for (const border of ['none', 'solid', 'dotted', 'dashed', 'rounded']) {
    await act(async () => choice('border', border).click())
    expect(html().getAttribute('data-container-border')).toBe(border)
    expect(document.querySelector('[data-appearance-preview]')!.getAttribute('data-appearance-preview')).toBe(`${border}-on`)
  }
  await act(async () => group('background').click())
  expect(html().getAttribute('data-container-background')).toBe('off')
  expect(changes).toEqual([
    { appearance: { border: 'none' } },
    { appearance: { border: 'solid' } },
    { appearance: { border: 'dotted' } },
    { appearance: { border: 'dashed' } },
    { appearance: { border: 'rounded' } },
    { appearance: { background: false } },
  ])
})

test('the theme is drawn at once, and System follows the computer', async () => {
  if (!inChild) return
  const changes = await tab()
  await act(async () => choice('theme', 'light').click())
  expect(html().classList.contains('dark')).toBe(false)
  expect(Look.appearance.theme()).toBe('light')
  await act(async () => choice('theme', 'dark').click())
  expect(html().classList.contains('dark')).toBe(true)
  await act(async () => choice('theme', 'system').click())
  expect(Look.appearance.get().theme).toBe('system')
  expect(changes).toEqual([{ appearance: { theme: 'light' } }, { appearance: { theme: 'dark' } }, { appearance: { theme: 'system' } }])
})

test('when headers and footers show, and how far a fold goes, are one setting for every container', async () => {
  if (!inChild) return
  const changes = await tab()
  await act(async () => choice('rows', 'longpress').click())
  await act(async () => choice('foldRows', '2').click())
  expect(Look.appearance.get()).toMatchObject({ rows: 'longpress', foldRows: 2 })
  expect(changes).toEqual([{ appearance: { rows: 'longpress' } }, { appearance: { foldRows: 2 } }])
  expect(group('rows').textContent).toContain('a plain click does not')
})

test('a link into Settings opens the tab at its first control', async () => {
  if (!inChild) return
  await tab()
  const { APPEARANCE_TARGET } = await import('../src/host/appearance.ts')
  const { revealTarget } = await import('../src/host/settingsTarget.ts')
  let shown = false
  await act(async () => void (shown = revealTarget(document, APPEARANCE_TARGET, () => {})))
  expect(shown).toBe(true)
  expect(document.querySelector(`[data-settings-target="${APPEARANCE_TARGET}"] [data-appearance="rows"]`)).not.toBeNull()
})
