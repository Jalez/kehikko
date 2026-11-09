import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { manifestSchema } from 'kehikot-module-protocol'

import {
  addDisabled,
  addSaid,
  addStateOf,
  introFor,
  introsEdited,
  NO_INTROS_SEEN,
  offerSaid,
  offersIntro,
  slidesOfHelp,
  slidesOfIntro,
} from '../src/host/moduleIntro.ts'
import { FRAME_ENTRIES } from '../src/host/headerOffer.ts'
import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * A module's own introduction (protocol 2.57.0), shown by the host in the app's introduction dialog:
 * the "?" in the modules list opens it with "Add to this kehikko" (or "Install and add", "Already on
 * this kehikko", "Needs Kehikot …"); the Container menu's "Introduction…" opens it without; a placed
 * container offers it once. The module's words and pictures are drawn as text and the host's shapes.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix decides at load whether
 * it has a DOM.
 */

const inChild = process.env.MODULE_INTRO_DOM === '1'
const TESTS = 9

const INTRO = {
  slides: [
    {
      title: 'One list <b>for</b> the work',
      body: 'Everything still to do, [not a link](https://a.link).',
      art: {
        label: 'a list filling in',
        shapes: [
          { kind: 'pane', x: 40, y: 16, w: 240, h: 118 },
          { kind: 'rows', x: 56, y: 40, widths: [160, 120], motion: 'rise', delay: 0.3 },
          { kind: 'text', x: 60, y: 30, text: '<i>x</i>' },
          { kind: 'pointer', x: 200, y: 100, motion: 'pop' },
        ],
      },
    },
    { title: 'Tick a line', body: 'Press a line to tick it.' },
    { title: 'Add your own', body: 'Type at the bottom.' },
  ],
}
const HELP = { summary: 'How it works.', sections: [{ title: 'Use', points: ['Press things.', 'Then more.'] }] }

describe('the pure rules', () => {
  test('the add button follows where the module is', () => {
    expect(addStateOf({ open: false, placed: false, registered: true })).toEqual({ kind: 'none' })
    expect(addStateOf({ open: true, placed: true, registered: true })).toEqual({ kind: 'placed' })
    expect(addStateOf({ open: true, placed: false, registered: true })).toEqual({ kind: 'add' })
    expect(addStateOf({ open: true, placed: false, registered: false, listed: {} })).toEqual({ kind: 'install' })
    expect(addStateOf({ open: true, placed: false, registered: false, listed: { installing: 'cloning' } })).toEqual({ kind: 'installing', step: 'cloning' })
    expect(addStateOf({ open: true, placed: false, registered: false, listed: { newer: { app: '0.1.120' } } })).toEqual({ kind: 'newer', app: '0.1.120' })
    expect(addStateOf({ open: true, placed: false, registered: false, listed: null })).toEqual({ kind: 'none' })
    expect(addSaid({ kind: 'add' })).toBe('Add to this kehikko')
    expect(addSaid({ kind: 'install' })).toBe('Install and add')
    expect(addSaid({ kind: 'installing', step: 'cloning' })).toBe('Cloning…')
    expect(addSaid({ kind: 'placed' })).toBe('Already on this kehikko')
    expect(addSaid({ kind: 'newer', app: '0.1.120' })).toBe('Needs Kehikot 0.1.120 or later')
    expect(addSaid({ kind: 'newer', app: null })).toBe('Needs a newer Kehikot')
    expect(addSaid({ kind: 'none' })).toBeNull()
    for (const kind of ['placed', 'newer', 'installing'] as const) expect(addDisabled({ kind, app: null, step: 'x' } as never)).toBe(true)
    expect(addDisabled({ kind: 'add' })).toBe(false)
  })

  test('the offer is made once per module, for a module with an introduction', () => {
    const intro = introFor({ intro: INTRO })!
    expect(offersIntro('m', intro, NO_INTROS_SEEN)).toBe(true)
    expect(offersIntro('m', null, NO_INTROS_SEEN)).toBe(false)
    /* Not known yet: no offer rather than one that flashes. */
    expect(offersIntro('m', intro, null)).toBe(false)
    const seen = introsEdited(NO_INTROS_SEEN, { done: 'm' })
    expect(offersIntro('m', intro, seen)).toBe(false)
    expect(introsEdited(seen, { done: 'm' })).toBe(seen)
    expect(offerSaid(intro)).toMatch(/^Watch a \d+-second introduction$/)
  })

  test('slides: the introduction numbered; How to use as a summary and a slide per section', () => {
    expect(slidesOfIntro(introFor({ intro: INTRO })!).map((one) => one.id)).toEqual(['slide-1', 'slide-2', 'slide-3'])
    expect(slidesOfHelp('Lists', HELP)).toEqual([
      { id: 'help', title: 'How to use Lists', body: 'How it works.' },
      { id: 'help-1', title: 'Use', body: '', points: ['Press things.', 'Then more.'] },
    ])
  })

  test('the Container menu has Introduction just before How to use', () => {
    expect(FRAME_ENTRIES.indexOf('intro')).toBe(FRAME_ENTRIES.indexOf('help') - 1)
  })
})

if (!inChild) {
  test('the dialog, the modules list and the container, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MODULE_INTRO_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS + 4} pass`))
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Dialog: typeof import('../src/canvas/ModuleIntro.tsx')
let Lists: typeof import('../src/canvas/Modules.tsx')
let Box: typeof import('../src/canvas/Container.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let realFetch: typeof fetch

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Dialog = await import('../src/canvas/ModuleIntro.tsx')
  Lists = await import('../src/canvas/Modules.tsx')
  Box = await import('../src/canvas/Container.tsx')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  realFetch = globalThis.fetch
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
  globalThis.fetch = realFetch
  ;(window as unknown as { matchMedia?: unknown }).matchMedia = undefined
})

async function render(node: import('react').ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)))

