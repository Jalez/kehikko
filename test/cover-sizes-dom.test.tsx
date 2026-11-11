import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The cover and the notice, rendered at every size a container can be
 * (`src/host/coverFit.ts`, `src/canvas/Standing.tsx`): full, small, one line,
 * and folded to the header — for a module being updated and for a restart that
 * failed. The press stays reachable at every size, and the address is never
 * the main text.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix
 * decides at load whether it has a DOM.
 */

const inChild = process.env.COVER_SIZES_DOM === '1'
const TESTS = 12

if (!inChild) {
  test('the cover at every size, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, COVER_SIZES_DOM: '1' },
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
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let WIDTH: PropertyDescriptor | undefined
let HEIGHT: PropertyDescriptor | undefined

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  WIDTH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  HEIGHT = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Box = await import('../src/canvas/Container.tsx')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  /* The module's icon, as the registry would say it: what every cover draws. */
  ;(await import('../src/canvas/ModuleIcon.tsx')).setRegisteredIcons([{ id: 'kehikot.example', icon: 'lucide:route' }])
})

afterAll(async () => {
  if (!inChild) return
  if (WIDTH) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', WIDTH)
  if (HEIGHT) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', HEIGHT)
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
const AT = 'http://127.0.0.1:8110'

const presence = {
  id: 'kehikot.example',
  at: AT,
  condition: 'silent',
  reached: false,
  name: 'Example',
  line: '',
  dir: '/tmp/example',
  agent: { kind: 'none' },
} as unknown as import('../src/host/registry.ts').Presence

type Showing = import('../src/host/standing.ts').Showing
const UPDATING: Showing = { kind: 'cover', state: 'updating' }
const FAILED: Showing = { kind: 'notice', condition: 'silent', asleep: false, line: 'The restart did not bring it back.', restartFailed: ['error: port in use'] }

type Size = { width: number; height: number } | 'folded'

async function draw(showing: Showing, size: Size, onRestart: () => void = nothing, loading: { label: string | null } | null = null) {
  const width = size === 'folded' ? 380 : size.width
  const height = size === 'folded' ? 0 : size.height
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains('container-grip') || this.hasAttribute?.('data-cover-layout') ? width : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute?.('data-cover-layout') ? height : 0
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
          showing={showing}
          loading={loading}
          fault={null}
          body={nothing}
          grow={false}
          onGrow={nothing}
          pinned={false}
          onPin={nothing}
          collapsed={size === 'folded'}
          onCollapse={nothing}
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
          onRestart={onRestart}
          restart={showing.kind === 'notice' ? { kind: 'failed', why: showing.line, detail: ['error: port in use'] } : undefined}
          onRemove={nothing}
          kehikko="thesis"
          epic={null}
        />
      </TooltipProvider>,
    )
  })
  unmount = () => root.unmount()
}

const layout = () => document.querySelector('[data-cover-layout]')?.getAttribute('data-cover-layout') ?? null
/** What a person reads in the body, without tooltips (`title`). */
const bodyText = () => document.querySelector('[data-cover-layout]')?.textContent ?? ''

async function openFrame(): Promise<HTMLElement> {
  const trigger = document.querySelector<HTMLElement>('header [data-menu="frame"]')!
  expect(trigger).not.toBeNull()
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
  })
  return document.querySelector<HTMLElement>('[data-menu-content="frame"]')!
}

describe('updating, at every size', () => {
  if (!inChild) return

  test('large: the full cover, the mark, the sentence, the address as small print', async () => {
    await draw(UPDATING, { width: 480, height: 400 })
    expect(layout()).toBe('full')
    const cover = document.querySelector('[data-testid="module-cover"]')!
    expect(cover.getAttribute('data-state')).toBe('updating')
    /* The module's own icon, not Kehikot's mark. */
    expect(cover.querySelector('[data-cover-icon="kehikot.example"] [data-module-icon="lucide:route"]')).not.toBeNull()
    expect(cover.querySelector('.kehikko-mark')).toBeNull()
    expect(cover.textContent).toContain('Updating — restarting on the new code…')
    expect(cover.querySelector('p.font-mono')!.textContent).toBe(AT)
  })

  test('small: the mark small and one line; the address only in the tooltip', async () => {
    await draw(UPDATING, { width: 480, height: 120 })
    expect(layout()).toBe('small')
    expect(document.querySelector('[data-cover-layout] [data-cover-icon]')!.getAttribute('class')).toContain('size-6')
    const line = document.querySelector<HTMLElement>('[data-testid="standing-sentence"]')!
    expect(line.className).toContain('truncate')
    expect(line.textContent).toBe('Updating — restarting on the new code…')
    expect(bodyText()).not.toContain(AT)
    expect(line.title).toContain(AT)
  })

  test('two rows or tiny: one line, the tiny mark and the word', async () => {
    await draw(UPDATING, { width: 480, height: 56 })
    expect(layout()).toBe('line')
    expect(document.querySelector('[data-testid="standing-word"]')!.textContent).toBe('Updating')
    expect(document.querySelector('[data-cover-layout] [data-cover-icon]')!.getAttribute('class')).toContain('size-4')
    expect(bodyText()).not.toContain(AT)
  })

  test('folded: no body at all, and the header says Updating with the mark', async () => {
    await draw(UPDATING, 'folded')
    expect(document.querySelector('[data-body]')).toBeNull()
    expect(layout()).toBeNull()
    const chip = document.querySelector<HTMLElement>('header [data-testid="standing-chip"]')!
    expect(chip.textContent).toBe('Updating')
    expect(chip.querySelector('[data-cover-icon="kehikot.example"]')).not.toBeNull()
    expect(chip.getAttribute('aria-label')).toContain('Updating — restarting on the new code…')
    /* Nothing to press while it updates: no state rows in the Container menu. */
    const menu = await openFrame()
    expect(menu.querySelector('[data-frame="standing"]')).toBeNull()
  })
})

