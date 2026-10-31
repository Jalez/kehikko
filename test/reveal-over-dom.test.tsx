import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * Focus mode's reveal for a module that says `reveal: 'over'` (protocol
 * 2.42.0), rendered: its container is marked so the stylesheet draws the rows
 * OVER the page, and its frame tells the page what the rows cover — while a
 * module that is pushed is told nothing at all. Nothing here resizes a frame:
 * that is what the bee drive (`dev/focus-reveal.drive.mjs`) measures in real
 * engines.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.REVEAL_OVER_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('the over reveal, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, REVEAL_OVER_DOM: '1' },
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
let Frame: typeof import('../src/canvas/ModuleFrame.tsx')
let Talk: typeof import('../src/host/conversation.ts')
let Reveal: typeof import('../src/host/reveal.ts')
let Press: typeof import('../src/host/presses.ts')
let Ctx: typeof import('../src/host/context.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Box = await import('../src/canvas/Container.tsx')
  Frame = await import('../src/canvas/ModuleFrame.tsx')
  Talk = await import('../src/host/conversation.ts')
  Reveal = await import('../src/host/reveal.ts')
  Press = await import('../src/host/presses.ts')
  Ctx = await import('../src/host/context.ts')
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

const nothing = () => {}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/* Anything asked of it does nothing: the watcher and the canvas are not what is under test. */
const inert = <T,>() => new Proxy({}, { get: () => nothing }) as T

const module = (reveal?: 'over' | 'push') =>
  ({
    id: 'kehikot.terminal',
    name: 'Terminal',
    version: '1.5.0',
    summary: '',
    entry: 'http://127.0.0.1:7999/',
    icon: null,
    health: null,
    mcp: null,
    modes: [{ id: 'main', label: 'Main', scope: 'project' }],
    extensions: { emits: [], consumes: [] },
    declares: { uses: [] },
    ...(reveal ? { reveal } : {}),
  }) as unknown as import('../src/host/registry.ts').FramedModule

describe('the container', () => {
  if (!inChild) return

  async function container(reveal?: 'over' | 'push') {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const presence = {
      id: 'kehikot.terminal',
      at: 'http://127.0.0.1:7999',
      condition: 'ready',
      reached: true,
      name: 'Terminal',
      line: '',
      agent: { kind: 'untold' },
      module: module(reveal),
    } as unknown as import('../src/host/registry.ts').Presence
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
            collapsed={false}
            onCollapse={nothing}
            reveals={new Reveal.Reveals(5, 20)}
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
    return host.querySelector<HTMLElement>('[data-module]')!
  }

  test('a module that says over is marked for the stylesheet; one that says push or nothing is not', async () => {
    expect((await container('over')).getAttribute('data-reveal')).toBe('over')
    act(() => unmount?.())
    expect((await container('push')).hasAttribute('data-reveal')).toBe(false)
    act(() => unmount?.())
    expect((await container()).hasAttribute('data-reveal')).toBe(false)
  })
})

describe('the frame', () => {
  if (!inChild) return

  /* What the frame asked its conversation to tell the page, in order. */
  function listen() {
    const told: { top: number; bottom: number }[] = []
    const was = Talk.Conversation.prototype.sendCovered
    Talk.Conversation.prototype.sendCovered = function (covered) {
      told.push({ ...covered })
      return was.call(this, covered)
    }
    return { told, restore: () => (Talk.Conversation.prototype.sendCovered = was) }
  }

  async function frame(reveals: import('../src/host/reveal.ts').Reveals | null, covers: import('../src/host/reveal.ts').Covers | null, reveal?: 'over') {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <Frame.ModuleFrame
          module={module(reveal)}
          context={Ctx.toWireContext({ epic: null, project: null }, 'light')}
          canvas={inert()}
          bus={{ join: nothing, leave: nothing } as unknown as import('../src/host/events.ts').EventBus}
          presses={new Press.Presses()}
          watcher={inert()}
          state={null}
          pinned={false}
          prompt={null}
          filters={{}}
          reveals={reveals}
          covers={covers}
        />,
      )
    })
    unmount = () => root.unmount()
  }

  test('an over page is told the rows cover its top and bottom while revealed, and nothing once they hide', async () => {
    const { told, restore } = listen()
    try {
      const reveals = new Reveal.Reveals(5, 20)
      await frame(reveals, { header: true, footer: true }, 'over')
      await act(async () => {
        reveals.hold('kehikot.terminal', 'frame', true)
        await wait(30)
      })
      await act(async () => {
        reveals.hold('kehikot.terminal', 'frame', false)
        await wait(60)
      })
      const row = Reveal.REVEAL_ROW_PX
      expect(told.filter((one) => one.top || one.bottom)).toEqual([{ top: row, bottom: row }])
      expect(told.at(-1)).toEqual({ top: 0, bottom: 0 })
    } finally {
      restore()
    }
  })

  test('a selected container keeps its header in the column, so only the footer covers; no footer, nothing below', async () => {
    const { told, restore } = listen()
    try {
      const reveals = new Reveal.Reveals(5, 20)
      await frame(reveals, { header: false, footer: true }, 'over')
      await act(async () => {
        reveals.hold('kehikot.terminal', 'frame', true)
        await wait(30)
      })
      expect(told.at(-1)).toEqual({ top: 0, bottom: Reveal.REVEAL_ROW_PX })
      act(() => unmount?.())
      unmount = null
      await frame(reveals, { header: true, footer: false }, 'over')
      expect(told.at(-1)).toEqual({ top: Reveal.REVEAL_ROW_PX, bottom: 0 })
    } finally {
      restore()
    }
  })

  test('a pushed page is never told anything is covered, however long it is revealed', async () => {
    const { told, restore } = listen()
    try {
      const reveals = new Reveal.Reveals(5, 20)
      await frame(reveals, null)
      await act(async () => {
        reveals.hold('kehikot.terminal', 'frame', true)
        await wait(30)
      })
      expect(reveals.revealed('kehikot.terminal')).toBe(true)
      expect(told.every((one) => one.top === 0 && one.bottom === 0)).toBe(true)
    } finally {
      restore()
    }
  })
})
