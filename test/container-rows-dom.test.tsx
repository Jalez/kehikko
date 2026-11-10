import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A container's two rows, rendered (`host/rows.ts`): reveal on click moving
 * between two containers as the person clicks into one page and then another;
 * the fold control's menu of one row or two, by a long press and by the
 * keyboard; a container folded to two rows with its footer live; and the
 * Container menu's say over when the rows show.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.CONTAINER_ROWS_DOM === '1'
const TESTS = 24

if (!inChild) {
  test('a container\'s rows, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CONTAINER_ROWS_DOM: '1' },
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
let Reveal: typeof import('../src/host/reveal.ts')
let Rows: typeof import('../src/host/rows.ts')
let Protocol: typeof import('kehikot-module-protocol')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let Responsive: typeof import('react-grid-layout').Responsive
let Canvases: typeof import('../src/host/canvases.ts')
let Columns: typeof import('../src/host/columns.ts')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Box = await import('../src/canvas/Container.tsx')
  Reveal = await import('../src/host/reveal.ts')
  Rows = await import('../src/host/rows.ts')
  Protocol = await import('kehikot-module-protocol')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  ;({ Responsive } = await import('react-grid-layout'))
  Canvases = await import('../src/host/canvases.ts')
  Columns = await import('../src/host/columns.ts')
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
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Props = Partial<import('react').ComponentProps<typeof import('../src/canvas/Container.tsx').Container>>

function presence(id: string) {
  return {
    id,
    at: 'http://127.0.0.1:7999',
    condition: 'ready',
    reached: true,
    name: id === 'kehikot.a' ? 'Alpha' : 'Beta',
    line: '',
    agent: { kind: 'none' },
    module: {
      id,
      name: id,
      version: '1.0.0',
      summary: '',
      entry: 'http://127.0.0.1:7999/',
      icon: null,
      health: null,
      mcp: null,
      modes: [{ id: 'main', label: 'Main', scope: 'project' }],
      extensions: { emits: [], consumes: [] },
      declares: { uses: [] },
    },
  } as unknown as import('../src/host/registry.ts').Presence
}

function box(id: string, props: Props) {
  return (
    <Box.Container
      key={id}
      presence={presence(id)}
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
  return {
    host,
    rerender: (next: import('react').ReactNode) => act(async () => root.render(<TooltipProvider>{next}</TooltipProvider>)),
  }
}

const container = (id: string) => document.querySelector<HTMLElement>(`[data-module="${id}"]`)!
const revealed = (id: string) => container(id).getAttribute('data-revealed') === 'true'
const fold = (id: string) => container(id).querySelector<HTMLButtonElement>('[data-tour="fold"]')!
const foldMenu = () => document.querySelector<HTMLElement>('[data-menu-content="fold"]')

const footer = () =>
  Protocol.footerItemsSchema.parse([
    { kind: 'text', id: 'status', text: 'Synced' },
    { kind: 'run', id: 'retry', label: 'Retry', align: 'end', actsOn: 'status' },
  ])

describe('reveal on click', () => {
  if (!inChild) return

  /* Two containers, each revealed on click, and each module's page as an iframe in the frames layer. */
  async function two() {
    const reveals = new Reveal.Reveals(5, 20)
    await mount(
      <>
        {box('kehikot.a', { reveals, rowsMode: 'click' })}
        {box('kehikot.b', { reveals, rowsMode: 'click' })}
      </>,
    )
    const frames = ['kehikot.a', 'kehikot.b'].map((id) => {
      const layer = document.createElement('div')
      layer.setAttribute('data-frame', id)
      const frame = document.createElement('iframe')
      frame.tabIndex = 0
      layer.appendChild(frame)
      document.body.appendChild(layer)
      return frame
    })
    cleanups.push(Rows.watchClicks(document, window, (event) => reveals.click(event)))
    /* A click inside a page: the frame takes the keyboard, and this window is told only that it lost it. */
    const clickInto = async (n: 0 | 1) => {
      await act(async () => {
        frames[n]!.focus()
        window.dispatchEvent(new Event('blur'))
        await wait(5)
      })
    }
    return { reveals, clickInto }
  }

  test('the rows of a container revealed on click hide until it is clicked; always never hides', async () => {
    const reveals = new Reveal.Reveals(5, 20)
    await mount(
      <>
        {box('kehikot.a', { reveals, rowsMode: 'click' })}
        {box('kehikot.b', { reveals, rowsMode: 'always' })}
      </>,
    )
    expect(container('kehikot.a').getAttribute('data-rows')).toBe('hide')
    expect(container('kehikot.a').getAttribute('data-rows-mode')).toBe('click')
    expect(container('kehikot.b').hasAttribute('data-rows')).toBe(false)
    expect(revealed('kehikot.a')).toBe(false)
  })

  test('clicking into one page reveals its rows; into the other moves them there', async () => {
    const { clickInto } = await two()
    await clickInto(0)
    expect(revealed('kehikot.a')).toBe(true)
    expect(revealed('kehikot.b')).toBe(false)
    await clickInto(1)
    expect(revealed('kehikot.a')).toBe(false)
    expect(revealed('kehikot.b')).toBe(true)
  })

  test('a press on a container\'s own chrome reveals it; Escape hides; a press on nothing hides', async () => {
    const { clickInto } = await two()
    await act(async () => {
      container('kehikot.b').querySelector('header')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(revealed('kehikot.b')).toBe(true)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(revealed('kehikot.b')).toBe(false)
    await clickInto(0)
    expect(revealed('kehikot.a')).toBe(true)
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    })
    expect(revealed('kehikot.a')).toBe(false)
  })
})

describe('the fold control: one row or two', () => {
  if (!inChild) return

  async function folding(props: Props = {}) {
    const calls = { collapse: [] as boolean[], fold: [] as number[] }
    await mount(
      box('kehikot.a', {
        footer: footer(),
        onCollapse: (collapsed) => void calls.collapse.push(collapsed),
        onFold: (rows) => void calls.fold.push(rows),
        ...props,
      }),
    )
    return calls
  }

  test('the keyboard: Enter folds as a plain press; Shift+Enter opens the choice, each with its line; picking two rows folds to it', async () => {
    const calls = await folding()
    const button = fold('kehikot.a')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Shift+Enter')
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(calls.collapse).toEqual([true])
    expect(foldMenu()).toBeNull()
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    const menu = foldMenu()
    expect(menu).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const choices = [...menu!.querySelectorAll<HTMLElement>('[data-fold-choice]')]
    expect(choices.map((one) => one.textContent)).toEqual([
      'One rowonly the header: how this module is set up.',
      'Two rowsheader and footer: also what’s going on now (status, location, usage).',
    ])
    expect(choices.every((one) => one.getAttribute('role') === 'menuitemradio')).toBe(true)
    await act(async () => choices[1]!.click())
    expect(calls.fold).toEqual([2])
    expect(foldMenu()).toBeNull()
  })

  test('a long press opens the choice and folds nothing; a short one folds; a right click opens it', async () => {
    const calls = await folding()
    const button = fold('kehikot.a')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await wait(Rows.LONG_PRESS_MS + 50)
      button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      button.click()
    })
    expect(foldMenu()).not.toBeNull()
    expect(calls.collapse).toEqual([])
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await wait(30)
      button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      button.click()
    })
    expect(calls.collapse).toEqual([true])
    await act(async () => {
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(foldMenu()).not.toBeNull()
  })

  test('with no footer drawn there is one choice, so no menu: the control is the plain button it was', async () => {
    const calls = await folding({ footer: [] })
    const button = fold('kehikot.a')
    expect(button.hasAttribute('aria-haspopup')).toBe(false)
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    expect(foldMenu()).toBeNull()
    await act(async () => button.click())
    expect(calls.collapse).toEqual([true])
  })

  test('folded to two rows: the header and the live footer, no page; a footer press still reaches the module', async () => {
    const pressed: unknown[] = []
    await folding({
      collapsed: true,
      foldRows: 2,
      onFooterPress: (press) => {
        pressed.push(press)
        return Promise.resolve({ ok: true, why: '' })
      },
    })
    const box = container('kehikot.a')
    expect(box.getAttribute('data-fold')).toBe('2')
    expect(box.querySelector('[data-body]')).toBeNull()
    const row = box.querySelector<HTMLElement>('[role="toolbar"]')!
    expect(row.getAttribute('data-dense')).toBe('true')
    expect(row.textContent).toContain('Synced')
    await act(async () => {
      box.querySelector<HTMLElement>('[data-footer-item="retry"]')!.click()
    })
    await act(async () => {})
    expect(pressed).toEqual([{ item: 'retry' }])
    expect(fold('kehikot.a').getAttribute('aria-label')).toBe('unfold this container')
  })

  test('remembered as two rows with no footer to draw: one row, and the choice kept', async () => {
    await folding({ collapsed: true, foldRows: 2, footer: [] })
    const box = container('kehikot.a')
    expect(box.getAttribute('data-fold')).toBe('1')
    expect(box.querySelector('[role="toolbar"]')).toBeNull()
  })

  test('the fold control\'s menu also says when the rows show: a second group under the fold, each with its line', async () => {
    const chosen: unknown[] = []
    const calls = await folding({ showRows: null, barRows: 'always', onShowRows: (mode) => void chosen.push(mode) })
    const button = fold('kehikot.a')
    expect(document.getElementById(button.getAttribute('aria-describedby')!)!.textContent).toContain('when the header and footer show')
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    const menu = foldMenu()!
    const groups = [...menu.querySelectorAll<HTMLElement>('[data-fold-group]')].map((one) => one.getAttribute('data-fold-group'))
    expect(groups).toEqual(['rows', 'reveal'])
    const reveal = [...menu.querySelectorAll<HTMLElement>('[data-reveal-choice]')]
    expect(reveal.map((one) => one.getAttribute('data-reveal-choice'))).toEqual(['bar', 'always', 'hover', 'click', 'longpress'])
    expect(reveal.every((one) => one.getAttribute('role') === 'menuitemradio')).toBe(true)
    expect(reveal[0]!.getAttribute('aria-checked')).toBe('true')
    expect(reveal[0]!.textContent).toContain('now: always shown')
    expect(reveal[0]!.textContent).toContain('As the bar’s Headers setting')
    expect(reveal[3]!.textContent).toBe('Reveal on clickthey hide, and come back when you click inside this container; Escape or a click elsewhere hides them.')
    await act(async () => reveal[3]!.click())
    expect(chosen).toEqual(['click'])
    expect(calls.fold).toEqual([])
    expect(calls.collapse).toEqual([])
  })

  test('with no footer the fold control\'s menu is only when the rows show; folded, it is still there', async () => {
    const chosen: unknown[] = []
    const calls = await folding({ footer: [], collapsed: true, showRows: 'hover', barRows: 'always', onShowRows: (mode) => void chosen.push(mode) })
    const button = fold('kehikot.a')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    await act(async () => button.click())
    expect(calls.collapse).toEqual([false])
    expect(foldMenu()).toBeNull()
    await act(async () => {
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    const menu = foldMenu()!
    expect(menu.querySelector('[data-fold-choice]')).toBeNull()
    expect(menu.querySelector('[data-reveal-choice="hover"]')!.getAttribute('aria-checked')).toBe('true')
    await act(async () => menu.querySelector<HTMLElement>('[data-reveal-choice="bar"]')!.click())
    expect(chosen).toEqual([null])
  })

  test('the Container menu\'s "Header and footer" is there folded, with no footer and focus mode off', async () => {
    await mount(box('kehikot.a', { collapsed: true, footer: [], showRows: null, barRows: 'always', onShowRows: nothing }))
    const trigger = container('kehikot.a').querySelector<HTMLElement>('[data-menu="frame"]')!
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    })
    const rows = document.querySelector<HTMLElement>('[data-frame="rows"]')!
    expect(rows.textContent).toContain('Header and footer')
    expect(rows.textContent).toContain('as the bar')
  })

  test('the Container menu says when the rows show, and changes it', async () => {
    const chosen: unknown[] = []
    await mount(box('kehikot.a', { showRows: null, barRows: 'hover', onShowRows: (mode) => void chosen.push(mode) }))
    const trigger = container('kehikot.a').querySelector<HTMLElement>('[data-menu="frame"]')!
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    })
    const rows = document.querySelector<HTMLElement>('[data-frame="rows"]')!
    expect(rows.textContent).toContain('Header and footer')
    expect(rows.textContent).toContain('as the bar')
    await act(async () => {
      rows.focus()
      rows.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    const click = document.querySelector<HTMLElement>('[data-reveal-choice="click"]')!
    expect(document.querySelector('[data-reveal-choice="bar"]')!.textContent).toContain('reveal on hover')
    await act(async () => click.click())
    expect(chosen).toEqual(['click'])
  })
})

describe('folding to two rows on a canvas', () => {
  if (!inChild) return

  /*
   * The page's own loop, as `App.tsx` runs it: the placements are state, the
   * grid draws them, a fold is `onFold`'s write, and every arrangement the
   * grid reports goes back through `fromGrid` and `redrawn` (`onLayoutChange`).
   * The grid reports one after a fold, because the folded height changed — so
   * whatever that report drops is lost the moment the fold lands.
   */
  function Canvas({ footerPressed }: { footerPressed: unknown[] }) {
    const [placements, setPlacements] = React.useState<import('../src/host/canvases.ts').Placement[]>(() => [
      { i: 'kehikot.a', x: 0, y: 0, w: 12, h: 20, wish: 20, grow: false, pinned: false, prompt: '', promptFor: null, collapsed: false, selected: false, filters: {}, refreshEvery: null, version: null, scope: null } as import('../src/host/canvases.ts').Placement,
    ])
    const onFold = (id: string, rows: 1 | 2) =>
      setPlacements((was) => Columns.pressed(was.map((p) => (p.i === id ? { ...p, foldRows: rows } : p)), id, true))
    const onCollapse = (id: string, collapsed: boolean) => setPlacements((was) => Columns.pressed(was, id, collapsed))
    const onLayoutChange = (next: readonly import('react-grid-layout').Layout[]) =>
      setPlacements((was) => {
        const drawn = Columns.redrawn(Canvases.fromGrid(was, next, null, new Map()))
        return JSON.stringify(drawn) === JSON.stringify(was) ? was : drawn
      })
    const one = placements[0]!
    return (
      <Responsive
        width={1200}
        layouts={{ lg: placements.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })) }}
        breakpoints={{ lg: 0 }}
        cols={{ lg: 24 }}
        rowHeight={14}
        onLayoutChange={onLayoutChange}
      >
        <div key="kehikot.a">
          {box('kehikot.a', {
            footer: footer(),
            collapsed: one.collapsed,
            foldRows: one.foldRows ?? 1,
            onFold: (rows) => onFold('kehikot.a', rows),
            onCollapse: (collapsed) => onCollapse('kehikot.a', collapsed),
            onFooterPress: (press) => {
              footerPressed.push(press)
              return Promise.resolve({ ok: true, why: '' })
            },
          })}
        </div>
      </Responsive>
    )
  }

  test('choosing two rows folds to the header and the live footer, and stays there; a footer press reaches the module', async () => {
    const pressedNow: unknown[] = []
    await mount(<Canvas footerPressed={pressedNow} />)
    const button = fold('kehikot.a')
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    const two = foldMenu()!.querySelector<HTMLElement>('[data-fold-choice="2"]')!
    await act(async () => two.click())
    await act(async () => wait(20))
    const folded = container('kehikot.a')
    expect(folded.getAttribute('data-fold')).toBe('2')
    expect(folded.querySelector('[data-body]')).toBeNull()
    const row = folded.querySelector<HTMLElement>('[role="toolbar"]')!
    expect(row.textContent).toContain('Synced')
    await act(async () => {
      folded.querySelector<HTMLElement>('[data-footer-item="retry"]')!.click()
    })
    await act(async () => {})
    expect(pressedNow).toEqual([{ item: 'retry' }])
    /* A plain press unfolds, and the next plain press folds to the remembered two rows. */
    await act(async () => fold('kehikot.a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => wait(20))
    expect(container('kehikot.a').hasAttribute('data-fold')).toBe(false)
    await act(async () => fold('kehikot.a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => wait(20))
    expect(container('kehikot.a').getAttribute('data-fold')).toBe('2')
  })
})

type Placement = import('../src/host/canvases.ts').Placement

const at = (i: string, x: number, more: Partial<Placement> = {}): Placement =>
  ({ i, x, y: 0, w: 12, h: 20, wish: 20, grow: false, pinned: false, prompt: '', promptFor: null, collapsed: false, selected: false, filters: {}, refreshEvery: null, version: null, scope: null, ...more }) as Placement

/*
 * Several containers on a real grid, run the way `App.tsx` runs them: the
 * placements are state; the fold, a fold choice and when the rows show are
 * the page's writes from what is held NOW (`open.placements`); every
 * arrangement the grid reports goes back through `fromGrid` and `redrawn`;
 * and a corner let go at a height is `fromGrid` with that container held.
 */
interface BoardHandle {
  placements: () => Placement[]
  resize: (id: string, h: number) => Promise<void>
}

function Board({ start, handle, footered, pressed }: { start: Placement[]; handle: { current: BoardHandle | null }; footered: (id: string) => boolean; pressed?: unknown[] }) {
  const [placements, setPlacements] = React.useState<Placement[]>(start)
  const held = React.useRef(placements)
  held.current = placements
  const write = (next: Placement[]) => setPlacements(next)
  const onFold = (id: string, rows: 1 | 2) => write(Columns.pressed(held.current.map((p) => (p.i === id ? { ...p, foldRows: rows } : p)), id, true))
  const onCollapse = (id: string, collapsed: boolean) => write(Columns.pressed(held.current, id, collapsed))
  const onShowRows = (id: string, mode: import('../src/host/rows.ts').ShowRows | null) =>
    write(held.current.map((p) => (p.i === id ? { ...p, showRows: mode } : p)))
  const onLayoutChange = (next: readonly import('react-grid-layout').Layout[]) =>
    setPlacements((was) => {
      const drawn = Columns.redrawn(Canvases.fromGrid(was, next, null, new Map(), footered))
      return JSON.stringify(drawn) === JSON.stringify(was) ? was : drawn
    })
  handle.current = {
    placements: () => held.current,
    resize: (id, h) =>
      act(async () => {
        setPlacements((was) => Columns.redrawn(Canvases.fromGrid(was, was.map((p) => ({ i: p.i, x: p.x, y: p.y, w: p.w, h: p.i === id ? h : p.h })), id, new Map(), footered)))
        await wait(10)
      }),
  }
  return (
    <Responsive
      width={1200}
      layouts={{ lg: placements.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })) }}
      breakpoints={{ lg: 0 }}
      cols={{ lg: 24 }}
      rowHeight={14}
      onLayoutChange={onLayoutChange}
    >
      {placements.map((one) => (
        <div key={one.i}>
          {box(one.i, {
            footer: footered(one.i) ? footer() : [],
            collapsed: one.collapsed,
            foldRows: one.foldRows ?? 1,
            showRows: one.showRows ?? null,
            barRows: 'always',
            rowsMode: one.showRows ?? 'always',
            onFold: (rows) => onFold(one.i, rows),
            onCollapse: (collapsed) => onCollapse(one.i, collapsed),
            onShowRows: (mode) => onShowRows(one.i, mode),
            onFooterPress: (press) => {
              pressed?.push(press)
              return Promise.resolve({ ok: true, why: '' })
            },
          })}
        </div>
      ))}
    </Responsive>
  )
}

