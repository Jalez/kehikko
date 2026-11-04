import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import type { Pressed, Pressing } from '../src/host/header.ts'

/*
 * A field in a module's declared footer (protocol 2.46.0), rendered: a real
 * input with the module's value, the person's text kept while it has focus
 * and dropped when it loses it, Enter submitting and handing the keyboard to
 * the module's page, Escape reverting, no key reaching the host's chords, and
 * the field in the row at 380, 280 and 200 pixels.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.FOOTER_FIELD_DOM === '1'
const TESTS = 8

if (!inChild) {
  test('the footer field, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, FOOTER_FIELD_DOM: '1' },
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
let Bar: typeof import('../src/canvas/FooterBar.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

let width: number | null = null
beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  /* The row measures its own width; happy-dom lays nothing out, so a test says the width. */
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).getAttribute?.('role') === 'toolbar' && width !== null ? width : 0
    },
  })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Bar = await import('../src/canvas/FooterBar.tsx')
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
  width = null
  document.body.innerHTML = ''
})

const viewer = (value = 'https://example.com/'): FooterItem[] =>
  footerItemsSchema.parse([
    { kind: 'run', id: 'back', label: 'Back', icon: 'arrow-left' },
    { kind: 'input', id: 'address', label: 'Address', value, placeholder: 'Type an address', grow: true },
    { kind: 'run', id: 'reload', label: 'Reload', icon: 'refresh', align: 'end' },
  ])

const field = () => document.querySelector<HTMLInputElement>('[data-footer-item="address"]')!

async function bar(items: FooterItem[], answer: Pressed = { ok: true, why: '' }) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const presses: Pressing[] = []
  let keyboard = 0
  const onPress = async (press: Pressing): Promise<Pressed> => {
    presses.push(press)
    return answer
  }
  const draw = async (now: FooterItem[]) =>
    act(async () => {
      root.render(
        <TooltipProvider>
          <Bar.FooterBar items={now} name="Viewer" onPress={onPress} onKeyboard={() => void keyboard++} />
        </TooltipProvider>,
      )
    })
  await draw(items)
  unmount = () => root.unmount()
  return { host, presses, redraw: draw, keyboard: () => keyboard }
}

/* As a person types: the value set the way the browser sets it, then the input event React listens for. */
async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function key(input: HTMLInputElement, name: string, more: KeyboardEventInit = {}) {
  let event!: KeyboardEvent
  await act(async () => {
    event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...more })
    input.dispatchEvent(event)
  })
  await act(async () => {})
  return event
}

describe('the field', () => {
  if (!inChild) return

  test('is a real input with the module’s value, its label as its name, and markup in it kept as text', async () => {
    const { host } = await bar(viewer('<b>not bold</b>'))
    const input = field()
    expect(input.tagName).toBe('INPUT')
    expect(input.type).toBe('text')
    expect(input.getAttribute('aria-label')).toBe('Address')
    expect(input.getAttribute('placeholder')).toBe('Type an address')
    expect(input.value).toBe('<b>not bold</b>')
    expect(host.querySelector('b')).toBeNull()
    expect(input.getAttribute('data-grow')).toBe('true')
    expect(input.className).toContain('flex-1')
    expect(input.className).toContain('min-w-0')
  })

  test('keeps what the person typed while it has focus, whatever the module declares meanwhile', async () => {
    const { redraw } = await bar(viewer())
    await type(field(), 'https://exa')
    await redraw(viewer('https://example.com/elsewhere'))
    expect(field().value).toBe('https://exa')
  })

  test('shows the module’s value again when it loses focus without a submit, and sends nothing', async () => {
    const { presses, redraw } = await bar(viewer())
    await type(field(), 'half typed')
    await redraw(viewer('https://example.com/now'))
    await act(async () => field().blur())
    expect(field().value).toBe('https://example.com/now')
    expect(presses).toEqual([])
  })

  test('Enter submits the typed text, and the keyboard goes to the module’s page', async () => {
    const { presses, keyboard } = await bar(viewer())
    await type(field(), 'https://example.org/')
    const event = await key(field(), 'Enter')
    expect(event.defaultPrevented).toBe(true)
    expect(presses).toEqual([{ item: 'address', text: 'https://example.org/' }])
    expect(keyboard()).toBe(1)
    /* Taken: the draft is gone, and the field shows what the module holds. */
    expect(field().value).toBe('https://example.com/')
  })

  test('a submit that is not taken keeps the text and the keyboard, and says why', async () => {
    const { presses, keyboard, host } = await bar(viewer(), { ok: false, why: 'That is not an address.' })
    await type(field(), 'nonsense')
    await key(field(), 'Enter')
    expect(presses).toEqual([{ item: 'address', text: 'nonsense' }])
    expect(keyboard()).toBe(0)
    expect(field().value).toBe('nonsense')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(host.querySelector('[role="status"]')!.textContent).toBe('That is not an address.')
  })

  test('Escape puts the module’s value back and sends nothing', async () => {
    const { presses } = await bar(viewer())
    await type(field(), 'something else')
    await key(field(), 'Escape')
    expect(field().value).toBe('https://example.com/')
    expect(presses).toEqual([])
  })

  test('no key typed in it reaches the host’s chords', async () => {
    await bar(viewer())
    const heard: string[] = []
    const listen = (event: KeyboardEvent) => void heard.push(event.key)
    window.addEventListener('keydown', listen)
    document.addEventListener('keydown', listen)
    try {
      await key(field(), 'N', { altKey: true, shiftKey: true, code: 'KeyN' })
      await key(field(), ',', { metaKey: true })
      await key(field(), 'Escape')
      await key(field(), 'Enter')
      expect(heard).toEqual([])
    } finally {
      window.removeEventListener('keydown', listen)
      document.removeEventListener('keydown', listen)
    }
  })

  test('is in the row at 380, 280 and 200 pixels, beside the runs or their ⋯', async () => {
    for (const at of [380, 280, 200]) {
      width = at
      const { host } = await bar(viewer())
      expect(host.querySelector('[data-footer-group="start"] [data-footer-item="address"]')).not.toBeNull()
      expect(host.firstElementChild?.getAttribute('data-footer-mode')).toBe(at === 380 ? 'words' : at === 280 ? 'icons' : 'merged')
      if (at === 200) expect(host.querySelector('[data-footer-overflow]')).not.toBeNull()
      act(() => unmount?.())
      unmount = null
      document.body.innerHTML = ''
    }
  })
})