/** The host's answers, by path: a function of how many times each was asked. */
function serve(routes: Record<string, (n: number, init?: RequestInit) => unknown>): string[] {
  const asked: string[] = []
  const counts = new Map<string, number>()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const path = url.split('?')[0]!
    const key = `${init?.method ?? 'GET'} ${path}`
    asked.push(key)
    const n = counts.get(key) ?? 0
    counts.set(key, n + 1)
    const route = routes[key]
    if (!route) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(route(n, init)), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return asked
}

const entry = (over: object = {}) => ({ id: 'kehikot.lists', name: 'Lists', repo: 'someone/lists', summary: 'One list.', tags: [], installed: false, ...over })

const press = (el: Element) => act(async () => (el as HTMLElement).click())
const addButton = () => document.querySelector<HTMLButtonElement>('[data-intro-add]')
const next = () => document.querySelector<HTMLButtonElement>('[data-intro-next]')

describe('the dialog', () => {
  if (!inChild) return

  test('shows the module’s slides in the app’s dialog: its name on top, text as text, the picture in the host’s shapes', async () => {
    await render(<Dialog.ModuleIntroDialog open onOpenChange={() => {}} id="kehikot.lists" name="Lists" intro={introFor({ intro: INTRO })} />)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Introduction to Lists')
    expect(document.querySelector('[data-intro-name]')!.textContent).toBe('Lists')
    expect(document.querySelectorAll('[data-intro-dot]')).toHaveLength(3)
    expect(dialog.textContent).toContain('One list <b>for</b> the work')
    expect(dialog.querySelector('b, i, a')).toBeNull()
    const art = dialog.querySelector('svg[data-intro-picture]')!
    expect(art.getAttribute('aria-label')).toBe('a list filling in')
    expect([...art.querySelectorAll('[data-shape]')].map((one) => one.getAttribute('data-shape'))).toEqual(['pane', 'rows', 'text', 'pointer'])
    expect(art.querySelector('[data-shape="rows"]')!.getAttribute('class')).toContain('ia-rise')
    expect(dialog.getAttribute('data-motion')).toBe('moving')
    /* No add button from the Container menu or the offer. */
    expect(addButton()).toBeNull()
    await press(next()!)
    await press(next()!)
    expect(document.querySelector('[data-intro-done]')).not.toBeNull()
  })

  test('with reduced motion the pictures stand still', async () => {
    ;(window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} })
    await render(<Dialog.ModuleIntroDialog open onOpenChange={() => {}} id="kehikot.lists" name="Lists" intro={introFor({ intro: INTRO })} />)
    expect(document.querySelector('[role="dialog"]')!.getAttribute('data-motion')).toBe('still')
  })

  test('no introduction: its How to use in the same dialog; neither: its summary; asked of the server when the manifest has none', async () => {
    const asked = serve({ 'GET /host/module-intro': () => ({ intro: null, from: null }) })
    await render(<Dialog.ModuleIntroDialog open onOpenChange={() => {}} id="kehikot.lists" name="Lists" help={HELP} />)
    await settle()
    expect(asked).toContain('GET /host/module-intro')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('How to use Lists')
    await press(next()!)
    expect([...document.querySelectorAll('[data-intro-points] li')].map((one) => one.textContent)).toEqual(['Press things.', 'Then more.'])
    act(() => unmount?.())
    document.body.innerHTML = ''
    await render(<Dialog.ModuleIntroDialog open onOpenChange={() => {}} id="kehikot.lists" name="Lists" summary="One list." />)
    await settle()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('One list.')
  })

  test('Add to this kehikko is on every slide, the main button on the last, and places the module', async () => {
    const placed: string[] = []
    await render(
      <Dialog.ModuleIntroDialog
        open
        onOpenChange={() => {}}
        id="kehikot.lists"
        name="Lists"
        intro={introFor({ intro: INTRO })}
        addable={{ open: true, placed: false, registered: true, onPlace: () => placed.push('kehikot.lists') }}
      />,
    )
    for (let i = 0; i < 3; i++) {
      expect(addButton()!.textContent).toBe('Add to this kehikko')
      expect(addButton()!.getAttribute('data-variant') ?? addButton()!.className).toMatch(i === 2 ? /default|bg-primary/ : /secondary/)
      if (i < 2) await press(next()!)
    }
    await press(addButton()!)
    expect(placed).toEqual(['kehikot.lists'])
  })

  test('already on this kehikko: said, and disabled', async () => {
    await render(
      <Dialog.ModuleIntroDialog open onOpenChange={() => {}} id="kehikot.lists" name="Lists" intro={introFor({ intro: INTRO })} addable={{ open: true, placed: true, registered: true, onPlace: () => {} }} />,
    )
    expect(addButton()!.textContent).toBe('Already on this kehikko')
    expect(addButton()!.disabled).toBe(true)
  })

  test('needs a newer Kehikot: said in app-version words, and disabled', async () => {
    serve({
      'GET /host/official': () => ({ modules: [entry({ newer: { protocol: '2.57.0', has: '2.55.0', app: '0.1.120' } })] }),
      'GET /host/module-intro': () => ({ intro: INTRO, from: 'release' }),
    })
    await render(<Dialog.ModuleIntroDialog open onOpenChange={() => {}} id="kehikot.lists" name="Lists" addable={{ open: true, placed: false, registered: false, onPlace: () => {} }} />)
    await settle()
    expect(addButton()!.textContent).toBe('Needs Kehikot 0.1.120 or later')
    expect(addButton()!.disabled).toBe(true)
  })

  test('not installed: Install and add takes the list’s install, shows its progress, then sweeps and places it', async () => {
    const placed: string[] = []
    let swept = 0
    const asked = serve({
      'GET /host/official': (n) => ({ modules: [n === 0 ? entry() : n === 1 ? entry({ install: { state: 'installing', step: 'cloning' } }) : entry({ installed: true })] }),
      'POST /host/official/install': () => ({ ok: true }),
      'GET /host/module-intro': () => ({ intro: INTRO, from: 'release' }),
    })
    await render(
      <Dialog.ModuleIntroDialog
        open
        onOpenChange={() => {}}
        id="kehikot.lists"
        name="Lists"
        addable={{ open: true, placed: false, registered: false, onPlace: () => placed.push('kehikot.lists'), onLookAgain: () => swept++ }}
      />,
    )
    await settle()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('One list <b>for</b> the work')
    expect(addButton()!.textContent).toBe('Install and add')
    await press(addButton()!)
    await settle()
    expect(asked).toContain('POST /host/official/install')
    expect(addButton()!.textContent).toBe('Cloning…')
    expect(addButton()!.disabled).toBe(true)
    await act(async () => new Promise((resolve) => setTimeout(resolve, Dialog.INSTALL_POLL_MS + 100)))
    await settle()
    expect(swept).toBe(1)
    expect(placed).toEqual(['kehikot.lists'])
  })
})