async function openFrameMenu(id: string) {
  const trigger = container(id).querySelector<HTMLElement>('[data-menu="frame"]')!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
  })
  const rows = document.querySelector<HTMLElement>('[data-frame="rows"]')!
  await act(async () => {
    rows.focus()
    rows.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
}

describe('each container keeps its own reveal mode', () => {
  if (!inChild) return

  test('A set to click keeps click when B\'s mode is changed, and through a fold that makes the grid report', async () => {
    const handle: { current: BoardHandle | null } = { current: null }
    await mount(<Board start={[at('kehikot.a', 0), at('kehikot.b', 12)]} handle={handle} footered={() => true} />)
    /* A to click, from the fold control's menu. */
    await act(async () => {
      fold('kehikot.a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    await act(async () => foldMenu()!.querySelector<HTMLElement>('[data-reveal-choice="click"]')!.click())
    await act(async () => wait(10))
    /* B to hover, from its Container menu. */
    await openFrameMenu('kehikot.b')
    await act(async () => document.querySelector<HTMLElement>('[data-reveal-choice="hover"]')!.click())
    await act(async () => wait(10))
    const modes = () => Object.fromEntries(handle.current!.placements().map((p) => [p.i, p.showRows ?? null]))
    expect(modes()).toEqual({ 'kehikot.a': 'click', 'kehikot.b': 'hover' })
    expect(container('kehikot.a').getAttribute('data-rows-mode')).toBe('click')
    /* A fold of B changes its height, so the grid reports the arrangement: A's mode rides through it. */
    await act(async () => fold('kehikot.b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => wait(20))
    expect(modes()).toEqual({ 'kehikot.a': 'click', 'kehikot.b': 'hover' })
    /* And B changed again, to long press: A still on click. */
    await openFrameMenu('kehikot.b')
    await act(async () => document.querySelector<HTMLElement>('[data-reveal-choice="longpress"]')!.click())
    await act(async () => wait(10))
    expect(modes()).toEqual({ 'kehikot.a': 'click', 'kehikot.b': 'longpress' })
  })
})

describe('reveal on click and on long press, press by press', () => {
  if (!inChild) return

  const POLL = 10
  const LONG = 60

  /* Two containers in the given modes, their pages in the frames layer, a bar and an empty canvas. */
  async function board(modes: Record<string, import('../src/host/rows.ts').ShowRows>) {
    const reveals = new Reveal.Reveals(5, 20, LONG)
    const ids = Object.keys(modes)
    await mount(<>{ids.map((id) => box(id, { reveals, rowsMode: modes[id] }))}</>)
    const bar = document.createElement('header')
    bar.setAttribute('data-bar', '')
    const canvas = document.createElement('div')
    canvas.setAttribute('data-canvas', '')
    document.body.append(bar, canvas)
    const frames = Object.fromEntries(
      ids.map((id) => {
        const layer = document.createElement('div')
        layer.setAttribute('data-frame', id)
        const frame = document.createElement('iframe')
        frame.tabIndex = 0
        layer.appendChild(frame)
        document.body.appendChild(layer)
        return [id, frame]
      }),
    )
    const move = (event: import('../src/host/rows.ts').ClickEvent) => reveals.click(Rows.withMode(event, (id) => modes[id] ?? 'always'))
    cleanups.push(Rows.watchClicks(document, window, move, POLL))
    let focusedHere = true
    /* An engine that tells the parent nothing when the keyboard moves from one page into another: no `focusin` here then. */
    let between = false
    const quiet = (event: Event) => {
      if (between) event.stopImmediatePropagation()
    }
    window.addEventListener('focusin', quiet, true)
    cleanups.push(() => window.removeEventListener('focusin', quiet, true))
    /*
     * A press inside a page, as an engine tells the host: the frame takes the
     * keyboard, the window hears `blur` only when it had the keyboard itself
     * (a press from one page into another blurs nothing here), and a page on
     * protocol 2.49.0 also says `down` and `up` itself.
     */
    const pressInside = async (id: string, { says = false, hold = 0 } = {}) => {
      await act(async () => {
        between = !focusedHere
        frames[id]!.focus()
        between = false
        if (focusedHere) window.dispatchEvent(new Event('blur'))
        focusedHere = false
        if (says) move({ kind: 'press', id })
        await wait(hold || POLL * 3)
        if (says) move({ kind: 'release', held: hold })
      })
    }
    /* A press on the host's own document: focus comes back to it first, then the pointerdown. */
    const pressOn = async (element: Element) => {
      await act(async () => {
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        if (!focusedHere) window.dispatchEvent(new Event('focus'))
        focusedHere = true
        element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
        await wait(5)
        element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
      })
    }
    const holdOn = async (element: Element, ms: number) => {
      await act(async () => {
        if (!focusedHere) window.dispatchEvent(new Event('focus'))
        focusedHere = true
        element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
        await wait(ms)
        element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
        await wait(5)
      })
    }
    return { reveals, bar, canvas, pressInside, pressOn, holdOn, move }
  }

  test('click mode: inside A twice keeps it; A, then B, then back to A, each time, with no blur between pages', async () => {
    const { pressInside } = await board({ 'kehikot.a': 'click', 'kehikot.b': 'click' })
    await pressInside('kehikot.a')
    expect(revealed('kehikot.a')).toBe(true)
    await pressInside('kehikot.a')
    expect(revealed('kehikot.a')).toBe(true)
    await pressInside('kehikot.b')
    expect([revealed('kehikot.a'), revealed('kehikot.b')]).toEqual([false, true])
    await pressInside('kehikot.a')
    expect([revealed('kehikot.a'), revealed('kehikot.b')]).toEqual([true, false])
  })

  test('click mode: inside A, then the empty canvas hides it; inside A again shows it; then the host bar hides it', async () => {
    const { pressInside, pressOn, canvas, bar } = await board({ 'kehikot.a': 'click', 'kehikot.b': 'click' })
    await pressInside('kehikot.a')
    expect(revealed('kehikot.a')).toBe(true)
    await pressOn(canvas)
    expect(revealed('kehikot.a')).toBe(false)
    await pressInside('kehikot.a')
    expect(revealed('kehikot.a')).toBe(true)
    await pressOn(bar)
    expect(revealed('kehikot.a')).toBe(false)
  })

  test('click mode: a page that says its presses is revealed even when it already had the keyboard', async () => {
    const { pressInside, move } = await board({ 'kehikot.a': 'click', 'kehikot.b': 'click' })
    await pressInside('kehikot.a', { says: true })
    expect(revealed('kehikot.a')).toBe(true)
    await act(async () => move({ kind: 'escape' }))
    expect(revealed('kehikot.a')).toBe(false)
    /* The frame still has the keyboard: no focus moves, and only the page's own word reveals it. */
    await act(async () => move({ kind: 'press', id: 'kehikot.a' }))
    expect(revealed('kehikot.a')).toBe(true)
  })

  test('long press: a plain click inside reveals nothing; a held press does; a click elsewhere hides it', async () => {
    const { pressInside, pressOn, canvas } = await board({ 'kehikot.a': 'longpress', 'kehikot.b': 'click' })
    await pressInside('kehikot.a', { says: true, hold: 10 })
    expect(revealed('kehikot.a')).toBe(false)
    await pressInside('kehikot.a', { says: true, hold: LONG + 30 })
    expect(revealed('kehikot.a')).toBe(true)
    /* A plain click inside a revealed one keeps it. */
    await pressInside('kehikot.a', { says: true, hold: 10 })
    expect(revealed('kehikot.a')).toBe(true)
    await pressOn(canvas)
    expect(revealed('kehikot.a')).toBe(false)
  })

  test('long press: a release that says it was held long enough reveals, before the timer would', async () => {
    const reveals = new Reveal.Reveals(5, 20, 10_000)
    await mount(box('kehikot.a', { reveals, rowsMode: 'longpress' }))
    await act(async () => {
      reveals.click({ kind: 'press', id: 'kehikot.a', mode: 'longpress' })
      reveals.click({ kind: 'release', held: 12_000 })
    })
    expect(revealed('kehikot.a')).toBe(true)
  })

  test('long press: held on the container\'s chrome works for a page that says nothing; a short press there does not', async () => {
    const { holdOn, pressInside } = await board({ 'kehikot.a': 'longpress', 'kehikot.b': 'click' })
    /* A page too old to say its presses: focus moves, and that reveals nothing in long-press mode. */
    await pressInside('kehikot.a')
    expect(revealed('kehikot.a')).toBe(false)
    const header = container('kehikot.a').querySelector('header')!
    await holdOn(header, 10)
    expect(revealed('kehikot.a')).toBe(false)
    await holdOn(header, LONG + 30)
    expect(revealed('kehikot.a')).toBe(true)
  })

  test('long press: a press into another container moves the click away, and its own long press moves it there', async () => {
    const { pressInside } = await board({ 'kehikot.a': 'longpress', 'kehikot.b': 'longpress' })
    await pressInside('kehikot.a', { says: true, hold: LONG + 30 })
    expect(revealed('kehikot.a')).toBe(true)
    await pressInside('kehikot.b', { says: true, hold: 10 })
    expect([revealed('kehikot.a'), revealed('kehikot.b')]).toEqual([false, false])
    await pressInside('kehikot.b', { says: true, hold: LONG + 30 })
    expect([revealed('kehikot.a'), revealed('kehikot.b')]).toEqual([false, true])
  })

  test('long press is offered in the Container menu and the fold control\'s menu, the same words from one source', async () => {
    await mount(box('kehikot.a', { footer: footer(), showRows: null, barRows: 'always', onShowRows: nothing, onFold: nothing }))
    await openFrameMenu('kehikot.a')
    const inFrame = [...document.querySelectorAll<HTMLElement>('[data-reveal-choice]')].map((one) => one.textContent)
    expect(inFrame.at(-1)).toContain('Reveal on long press')
    expect(inFrame.at(-1)).toContain('hold on the header')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      fold('kehikot.a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    })
    const inFold = [...foldMenu()!.querySelectorAll<HTMLElement>('[data-reveal-choice]')].map((one) => one.textContent)
    expect(inFold).toEqual(inFrame)
    expect(inFold.at(-1)).toContain('a plain click does not')
  })
})

describe('a corner pulled to one row, to two, and back', () => {
  if (!inChild) return

  test('one row is the header; two rows is the header and the live footer, like a two-row fold; taller is the page again', async () => {
    const handle: { current: BoardHandle | null } = { current: null }
    const pressedNow: unknown[] = []
    await mount(<Board start={[at('kehikot.a', 0)]} handle={handle} footered={() => true} pressed={pressedNow} />)
    const box = () => container('kehikot.a')
    await handle.current!.resize('kehikot.a', Columns.FOLDED_ROWS)
    expect(box().getAttribute('data-fold')).toBe('1')
    expect(box().querySelector('[data-body]')).toBeNull()
    expect(box().querySelector('[role="toolbar"]')).toBeNull()
    await handle.current!.resize('kehikot.a', Columns.FOLDED_TWO_ROWS)
    expect(box().getAttribute('data-fold')).toBe('2')
    expect(box().querySelector('[data-body]')).toBeNull()
    expect(box().querySelector('[role="toolbar"]')!.textContent).toContain('Synced')
    expect(handle.current!.placements()[0]).toMatchObject({ collapsed: true, foldRows: 2, h: Columns.FOLDED_TWO_ROWS, wish: 20 })
    await act(async () => {
      box().querySelector<HTMLElement>('[data-footer-item="retry"]')!.click()
    })
    await act(async () => {})
    expect(pressedNow).toEqual([{ item: 'retry' }])
    await handle.current!.resize('kehikot.a', 16)
    expect(box().hasAttribute('data-fold')).toBe(false)
    expect(box().querySelector('[data-body]')).not.toBeNull()
    expect(handle.current!.placements()[0]).toMatchObject({ collapsed: false, h: 16, wish: 16 })
  })

  test('with no footer drawn, two rows is a height like any other: the page stays', async () => {
    const handle: { current: BoardHandle | null } = { current: null }
    await mount(<Board start={[at('kehikot.a', 0)]} handle={handle} footered={() => false} />)
    await handle.current!.resize('kehikot.a', Columns.FOLDED_TWO_ROWS)
    expect(container('kehikot.a').hasAttribute('data-fold')).toBe(false)
    expect(container('kehikot.a').querySelector('[data-body]')).not.toBeNull()
    expect(handle.current!.placements()[0]).toMatchObject({ collapsed: false, h: Columns.FOLDED_TWO_ROWS })
  })
})
