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
const TESTS = 13

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

test('a tab of its own, after Modules: a preview, header and footer, folds, theme, borders, background', async () => {
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
  expect(values('background')).toEqual(['card', 'transparent'])
  expect(document.querySelectorAll('[data-appearance-preview]')).toHaveLength(1)
  /* The defaults, checked. */
  expect(choice('rows', 'always').getAttribute('aria-checked')).toBe('true')
  expect(choice('theme', 'dark').getAttribute('aria-checked')).toBe('true')
  expect(choice('border', 'rounded').getAttribute('aria-checked')).toBe('true')
  expect(choice('background', 'card').getAttribute('aria-checked')).toBe('true')
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
  await act(async () => choice('background', 'transparent').click())
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

/* ------------------------------------------------------------------------ *
 * The questions: one radio group each, named by a sentence on screen
 * ------------------------------------------------------------------------ */

const question = (name: string) => document.getElementById(group(name).getAttribute('aria-labelledby')!)!.textContent
const checked = (name: string) => [...group(name).querySelectorAll('[role="radio"]')].filter((one) => one.getAttribute('aria-checked') === 'true').map((one) => one.getAttribute('data-choice'))

test('every question is one radiogroup with exactly one choice checked, named by the question on screen', async () => {
  if (!inChild) return
  await tab()
  const said: Record<string, string> = {
    rows: 'Show container headers and footers:',
    foldRows: 'When you fold a container, it keeps:',
    collapse: 'The ^ button on a container:',
    theme: 'Theme:',
    border: 'Container border:',
    background: 'Container background:',
  }
  for (const [name, words] of Object.entries(said)) {
    expect(group(name).getAttribute('role')).toBe('radiogroup')
    expect(question(name)).toBe(words)
    expect(checked(name)).toHaveLength(1)
  }
  expect([...group('rows').querySelectorAll('label')].map((one) => one.querySelector('span')!.textContent)).toEqual(['Always', 'When I hover', 'When I click', 'When I press and hold'])
  expect([...group('foldRows').querySelectorAll('label')].map((one) => one.querySelector('span')!.textContent)).toEqual(['Just its header (one row)', 'Its header and footer (two rows)'])
  expect(document.getElementById(group('foldRows').getAttribute('aria-describedby')!)!.textContent).toBe('Folding shrinks a container to its top rows; the module keeps running.')
  expect([...group('background').querySelectorAll('label')].map((one) => one.querySelector('span')!.textContent)).toEqual(['Card', 'Transparent'])
})

test('choosing one option un-chooses the other, and a label picks its radio', async () => {
  if (!inChild) return
  await tab()
  await act(async () => choice('rows', 'hover').click())
  expect(checked('rows')).toEqual(['hover'])
  await act(async () => choice('rows', 'click').click())
  expect(checked('rows')).toEqual(['click'])
  /* The other questions are untouched: three groups, never one list. */
  expect(checked('foldRows')).toEqual(['1'])
  expect(checked('collapse')).toEqual(['fold'])
  const label = group('rows').querySelector<HTMLLabelElement>(`label[for="${choice('rows', 'always').id}"]`)!
  await act(async () => label.click())
  expect(checked('rows')).toEqual(['always'])
})

test('arrow keys move the choice within its group', async () => {
  if (!inChild) return
  const changes = await tab()
  const first = choice('theme', 'dark')
  await act(async () => first.focus())
  await act(async () => {
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    /* Radix moves focus on the next task. */
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  /* Radix moves focus to the next radio and checks it on that focus; it wraps from the last. */
  expect(document.activeElement?.getAttribute('data-choice')).toBe('system')
  expect(checked('theme')).toEqual(['system'])
  expect(changes).toEqual([{ appearance: { theme: 'system' } }])
})

/* ------------------------------------------------------------------------ *
 * The preview
 * ------------------------------------------------------------------------ */

const preview = () => document.querySelector<HTMLElement>('[data-appearance-preview]')!
const example = () => preview().querySelector<HTMLElement>('[data-preview-container="first"]')!
const caret = () => example().querySelector<HTMLButtonElement>('[data-tour="fold"]')!
const enter = (element: Element) => element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
const leave = (element: Element) => element.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))

test('one preview, labelled, at the top: an example container with a header, menus, a body and a footer', async () => {
  if (!inChild) return
  await tab()
  const labelled = document.getElementById(preview().getAttribute('aria-labelledby')!)!
  expect(labelled.textContent).toBe('Preview')
  /* Drawn before the first question, so it is what you see first. */
  expect(preview().compareDocumentPosition(group('rows')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(example().classList.contains('container-frame')).toBe(true)
  expect(example().querySelector('.container-grip')!.textContent).toContain('Example module')
  expect(example().querySelector('[data-slot="dropdown-menu-trigger"]')).not.toBeNull()
  expect(example().querySelector('[data-preview-body]')).not.toBeNull()
  expect(example().querySelector('.container-footer')!.textContent).toContain('Usage')
  expect(preview().querySelector('[data-appearance-stage]')).not.toBeNull()
  /* Not a trap: nothing in it takes focus on its own. */
  expect(preview().contains(document.activeElement)).toBe(false)
  /* Two side by side, on request. */
  await act(async () => preview().querySelector<HTMLButtonElement>('[data-preview-two]')!.click())
  expect(preview().querySelectorAll('[data-preview-container]')).toHaveLength(2)
})

test('the preview reveals its header and footer as chosen: hover, click, press and hold', async () => {
  if (!inChild) return
  await tab()
  expect(example().getAttribute('data-rows')).toBeNull()
  await act(async () => choice('rows', 'hover').click())
  expect(example().getAttribute('data-rows')).toBe('hide')
  expect(example().getAttribute('data-revealed')).toBeNull()
  await act(async () => void enter(example()))
  expect(example().getAttribute('data-revealed')).toBe('true')
  await act(async () => void leave(example()))
  expect(example().getAttribute('data-revealed')).toBeNull()

  await act(async () => choice('rows', 'click').click())
  await act(async () => void enter(example()))
  expect(example().getAttribute('data-revealed')).toBeNull()
  await act(async () => example().querySelector<HTMLElement>('[data-preview-body]')!.click())
  expect(example().getAttribute('data-revealed')).toBe('true')
  await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(example().getAttribute('data-revealed')).toBeNull()

  await act(async () => choice('rows', 'longpress').click())
  const body = example().querySelector<HTMLElement>('[data-preview-body]')!
  await act(async () => body.click())
  expect(example().getAttribute('data-revealed')).toBeNull()
  await act(async () => void body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 600)))
  expect(example().getAttribute('data-revealed')).toBe('true')
})

test('the preview’s ^ folds it or makes it a tile, as chosen, and puts it back', async () => {
  if (!inChild) return
  const changes = await tab()
  await act(async () => caret().click())
  expect(example().getAttribute('data-fold')).toBe('1')
  expect(example().querySelector('[data-preview-body]')).toBeNull()
  await act(async () => caret().click())
  expect(example().getAttribute('data-fold')).toBeNull()

  await act(async () => choice('foldRows', '2').click())
  /* A fold choice folds the preview for a moment, so you can see what it means. */
  expect(example().getAttribute('data-fold')).toBe('2')
  expect(example().querySelector('.container-footer')).not.toBeNull()

  await act(async () => choice('collapse', 'tile').click())
  expect(example().getAttribute('data-tiled')).toBe('host')
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1900)))
  expect(example().getAttribute('data-tiled')).toBeNull()
  await act(async () => caret().click())
  expect(example().getAttribute('data-tiled')).toBe('host')
  expect(example().querySelector('[data-tile]')!.textContent).toContain('Example module')
  await act(async () => caret().click())
  expect(example().getAttribute('data-tiled')).toBeNull()
  expect(changes).toEqual([{ appearance: { foldRows: 2 } }, { appearance: { collapse: 'tile' } }])
})

test('pointing at a fold choice shows it on the preview, and leaving puts the preview back', async () => {
  if (!inChild) return
  await tab()
  const row = choice('foldRows', '2').parentElement!
  await act(async () => void enter(row))
  expect(example().getAttribute('data-fold')).toBe('2')
  await act(async () => void leave(group('foldRows')))
  expect(example().getAttribute('data-fold')).toBeNull()
})

test('the preview follows the border, the background and the theme', async () => {
  if (!inChild) return
  await tab()
  await act(async () => choice('border', 'dashed').click())
  expect(preview().getAttribute('data-appearance-preview')).toBe('dashed-on')
  expect(html().getAttribute('data-container-border')).toBe('dashed')
  expect(example().querySelector('[data-preview-body]')!.classList.contains('bg-card')).toBe(true)
  await act(async () => choice('background', 'transparent').click())
  expect(preview().getAttribute('data-appearance-preview')).toBe('dashed-off')
  expect(example().querySelector('[data-preview-body]')!.classList.contains('bg-card')).toBe(false)
  await act(async () => choice('theme', 'light').click())
  /* The preview is in the page, so the theme's class on <html> draws it at once. */
  expect(html().classList.contains('dark')).toBe(false)
  expect(html().contains(preview())).toBe(true)
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
