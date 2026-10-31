import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import type { Pressed, Pressing } from '../src/host/header.ts'

/*
 * A module's declared footer (protocol 2.38.0), rendered: each kind drawn as
 * text, the narrow widths, a press and the arm of a confirmed run, no row for
 * a module that declared nothing or a folded container — and, in focus mode,
 * the header and footer revealed by the pointer anywhere over the container
 * and by focus within it.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.FOOTER_DOM === '1'
const TESTS = 8

if (!inChild) {
  test('the footer, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, FOOTER_DOM: '1' },
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
let Box: typeof import('../src/canvas/Container.tsx')
let Reveal: typeof import('../src/host/reveal.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

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
  Box = await import('../src/canvas/Container.tsx')
  Reveal = await import('../src/host/reveal.ts')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
let width: number | null = null
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  width = null
  document.body.innerHTML = ''
})


const agent = (): FooterItem[] =>
  footerItemsSchema.parse([
    { kind: 'text', id: 'model', text: '<b>Opus</b> · high' },
    { kind: 'meter', id: 'context', label: 'Context', value: 0.92, level: 'critical', text: '184k / 200k' },
    { kind: 'meter', id: 'usage', label: 'Usage', value: 0.3, align: 'center', optional: true },
    { kind: 'run', id: 'compact', label: 'Compact', icon: 'refresh', align: 'end' },
    { kind: 'run', id: 'clear', label: 'Clear', icon: 'x', align: 'end', confirm: true },
  ])

const item = (id: string) => document.querySelector<HTMLElement>(`[data-footer-item="${id}"]`)

async function bar(items: FooterItem[]) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const presses: Pressing[] = []
  const onPress = async (press: Pressing): Promise<Pressed> => {
    presses.push(press)
    return { ok: true, why: '' }
  }
  await act(async () => {
    root.render(
      <TooltipProvider>
        <Bar.FooterBar items={items} name="Claude" onPress={onPress} />
      </TooltipProvider>,
    )
  })
  unmount = () => root.unmount()
  return { host, presses }
}

describe('the row', () => {
  if (!inChild) return

  test('each kind is drawn, and a module’s words are text, never markup', async () => {
    const { host } = await bar(agent())
    expect(item('model')!.textContent).toBe('<b>Opus</b> · high')
    expect(host.querySelector('b')).toBeNull()
    const meter = item('context')!
    expect(meter.getAttribute('role')).toBe('meter')
    expect(meter.getAttribute('aria-valuetext')).toBe('184k / 200k (critical)')
    expect(meter.querySelector('[data-level="critical"]')).not.toBeNull()
    expect(item('compact')!.textContent).toContain('Compact')
    expect(host.querySelector('[data-footer-group="center"] [data-footer-item="usage"]')).not.toBeNull()
    expect(host.querySelector('[data-footer-overflow]')).toBeNull()
  })

  test('a run is pressed by its id; a confirmed run arms on the first press and runs on the second', async () => {
    const { presses } = await bar(agent())
    await act(async () => item('compact')!.click())
    expect(presses).toEqual([{ item: 'compact' }])
    await act(async () => item('clear')!.click())
    expect(item('clear')!.getAttribute('data-armed')).toBe('true')
    expect(presses).toHaveLength(1)
    await act(async () => item('clear')!.click())
    expect(presses).toEqual([{ item: 'compact' }, { item: 'clear' }])
  })

  test('at 280 px the optional meter goes and runs are their icons; at 200 px every run is in ⋯', async () => {
    width = 280
    const { host } = await bar(agent())
    expect(host.firstElementChild?.getAttribute('data-footer-mode')).toBe('icons')
    expect(item('usage')).toBeNull()
    expect(item('compact')!.textContent).toBe('')
    expect(item('compact')!.getAttribute('aria-label')).toBe('Compact')
    act(() => unmount?.())
    width = 200
    const narrow = await bar(agent())
    expect(narrow.host.firstElementChild?.getAttribute('data-footer-mode')).toBe('merged')
    expect(item('compact')).toBeNull()
    expect(narrow.host.querySelector('[data-footer-overflow]')).not.toBeNull()
  })
})

describe('in the container', () => {
  if (!inChild) return

  const presence = {
    id: 'kehikot.claude',
    at: 'http://127.0.0.1:7870',
    condition: 'ready',
    reached: true,
    name: 'Claude',
    line: '',
    agent: { kind: 'untold' },
  } as unknown as import('../src/host/registry.ts').Presence

  async function container(over: { footer?: FooterItem[]; collapsed?: boolean; reveals?: import('../src/host/reveal.ts').Reveals | null } = {}) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const nothing = () => {}
    await act(async () => {
      root.render(
        <TooltipProvider>
          <Box.Container
            presence={presence}
            showing={{ kind: 'page' }}
            fault={null}
            body={nothing}
            grow={false}
            onGrow={nothing}
            pinned={false}
            onPin={nothing}
            collapsed={over.collapsed ?? false}
            onCollapse={nothing}
            footer={over.footer}
            reveals={over.reveals ?? null}
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
            onSkills={nothing}
            onStarted={nothing}
            onRemove={nothing}
            kehikko="thesis"
            epic={null}
          />
        </TooltipProvider>,
      )
    })
    unmount = () => root.unmount()
    return host
  }

  test('a declared footer is a row at the bottom, after the body; none declared and [] draw no row', async () => {
    let host = await container({ footer: agent() })
    const column = [...host.querySelector('[data-module]')!.children]
    const body = column.findIndex((one) => one.hasAttribute('data-body'))
    const footer = column.findIndex((one) => one.classList.contains('container-footer-reveal'))
    expect(body).toBeGreaterThan(0)
    expect(footer).toBe(body + 1)
    act(() => unmount?.())
    host = await container()
    expect(host.querySelector('.container-footer-reveal')).toBeNull()
    act(() => unmount?.())
    host = await container({ footer: [] })
    expect(host.querySelector('.container-footer-reveal')).toBeNull()
  })

  test('a folded container is its header only: no footer', async () => {
    const host = await container({ footer: agent(), collapsed: true })
    expect(host.querySelector('.container-footer-reveal')).toBeNull()
    expect(host.querySelector('[data-body]')).toBeNull()
  })

  test('focus mode: the pointer over the container reveals header and footer together, and leaving hides them', async () => {
    const reveals = new Reveal.Reveals(5, 20)
    const host = await container({ footer: agent(), reveals })
    const root = host.querySelector<HTMLElement>('[data-module]')!
    const header = host.querySelector('.container-reveal')!
    const footer = host.querySelector('.container-footer-reveal')!
    expect(header.hasAttribute('data-revealed')).toBe(false)
    await act(async () => {
      root.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(header.getAttribute('data-revealed')).toBe('true')
    expect(footer.getAttribute('data-revealed')).toBe('true')
    await act(async () => {
      root.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    expect(header.hasAttribute('data-revealed')).toBe(false)
    expect(footer.hasAttribute('data-revealed')).toBe(false)
  })

  test('focus mode: the pointer over the module’s page — the frame in the other layer — reveals them too', async () => {
    const reveals = new Reveal.Reveals(5, 20)
    const host = await container({ footer: agent(), reveals })
    const frame = Reveal.revealHandlers(reveals, 'kehikot.claude', 'frame') as { onPointerEnter(): void }
    await act(async () => {
      frame.onPointerEnter()
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(host.querySelector('.container-footer-reveal')!.getAttribute('data-revealed')).toBe('true')
  })

  test('focus mode: keyboard focus within the container reveals them', async () => {
    const reveals = new Reveal.Reveals(5, 20)
    const host = await container({ footer: agent(), reveals })
    await act(async () => {
      host.querySelector<HTMLElement>('[data-footer-item="compact"]')!.focus()
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(host.querySelector('.container-reveal')!.getAttribute('data-revealed')).toBe('true')
  })
})
