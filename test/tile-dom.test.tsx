import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A container drawn as a tile, rendered (`canvas/Tile.tsx`, `host/tile.ts`): the host's tile with
 * the module's icon, name, footer readout and Inbox state, which shows the container large on a
 * press; a module's own tile winning; the collapse button following Settings › Appearance; and the
 * Appearance choice itself.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.TILE_DOM === '1'
const TESTS = 8

if (!inChild) {
  test('a container as a tile, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TILE_DOM: '1' },
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
let Protocol: typeof import('kehikot-module-protocol')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let Footers: typeof import('../src/host/footerStore.ts')
let Settings: typeof import('../src/canvas/AppearanceSettings.tsx')
let Store: typeof import('../src/host/appearanceStore.ts')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Box = await import('../src/canvas/Container.tsx')
  Protocol = await import('kehikot-module-protocol')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  Footers = await import('../src/host/footerStore.ts')
  Settings = await import('../src/canvas/AppearanceSettings.tsx')
  Store = await import('../src/host/appearanceStore.ts')
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const cleanups: (() => void)[] = []
afterEach(() => {
  if (!inChild) return
  for (const clean of cleanups.splice(0)) act(() => clean())
  document.body.innerHTML = ''
})

const nothing = () => {}

type Props = Partial<import('react').ComponentProps<typeof import('../src/canvas/Container.tsx').Container>>

function presence(id: string, uses: string[] = []) {
  return {
    id,
    at: 'http://127.0.0.1:7999',
    condition: 'ready',
    reached: true,
    name: 'Alpha',
    line: '',
    agent: { kind: 'none' },
    module: {
      id,
      name: id,
      version: '1.0.0',
      summary: '',
      entry: 'http://127.0.0.1:7999/',
      icon: 'lucide:list-checks',
      health: null,
      mcp: null,
      modes: [{ id: 'main', label: 'Main', scope: 'project' }],
      extensions: { emits: [], consumes: [] },
      declares: { uses },
    },
  } as unknown as import('../src/host/registry.ts').Presence
}

function box(props: Props, uses: string[] = []) {
  return (
    <Box.Container
      presence={presence('kehikot.a', uses)}
      showing={{ kind: 'page' }}
      fault={null}
      body={nothing}
      grow={false}
      onGrow={nothing}
      pinned={false}
      onPin={nothing}
      collapsed={false}
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
      onRemove={nothing}
      kehikko="thesis"
      epic={null}
      {...props}
    />
  )
}

async function mount(children: import('react').ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<TooltipProvider>{children}</TooltipProvider>)
  })
  cleanups.push(() => root.unmount())
  return host
}

const fold = () => document.querySelector<HTMLButtonElement>('[data-tour="fold"]')!

const footer = () =>
  Footers.fixedFooter(
    Protocol.footerItemsSchema.parse([
      { kind: 'text', id: 'status', text: '3 running' },
      { kind: 'run', id: 'retry', label: 'Retry', align: 'end', actsOn: 'status' },
      { kind: 'text', id: 'queued', text: '2 waiting' },
    ]),
  )

