import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import type { FooterItem } from 'kehikot-module-protocol'
import type { Presence } from '../src/host/registry.ts'
import type { Showing } from '../src/host/standing.ts'

/*
 * The pieces a container (`Container.tsx`) is drawn from, each rendered on
 * its own: `useContainerResize` (the header's width and what its left side has
 * room for), `ContainerHeader` and `ContainerBody`. The whole container,
 * rendered, is in `header-fit`, `restart-module-dom`, `container-rows-dom` and
 * the other container tests.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */
const inChild = process.env.CONTAINER_PARTS_DOM === '1'
const TESTS = 11

if (!inChild) {
  test('the container parts, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CONTAINER_PARTS_DOM: '1' },
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
let useContainerResize: typeof import('../src/canvas/useContainerResize.ts').useContainerResize
let ContainerHeader: typeof import('../src/canvas/ContainerHeader.tsx').ContainerHeader
let ContainerBody: typeof import('../src/canvas/ContainerBody.tsx').ContainerBody
let useFeedback: typeof import('../src/canvas/Feedback.tsx').useFeedback
let frameEntriesOf: typeof import('../src/canvas/HeaderMenus.tsx').frameEntriesOf
let helpEntriesOf: typeof import('../src/canvas/HeaderMenus.tsx').helpEntriesOf
let layoutOf: typeof import('../src/host/headerOffer.ts').layoutOf
let modeFor: typeof import('../src/host/headerOffer.ts').modeFor
let pinsFor: typeof import('../src/host/headerOffer.ts').pinsFor
let fixedFooter: typeof import('../src/host/footerStore.ts').fixedFooter
let standingOf: typeof import('../src/host/coverFit.ts').standingOf
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

/** The header's width, and the name's: what it would take, and what it is given. */
let width = 380
let nameWants = 100
let nameGets = 100

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => width })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.dataset?.testid === 'header-name' ? nameWants : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.dataset?.testid === 'header-name' ? nameGets : 0 } })
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useContainerResize } = await import('../src/canvas/useContainerResize.ts'))
  ;({ ContainerHeader } = await import('../src/canvas/ContainerHeader.tsx'))
  ;({ ContainerBody } = await import('../src/canvas/ContainerBody.tsx'))
  ;({ useFeedback } = await import('../src/canvas/Feedback.tsx'))
  ;({ frameEntriesOf, helpEntriesOf } = await import('../src/canvas/HeaderMenus.tsx'))
  ;({ layoutOf, modeFor, pinsFor } = await import('../src/host/headerOffer.ts'))
  ;({ fixedFooter } = await import('../src/host/footerStore.ts'))
  ;({ standingOf } = await import('../src/host/coverFit.ts'))
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
  width = 380
  nameWants = 100
  nameGets = 100
})

const presence = {
  id: 'kehikot.scratch',
  at: 'http://127.0.0.1:7990',
  condition: 'ready',
  reached: true,
  name: 'Scratch',
  line: '',
  dir: '/somewhere/scratch',
  run: 1_700_000_000_000,
  agent: { kind: 'untold' },
} as unknown as Presence

const nothing = () => {}

function draw(node: import('react').ReactNode): { root: import('react-dom/client').Root } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
  return { root }
}

describe.skipIf(!inChild)('useContainerResize', () => {
  /** The hook on a header with a name in it; what it fits to is written out. */
  function Probe({ content }: { content: string }) {
    const { grip, width: seen, fit } = useContainerResize(content)
    return (
      <header ref={grip} data-width={seen ?? 'none'} data-fit={JSON.stringify(fit)}>
        <span data-testid="header-name">name</span>
      </header>
    )
  }
  const fitShown = () => JSON.parse(document.querySelector('header')!.dataset.fit!) as Record<string, boolean>

  test('measures the header, and a wide one has room for everything', () => {
    width = 780
    draw(<Probe content="a" />)
    expect(document.querySelector('header')!.dataset.width).toBe('780')
    expect(fitShown()).toEqual({ version: true, badgeText: true, quiet: true })
  })

  test('the width decides first: under 300 pixels the version goes', () => {
    width = 280
    draw(<Probe content="a" />)
    expect(fitShown().version).toBe(false)
  })

  test('a crowded name takes steps down until nothing is left to give way', () => {
    width = 780
    nameWants = 230
    nameGets = 40
    draw(<Probe content="a" />)
    expect(fitShown()).toEqual({ version: false, badgeText: false, quiet: false })
  })

  test('new words start from the most again', () => {
    width = 780
    nameWants = 230
    nameGets = 40
    const { root } = draw(<Probe content="a" />)
    expect(fitShown().version).toBe(false)
    nameWants = 100
    nameGets = 100
    act(() => root.render(<TooltipProvider><Probe content="b" /></TooltipProvider>))
    expect(fitShown()).toEqual({ version: true, badgeText: true, quiet: true })
  })
})