describe('the modules list and the container', () => {
  if (!inChild) return

  test('the "?" in the modules list opens the module’s introduction, with the add button', async () => {
    serve({ 'GET /host/module-intro': () => ({ intro: INTRO, from: 'installed' }) })
    const presence = {
      id: 'kehikot.lists',
      name: 'Lists',
      at: 'http://127.0.0.1:7870',
      condition: 'stopped',
      reached: false,
      line: '',
    } as unknown as Presence
    const registry: RegistryView = { presences: [presence], sweep: { dir: '/tmp/modules', rejected: [] }, protocol: 2 }
    const placed: string[] = []
    function Harness() {
      const [opened, setOpened] = React.useState<string | null>(null)
      return (
        <>
          <Lists.ModuleList registry={registry} onCanvas={new Set()} canvases={[]} open={null} onPlace={() => {}} onUnplace={() => {}} onIntro={(id) => setOpened(id)} />
          {opened ? (
            <Dialog.ModuleIntroDialog
              open
              onOpenChange={() => setOpened(null)}
              id={opened}
              name="Lists"
              addable={{ open: true, placed: false, registered: true, onPlace: () => placed.push(opened) }}
            />
          ) : null}
        </>
      )
    }
    await render(<Harness />)
    await press(document.querySelector('[data-module-help-button]')!)
    await settle()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('One list <b>for</b> the work')
    await press(addButton()!)
    expect(placed).toEqual(['kehikot.lists'])
  })

  test('a placed container: Introduction… before How to use… in its menu, and the offer strip once', async () => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList?.contains('container-grip') ? 380 : 0
      },
    })
    const presence = {
      id: 'kehikot.lists',
      at: 'http://127.0.0.1:7870',
      condition: 'ready',
      reached: true,
      name: 'Lists',
      line: '',
      agent: { kind: 'untold' },
      module: { ...manifestSchema.parse({ kind: 'kehikot.module', protocol: 2, entry: '/', partless: 'x', id: 'kehikot.lists', name: 'Lists', modes: [{ id: 'main', label: 'Main' }], help: HELP, intro: INTRO }) },
    } as unknown as Presence
    const did: string[] = []
    const nothing = () => {}
    await render(
      <Box.Container
        presence={presence}
        showing={{ kind: 'page' }}
        fault={null}
        body={nothing as never}
        grow={false}
        onGrow={nothing}
        pinned={false}
        onPin={nothing}
        collapsed={false}
        onFold={nothing}
        onCollapse={nothing}
        header={[]}
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
        onHelp={() => did.push('help')}
        onIntro={() => did.push('intro')}
        introOffer={{ said: 'Watch a 15-second introduction', onWatch: () => did.push('watch'), onDismiss: () => did.push('dismiss') }}
        onStarted={nothing}
        onRemove={nothing}
        kehikko="k"
        epic={null}
      />,
    )
    const offer = document.querySelector('[data-intro-offer]')!
    expect(offer.textContent).toContain('Watch a 15-second introduction')
    await press(offer.querySelector('[data-intro-watch]')!)
    await press(offer.querySelector('[data-intro-dismiss]')!)
    expect(did).toEqual(['watch', 'dismiss'])
    const trigger = document.querySelector<HTMLElement>('header [data-menu="frame"]')!
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    })
    const rows = [...document.querySelectorAll('[data-menu-content="frame"] [data-frame]')].map((one) => one.getAttribute('data-frame'))
    expect(rows.indexOf('intro')).toBe(rows.indexOf('help') - 1)
    expect(document.querySelector('[data-frame="intro"]')!.textContent).toBe('Introduction…')
  })
})