describe('the host’s tile', () => {
  if (!inChild) return

  test('shows the module’s icon, its name, its footer readout and its Inbox state, and no footer row', async () => {
    await mount(box({ tiled: true, footerSource: footer(), activity: 'attention', expand: { on: false, onChange: nothing } }))
    const tile = document.querySelector<HTMLElement>('[data-tile="kehikot.a"]')!
    expect(tile).not.toBeNull()
    expect(tile.querySelector('[data-tile-name]')!.textContent).toBe('Alpha')
    expect(tile.querySelector('svg, [data-module-icon], [role="img"]')).not.toBeNull()
    expect([...tile.querySelectorAll('[data-tile-readout]')].map((one) => one.textContent)).toEqual(['3 running', '2 waiting'])
    expect(tile.querySelector('[data-tile-inbox="attention"]')!.textContent).toContain('Needs you')
    /* The readouts are in the square; the footer row is not drawn under it. */
    expect(document.querySelector('.container-footer-reveal')).toBeNull()
    expect(document.querySelector('[data-module="kehikot.a"]')!.getAttribute('data-tiled')).toBe('host')
  })

  test('a press on the tile shows the container large', async () => {
    const asked: boolean[] = []
    await mount(box({ tiled: true, footerSource: footer(), expand: { on: false, onChange: (on) => void asked.push(on) } }))
    const tile = document.querySelector<HTMLButtonElement>('button[data-tile="kehikot.a"]')!
    expect(tile.getAttribute('aria-label')).toContain('show it large')
    await act(async () => tile.click())
    expect(asked).toEqual([true])
  })

  test('a module that draws its own tile keeps it: its page in a box small enough to draw it', async () => {
    const bodies: (HTMLElement | null)[] = []
    await mount(box({ tiled: true, footerSource: footer(), body: (element) => void bodies.push(element) }, ['view:expand']))
    expect(document.querySelector('[data-tile="kehikot.a"]')).toBeNull()
    expect(document.querySelector('[data-module="kehikot.a"]')!.getAttribute('data-tiled')).toBe('own')
    const measured = bodies.find((one) => one !== null)!
    expect(measured.getAttribute('data-body')).toBe('kehikot.a')
    expect(measured.style.maxWidth).toBe('208px')
    expect(measured.style.maxHeight).toBe('148px')
  })
})

describe('the collapse button follows Settings › Appearance', () => {
  if (!inChild) return

  test('“Folds to the header”: a press folds', async () => {
    const folds: boolean[] = []
    const tiles: boolean[] = []
    await mount(box({ collapseMakes: 'fold', onCollapse: (on) => void folds.push(on), onTile: (on) => void tiles.push(on) }))
    expect(fold().getAttribute('aria-label')).toBe('fold this container down to its header')
    await act(async () => fold().click())
    expect(folds).toEqual([true])
    expect(tiles).toEqual([])
  })

  test('“Makes a tile”: a press makes a tile, and the button says so', async () => {
    const folds: boolean[] = []
    const tiles: boolean[] = []
    await mount(box({ collapseMakes: 'tile', onCollapse: (on) => void folds.push(on), onTile: (on) => void tiles.push(on) }))
    expect(fold().getAttribute('aria-label')).toBe('make this container a tile')
    expect(fold().getAttribute('data-collapse-makes')).toBe('tile')
    await act(async () => fold().click())
    expect(tiles).toEqual([true])
    expect(folds).toEqual([])
  })

  test('a tile’s button restores it, whatever the setting; a folded container’s unfolds it', async () => {
    const tiles: boolean[] = []
    const folds: boolean[] = []
    await mount(box({ tiled: true, collapseMakes: 'fold', footerSource: footer(), onTile: (on) => void tiles.push(on) }))
    expect(fold().getAttribute('aria-label')).toBe('restore this container from its tile')
    await act(async () => fold().click())
    expect(tiles).toEqual([false])
    document.body.innerHTML = ''
    await mount(box({ collapsed: true, collapseMakes: 'tile', onCollapse: (on) => void folds.push(on) }))
    await act(async () => fold().click())
    expect(folds).toEqual([false])
  })

  test('a tile made by an agent says so on its restore control', async () => {
    await mount(box({ tiled: true, foldedBy: 'an agent', footerSource: footer() }))
    expect(fold().getAttribute('aria-label')).toBe('restore this container from its tile — made a tile by an agent')
    expect(fold().getAttribute('data-folded-by')).toBe('an agent')
  })
})

describe('Settings › Appearance', () => {
  if (!inChild) return

  test('“The ^ button on a container”: Folds it or Makes it a tile, saved as the app’s default', async () => {
    const store = new Store.AppearanceStore()
    const saved: unknown[] = []
    await mount(<Settings.AppearanceSettings store={store} onChange={(what) => void saved.push(what)} />)
    const group = document.querySelector<HTMLElement>('[data-appearance="collapse"]')!
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent).toBe('The ^ button on a container:')
    expect(group.textContent).toContain('Folds it')
    expect(group.textContent).toContain('Makes it a tile')
    const tile = group.querySelector<HTMLButtonElement>('[data-choice="tile"]')!
    await act(async () => tile.click())
    expect(store.get().collapse).toBe('tile')
    expect(saved).toEqual([{ appearance: { collapse: 'tile', collapseBase: 'tile' } }])
  })
})