describe('a restart that failed, at every size', () => {
  if (!inChild) return

  test('large: the sentence, what it printed, and Retry', async () => {
    let pressed = 0
    await draw(FAILED, { width: 480, height: 400 }, () => pressed++)
    expect(layout()).toBe('full')
    expect(bodyText()).toContain('The restart did not bring it back.')
    expect(document.querySelector('[data-testid="condition-detail"]')!.textContent).toContain('port in use')
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Retry'))!
    await act(async () => retry.click())
    expect(pressed).toBe(1)
  })

  test('small: one line and the Retry button; the log and address in the tooltip', async () => {
    let pressed = 0
    await draw(FAILED, { width: 200, height: 400 }, () => pressed++)
    expect(layout()).toBe('small')
    expect(bodyText()).not.toContain('port in use')
    expect(bodyText()).not.toContain(AT)
    const line = document.querySelector<HTMLElement>('[data-testid="standing-sentence"]')!
    expect(line.title).toContain('port in use')
    const retry = document.querySelector<HTMLButtonElement>('[data-standing-action="retry"]')!
    await act(async () => retry.click())
    expect(pressed).toBe(1)
  })

  test('two rows or tiny: Failed and Retry as an icon button', async () => {
    let pressed = 0
    await draw(FAILED, { width: 300, height: 40 }, () => pressed++)
    expect(layout()).toBe('line')
    expect(document.querySelector('[data-testid="standing-word"]')!.textContent).toBe('Failed')
    const retry = document.querySelector<HTMLButtonElement>('[data-standing-action="retry"]')!
    expect(retry.getAttribute('aria-label')).toBe('Retry restart')
    expect(retry.textContent).toBe('')
    await act(async () => retry.click())
    expect(pressed).toBe(1)
  })

  test('folded: Failed in the header, and Retry and Show details first in the Container menu', async () => {
    let pressed = 0
    await draw(FAILED, 'folded', () => pressed++)
    expect(document.querySelector('[data-body]')).toBeNull()
    const chip = document.querySelector<HTMLElement>('header [data-testid="standing-chip"]')!
    expect(chip.textContent).toBe('Failed')
    expect(chip.getAttribute('data-tone')).toBe('failed')
    const menu = await openFrame()
    const group = menu.querySelector('[data-frame="standing"]')!
    expect([...group.querySelectorAll('[data-standing]')].map((row) => row.getAttribute('data-standing'))).toEqual(['retry', 'details'])
    /* First of the Container rows. */
    expect(menu.querySelector('[data-frame]')).toBe(group)
    await act(async () => group.querySelector<HTMLElement>('[data-standing="retry"]')!.click())
    expect(pressed).toBe(1)
  })
})

describe('loading, in the module\'s own words (protocol 2.84.0)', () => {
  if (!inChild) return

  test('the first greeting\'s cover: the module\'s icon and its words', async () => {
    await draw({ kind: 'cover', state: 'loading', label: 'Loading the plan…' }, { width: 480, height: 400 })
    const cover = document.querySelector('[data-testid="module-cover"]')!
    expect(cover.querySelector('[data-cover-icon="kehikot.example"]')).not.toBeNull()
    expect(cover.textContent).toContain('Loading the plan…')
  })

  test('without words of its own: "Loading <module>…"', async () => {
    await draw({ kind: 'cover', state: 'loading' }, { width: 480, height: 120 })
    expect(document.querySelector('[data-testid="standing-sentence"]')!.textContent).toBe('Loading Example…')
  })

  test('after a context change: the same cover over the page, which is still the page', async () => {
    await draw({ kind: 'page' }, { width: 480, height: 400 }, nothing, { label: null })
    const veil = document.querySelector('[data-testid="loading-cover"]')!
    expect(veil).not.toBeNull()
    expect(veil.querySelector('[data-cover-icon="kehikot.example"]')).not.toBeNull()
    expect(veil.textContent).toContain('Loading Example…')
    /* Drawn: no cover. */
    act(() => unmount?.())
    unmount = null
    document.body.innerHTML = ''
    await draw({ kind: 'page' }, { width: 480, height: 400 })
    expect(document.querySelector('[data-testid="loading-cover"]')).toBeNull()
    expect(document.querySelector('[data-testid="module-cover"]')).toBeNull()
  })

  test('too narrow for words: the icon alone, the words its name and tooltip', async () => {
    await draw({ kind: 'cover', state: 'loading', label: 'Loading the plan…' }, { width: 100, height: 400 })
    expect(layout()).toBe('icon')
    const cover = document.querySelector<HTMLElement>('[data-testid="module-cover"]')!
    expect(cover.getAttribute('aria-label')).toBe('Loading the plan…')
    expect(cover.title).toContain('Loading the plan…')
    expect(document.querySelector('[data-cover-layout] p')).toBeNull()
    expect(cover.querySelector('[data-cover-icon="kehikot.example"]')).not.toBeNull()
  })
})
