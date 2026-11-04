import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A container's two rows, rendered (`host/rows.ts`): reveal on click moving
 * between two containers as the person clicks into one page and then another;
 * the fold control's menu of one row or two, by a long press and by the
 * keyboard; a container folded to two rows with its footer live; and the
 * Frame menu's say over when the rows show.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.CONTAINER_ROWS_DOM === '1'
const TESTS = 9

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

  test('the Frame menu says when the rows show, and changes it', async () => {
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
    const click = document.querySelector<HTMLElement>('[data-rows-choice="click"]')!
    expect(document.querySelector('[data-rows-choice="bar"]')!.textContent).toContain('reveal on hover')
    await act(async () => click.click())
    expect(chosen).toEqual(['click'])
  })
})
