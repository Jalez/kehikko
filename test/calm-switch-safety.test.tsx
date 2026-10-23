import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The canvas is never left inert by a switch. `useCalmSwitch` driven in a DOM
 * where nothing it waits for ever comes: no animation frame is painted (a
 * window the system stopped painting), and the incoming kehikko never becomes
 * readable (`ready` stays false). It must still be shown, and take input, by
 * the deadline (`deadline` in `host/switching.ts`) — on the first load and
 * after a switch.
 *
 * In a process of its own for the reason `parts-pressed.test.tsx` gives.
 */

const inChild = process.env.CALM_SWITCH_SAFETY_DOM === '1'

if (!inChild) {
  test('the calm switch, with no frames and nothing ready, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CALM_SWITCH_SAFETY_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(/\b3 pass/)
  }, 60_000)
}

type Calm = ReturnType<typeof import('../src/canvas/useCalmSwitch.ts').useCalmSwitch>

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let useCalmSwitch: typeof import('../src/canvas/useCalmSwitch.ts').useCalmSwitch
let TIMING: typeof import('../src/host/switching.ts').TIMING

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  /* No frame is ever painted. */
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useCalmSwitch } = await import('../src/canvas/useCalmSwitch.ts'))
  ;({ TIMING } = await import('../src/host/switching.ts'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const ceiling = () => TIMING.capMs + TIMING.leaveMs + TIMING.arriveMs + 120

async function mount(ready: boolean): Promise<{ calm: () => Calm; root: import('react-dom/client').Root }> {
  let latest: Calm | null = null
  function Probe() {
    latest = useCalmSwitch({ ready, framings: [] })
    return React.createElement('div', { ref: latest.incomingRef, inert: !latest.interactive, 'data-switch': latest.phase })
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(Probe)))
  return { calm: () => latest!, root }
}

describe.skipIf(!inChild)('the canvas is never left inert', () => {
  test('the first load: nothing ready, no frames — shown and taking input by the deadline', async () => {
    const { calm, root } = await mount(false)
    expect(calm().phase).toBe('preparing')
    expect(calm().interactive).toBe(false)
    expect(document.querySelector('[data-switch]')?.hasAttribute('inert')).toBe(true)
    await act(async () => sleep(ceiling()))
    expect(calm().interactive).toBe(true)
    expect(calm().phase).toBe('shown')
    expect(document.querySelector('[data-switch]')?.hasAttribute('inert')).toBe(false)
    await act(async () => root.unmount())
    document.body.replaceChildren()
  })

  test('a switch: interactive within the cap, shown by the deadline', async () => {
    const { calm, root } = await mount(true)
    await act(async () => sleep(ceiling()))
    expect(calm().phase).toBe('shown')
    await act(async () => calm().leaving())
    expect(calm().interactive).toBe(false)
    expect(calm().pagesStill).toBe(true)
    await act(async () => sleep(TIMING.capMs + 60))
    expect(calm().interactive).toBe(true)
    await act(async () => sleep(TIMING.leaveMs + TIMING.arriveMs + 120))
    expect(calm().phase).toBe('shown')
    expect(calm().pagesStill).toBe(false)
    expect(document.querySelector('[data-switch]')?.hasAttribute('inert')).toBe(false)
    await act(async () => root.unmount())
    document.body.replaceChildren()
  })

  test('presses in a row: the newest press restarts the cap, and the last still ends taking input', async () => {
    const { calm, root } = await mount(true)
    await act(async () => sleep(ceiling()))
    for (let i = 0; i < 4; i += 1) {
      await act(async () => calm().leaving())
      await act(async () => sleep(100))
      expect(calm().interactive).toBe(false)
    }
    await act(async () => sleep(ceiling()))
    expect(calm().phase).toBe('shown')
    expect(calm().interactive).toBe(true)
    await act(async () => root.unmount())
    document.body.replaceChildren()
  })
})