describe.skipIf(!inChild)('ContainerHeader', () => {
  function Header({ collapsed = false, selected = false, showing = { kind: 'page' } as Showing, picked = nothing as (on: boolean) => void, removed = nothing }) {
    const feedback = useFeedback(presence.id)
    const grip = React.useRef<HTMLElement>(null)
    const frameParts = { module: presence.id, name: 'Scratch', feedback, agent: undefined, onTools: nothing, prompted: false, onPrompts: nothing, onRemove: removed }
    const layout = layoutOf({ items: [], frame: frameEntriesOf(frameParts), help: helpEntriesOf(frameParts), controls: [] }, modeFor(width), pinsFor(width), 0)
    return (
      <ContainerHeader
        grip={grip}
        presence={presence}
        showing={showing}
        name="Scratch"
        nameTitle="Scratch · 1.0.0"
        fit={{ version: true, badgeText: true, quiet: true }}
        revealed={false}
        layout={layout}
        items={[]}
        frameParts={frameParts}
        feedback={feedback}
        standing={null}
        pressing={{ said: null, running: false }}
        footerDrawn={false}
        selected={selected}
        onSelect={picked}
        activity={null}
        canvas={null}
        version={null}
        current={null}
        onVersion={nothing}
        onPress={async () => ({ ok: true, why: '' })}
        pressNote={null}
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
        kehikko="thesis"
        epic={null}
        collapsed={collapsed}
        tiled={false}
        onTile={nothing}
        collapseMakes="fold"
        foldedBy={null}
        foldRows={1}
        onCollapse={nothing}
        onRemove={removed}
      />
    )
  }

  test('draws the grip with the name and its title, and the pick box says what a press does', () => {
    draw(<Header />)
    const grip = document.querySelector<HTMLElement>('header.container-grip')!
    expect(grip.className).toContain('h-8')
    expect(grip.dataset.dense).toBeUndefined()
    const name = document.querySelector<HTMLElement>('[data-testid="header-name"]')!
    expect(name.textContent).toBe('Scratch')
    expect(name.title).toBe('Scratch · 1.0.0')
    expect(document.querySelector('[aria-label="pick Scratch out as a target"]')).not.toBeNull()
    expect(document.querySelector('.container-reveal')!.getAttribute('data-selected')).toBeNull()
  })

  test('folded, the header is dense and fills the container', () => {
    draw(<Header collapsed />)
    expect(document.querySelector<HTMLElement>('header.container-grip')!.dataset.dense).toBe('true')
    expect(document.querySelector('.container-reveal')!.getAttribute('data-collapsed')).toBe('true')
  })

  test('the pick box and the remove button press what they say', () => {
    const picks: boolean[] = []
    let removed = 0
    draw(<Header selected picked={(on) => picks.push(on)} removed={() => (removed += 1)} />)
    expect(document.querySelector('.container-reveal')!.getAttribute('data-selected')).toBe('true')
    act(() => document.querySelector<HTMLElement>('[aria-label="unpick Scratch"]')!.click())
    expect(picks).toEqual([false])
    act(() => document.querySelector<HTMLElement>('[data-remove-button]')!.click())
    expect(removed).toBe(1)
  })
})

describe.skipIf(!inChild)('ContainerBody', () => {
  function Body(over: Partial<import('../src/canvas/ContainerBody.tsx').ContainerBodyProps> = {}) {
    return (
      <div>
        <ContainerBody
          presence={presence}
          showing={{ kind: 'page' }}
          name="Scratch"
          body={nothing}
          loading={null}
          fault={null}
          collapsed={false}
          tiled={false}
          fold={0}
          revealed={false}
          source={fixedFooter(NO_ITEMS)}
          footed={false}
          ownTile={false}
          standing={null}
          notice={null}
          can={{ ok: true }}
          oneEpic={false}
          activity={null}
          find={null}
          width={380}
          onFooterPress={async () => ({ ok: true, why: '' })}
          onStarted={nothing}
          {...over}
        />
      </div>
    )
  }
  const NO_ITEMS: readonly FooterItem[] = []

  test('open with the page showing: only the hollow body, which says which module it holds', () => {
    draw(<Body />)
    const body = document.querySelector<HTMLElement>('[data-body]')!
    expect(body.dataset.body).toBe(presence.id)
    expect(body.children.length).toBe(0)
    expect(document.querySelector('.container-footer-reveal')).toBeNull()
  })

  test('a fault is a line under the body; "All epics" is a sentence over it', () => {
    draw(<Body fault="it said something odd" oneEpic />)
    expect(document.querySelector<HTMLElement>('p[title="it said something odd"]')!.textContent).toBe('it said something odd')
    expect(document.querySelector('[data-body] .bg-card p')!.textContent!.length).toBeGreaterThan(0)
  })

  test('a late page is veiled with the loading cover; a cover stands in for a page that is not there', () => {
    draw(<Body loading={{ label: 'Loading the plan…' }} />)
    expect(document.querySelector('[data-testid="loading-cover"]')).not.toBeNull()
    act(() => unmount?.())
    const cover: Showing = { kind: 'cover', state: 'starting' }
    draw(<Body showing={cover} standing={standingOf(cover, null, presence.at, undefined, 'Scratch')} />)
    expect(document.querySelector('[data-testid="loading-cover"]')).toBeNull()
    expect(document.querySelector('[data-body]')!.children.length).toBeGreaterThan(0)
  })

  test('folded to its header there is no body at all; folded to two rows only the footer', () => {
    draw(<Body collapsed fold={1} />)
    expect(document.querySelector('[data-body]')).toBeNull()
    act(() => unmount?.())
    draw(<Body collapsed fold={2} />)
    expect(document.querySelector('[data-body]')).toBeNull()
    expect(document.querySelector('.container-footer-reveal')!.getAttribute('data-collapsed')).toBe('true')
  })
})
