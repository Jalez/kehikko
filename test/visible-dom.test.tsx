import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A kept page told whether it is on screen (protocol 2.45.0), rendered: the
 * layer of pages hides a page whose module is not on the open kehikko, or
 * whose container is folded, with CSS — which fires no `visibilitychange`
 * inside the frame — so the frame tells the page itself, when it is hidden
 * and when it is shown again.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.VISIBLE_DOM === '1'
const TESTS = 3

if (!inChild) {
  test('a kept page told whether it is on screen, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, VISIBLE_DOM: '1' },
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
let Talk: typeof import('../src/host/conversation.ts')
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
  Talk = await import('../src/host/conversation.ts')
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

describe('the layer of pages', () => {
  if (!inChild) return

  /* What each frame asked its conversation to tell the page, in order. */
  function listen() {
    const told: boolean[] = []
    const was = Talk.Conversation.prototype.sendVisible
    Talk.Conversation.prototype.sendVisible = function (visible) {
      told.push(visible)
      return was.call(this, visible)
    }
    return { told, restore: () => (Talk.Conversation.prototype.sendVisible = was) }
  }

  async function layer() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const render = async (over: Partial<import('../src/canvas/Frames.tsx').Framing>) => {
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
          />,
        )
      })
    }
    unmount = () => root.unmount()
    return { render, frame: () => host.querySelector<HTMLElement>('[data-frame]')! }
  }

  test('a page on the open kehikko is on screen; the person leaving hides it and tells it so, coming back shows it and tells it so', async () => {
    const { told, restore } = listen()
    try {
      const { render, frame } = await layer()
      await render({})
      expect(told.at(-1)).toBe(true)
      expect(frame().style.visibility).toBe('visible')
      /* The person went to a kehikko this module is not on: kept, hidden. */
      await render({ away: true, shown: false })
      expect(frame().style.visibility).toBe('hidden')
      expect(told.at(-1)).toBe(false)
      /* And back. */
      await render({})
      expect(told.at(-1)).toBe(true)
      expect(told.filter((one, i) => i === 0 || one !== told[i - 1])).toEqual([true, false, true])
    } finally {
      restore()
    }
  })

  test('a folded container, or one with nowhere on screen, hides its page as well', async () => {
    const { told, restore } = listen()
    try {
      const { render } = await layer()
      await render({ shown: false })
      expect(told.at(-1)).toBe(false)
      await render({ shown: true, rect: null })
      expect(told.at(-1)).toBe(false)
      await render({ shown: true, rect })
      expect(told.at(-1)).toBe(true)
    } finally {
      restore()
    }
  })

  test('a page that stays on screen is never told it is hidden when something else about it changes', async () => {
    const { told, restore } = listen()
    try {
      const { render } = await layer()
      await render({})
      await render({ prompt: 'something else' })
      await render({ rect: { ...rect, width: 500 } })
      await render({ pinned: true })
      expect(told.length).toBeGreaterThan(0)
      expect(told.every((one) => one)).toBe(true)
    } finally {
      restore()
    }
  })
})
