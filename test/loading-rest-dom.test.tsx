import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test'

/*
 * The app's loading effect: the feedback list while it is read (spinner,
 * `role="status"`, label, skeleton rows), the slow-answer line after 8 s with
 * its way out, and a sample of the other waits that used to be words alone.
 *
 * In a process of its own, as `whats-new-dom.test.tsx` explains.
 */

const inChild = process.env.LOADING_REST_DOM === '1'
const TESTS = 3

if (!inChild) {
  test('the rest of the waits look alive, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, LOADING_REST_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 120_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Refreshing: typeof import('../src/canvas/Refreshing.tsx')
let Loading: typeof import('../src/components/ui/loading.tsx')
let Tooltip: typeof import('../src/components/ui/tooltip.tsx')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Refreshing = await import('../src/canvas/Refreshing.tsx')
  Loading = await import('../src/components/ui/loading.tsx')
  Tooltip = await import('../src/components/ui/tooltip.tsx')
})

afterAll(async () => {
  if (!inChild) return
  jest.useRealTimers()
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
})

async function render(node: React.ReactElement) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const made = createRoot(root)
  await act(async () => made.render(node))
  unmount = () => made.unmount()
}

describe.skipIf(!inChild)('the rest of the waits', () => {
  test('the loader sits inside a paragraph or a button without a block element', async () => {
    await render(
      <div>
        <p id="p"><Loading.Loading label="Reading…" /></p>
        <button id="b" type="button"><Loading.Loading label="Reading…" iconClassName="size-3" /></button>
      </div>,
    )
    for (const id of ['p', 'b']) {
      const host = document.getElementById(id)!
      expect(host.querySelector('div')).toBeNull()
      expect(host.querySelector('[role="status"] svg')?.getAttribute('class')).toContain('motion-safe:animate-spin')
    }
  })

  test('a refresh that is reading turns the button and the menu item, both motion-safe', async () => {
    const state = { can: true, busy: true, at: null } as unknown as Parameters<typeof Refreshing.RefreshButton>[0]['state']
    await render(
      <Tooltip.TooltipProvider>
        <Refreshing.RefreshButton name="Paper" state={state} every={null} onRefresh={() => {}} onEvery={() => {}} />
      </Tooltip.TooltipProvider>,
    )
    const trigger = document.querySelector('button[aria-label^="refresh what"]') as HTMLElement
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('motion-safe:animate-spin')
    await act(async () => {
      trigger.dispatchEvent(new (globalThis as any).PointerEvent('pointerdown', { button: 0, ctrlKey: false, bubbles: true }))
    })
    const item = document.querySelector('[role="menuitem"][data-disabled]')
    expect(item?.querySelector('[role="status"] svg')).not.toBeNull()
    expect(item?.textContent).toContain('reading…')
  })

  test('no header spinner turns without the motion-safe guard', async () => {
    const source = await Bun.file(new URL('../src/canvas/HeaderMenus.tsx', import.meta.url)).text()
    const spins = source.match(/LoaderCircle className="[^"]*"/g) ?? []
    expect(spins.length).toBe(3)
    for (const one of spins) expect(one).toContain('motion-safe:animate-spin')
  })
})
