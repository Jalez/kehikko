import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A container shown large and put back (protocol 2.58.0, `host/expand.ts`), rendered: the page is
 * the SAME iframe throughout — moved to the large panel's rectangle and raised over the canvas, then
 * back — never a new document, and nothing about the arrangement is asked for.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.EXPAND_DOM === '1'
const TESTS = 2

if (!inChild) {
  test('a container shown large and put back, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, EXPAND_DOM: '1' },
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
let Layer: typeof import('../src/canvas/Frames.tsx')
let Press: typeof import('../src/host/presses.ts')
let Ctx: typeof import('../src/host/context.ts')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Layer = await import('../src/canvas/Frames.tsx')
  Press = await import('../src/host/presses.ts')
  Ctx = await import('../src/host/context.ts')
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

const nothing = () => {}
/* Anything asked of it does nothing: the watcher and the canvas are not what is under test. */
const inert = <T,>() => new Proxy({}, { get: () => nothing }) as T

const module = {
  id: 'kehikot.example',
  name: 'Example',
  version: '1.0.0',
  summary: '',
  entry: 'http://127.0.0.1:7999/',
  icon: null,
  health: null,
  mcp: null,
  modes: [{ id: 'main', label: 'Main', scope: 'project' }],
  extensions: { emits: [], consumes: [] },
  declares: { uses: [] },
} as unknown as import('../src/host/registry.ts').FramedModule

const rect = { x: 0, y: 0, width: 400, height: 300 }

describe('the page of a container shown large', () => {
  if (!inChild) return

  async function layer() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const render = async (over: Partial<import('../src/canvas/Frames.tsx').Framing>, raised: string | null = null) => {
      const framing: import('../src/canvas/Frames.tsx').Framing = {
        module,
        generation: 0,
        rect,
        shown: true,
        away: false,
        state: null,
        pinned: false,
        prompt: null,
        filters: {},
        scope: { level: 'project' } as unknown as import('kehikot-module-protocol').ModuleScope,
        covers: null,
        ...over,
      }
      await act(async () => {
        root.render(
          <Layer.Frames
            framings={[framing]}
            context={Ctx.toWireContext({ epic: null, project: null }, 'light')}
            canvas={inert()}
            bus={{ join: nothing, leave: nothing } as unknown as import('../src/host/events.ts').EventBus}
            presses={new Press.Presses()}
            watcherFor={() => inert()}
            onDocument={nothing}
            moving={null}
            raised={raised}
          />,
        )
      })
    }
    unmount = () => root.unmount()
    return { render, frame: () => host.querySelector<HTMLElement>('[data-frame]')!, iframe: () => host.querySelector('iframe')! }
  }

  test('expanded: the same iframe, moved to the panel and raised; put back: the same iframe where it was', async () => {
    const { render, frame, iframe } = await layer()
    const small = { x: 20, y: 40, width: 150, height: 150 }
    const large = { x: 100, y: 60, width: 1100, height: 700 }
    await render({ rect: small })
    const first = iframe()
    expect(first).not.toBeNull()
    expect(frame().style.zIndex).toBe('')
    await render({ rect: large }, module.id)
    expect(iframe()).toBe(first)
    expect(frame().style.transform).toBe('translate(100px, 60px)')
    expect(frame().style.width).toBe('1100px')
    expect(frame().style.zIndex).toBe('41')
    await render({ rect: small })
    expect(iframe()).toBe(first)
    expect(frame().style.transform).toBe('translate(20px, 40px)')
    expect(frame().style.zIndex).toBe('')
  })

  test('only the expanded page is raised', async () => {
    const { render, frame } = await layer()
    await render({}, 'kehikot.other')
    expect(frame().style.zIndex).toBe('')
  })
})
