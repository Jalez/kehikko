import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

/*
 * A ticking footer readout re-renders its own footer row and nothing above it: not the page that
 * holds the footers (here a stand-in wired the way `App` is — a `FooterStore`, `useFooted`, each
 * container handed `footerSource`), and not the container next to it.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.FOOTER_RENDER_DOM === '1'
const TESTS = 2

if (!inChild) {
  test('the footer’s renders, counted in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, FOOTER_RENDER_DOM: '1' },
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
let Store: typeof import('../src/host/footerStore.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Box = await import('../src/canvas/Container.tsx')
  Store = await import('../src/host/footerStore.ts')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const readout = (rate: string): FooterItem[] =>
  footerItemsSchema.parse([
    { kind: 'text', id: 'rate', text: rate },
    { kind: 'run', id: 'clear', label: 'Clear', align: 'end' },
  ])

const presence = (id: string, name: string) =>
  ({ id, at: 'http://127.0.0.1:7870', condition: 'ready', reached: true, name, line: '', agent: { kind: 'untold' } }) as unknown as import('../src/host/registry.ts').Presence

describe('a readout ticking', () => {
  if (!inChild) return

  async function page() {
    const store = new Store.FooterStore()
    const renders = { page: 0, a: 0, b: 0 }
    const nothing = () => {}
    const one = (id: string, name: string, count: () => void) => {
      function Counted() {
        count()
        return (
          <Box.Container
            presence={presence(id, name)}
            showing={{ kind: 'page' }}
            fault={null}
            body={nothing}
            grow={false}
            onGrow={nothing}
            pinned={false}
            onPin={nothing}
            collapsed={false}
            onCollapse={nothing}
            footerSource={store.source(id)}
            reveals={null}
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
        )
      }
      return Counted
    }
    const A = one('kehikot.monitor', 'Monitor', () => renders.a++)
    const B = one('kehikot.queue', 'Queue', () => renders.b++)
    function Page() {
      renders.page++
      const footed = Store.useFooted(store)
      return (
        <TooltipProvider>
          <div data-footed={[...footed].join(' ')}>
            <A />
            <B />
          </div>
        </TooltipProvider>
      )
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      store.declare('kehikot.monitor', readout('1/min'))
      store.declare('kehikot.queue', readout('load 1.0'))
      root.render(<Page />)
    })
    return { host, store, renders, unmount: () => act(() => root.unmount()) }
  }

  test('only the footer row draws the new words: not the page, not either container', async () => {
    const { host, store, renders, unmount } = await page()
    const rate = () => host.querySelector('[data-footer-item="rate"]')!.textContent
    expect(rate()).toBe('1/min')
    const before = { ...renders }
    for (let n = 2; n <= 10; n++) await act(async () => store.declare('kehikot.monitor', readout(`${n}/min`)))
    expect(rate()).toBe('10/min')
    expect(renders).toEqual(before)
    unmount()
  })

  test('a module starting or stopping its footer is what the page re-renders for', async () => {
    const { host, store, renders, unmount } = await page()
    const before = renders.page
    await act(async () => store.withdraw('kehikot.queue'))
    expect(renders.page).toBe(before + 1)
    expect(host.querySelector('[data-footed]')!.getAttribute('data-footed')).toBe('kehikot.monitor')
    unmount()
  })
})
