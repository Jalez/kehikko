import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/*
 * The introduction, the tour and the layout picker, rendered. In a process of
 * its own for the reason `header-menus.test.tsx` gives: Radix decides at load
 * whether it has a DOM.
 */

const inChild = process.env.ONBOARDING_DOM === '1'
const TESTS = 8

if (!inChild) {
  test('the introduction, the tour and the layout picker, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, ONBOARDING_DOM: '1' },
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
let Onboarding: typeof import('../src/canvas/Onboarding.tsx')
let Layouts: typeof import('../src/canvas/Layouts.tsx')
let Bar: typeof import('../src/canvas/Bar.tsx')
let Box: typeof import('../src/canvas/Container.tsx')
let tour: typeof import('../src/host/tour.ts')
let onboarding: typeof import('../src/host/onboarding.ts')
let layouts: typeof import('../src/host/layouts.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

/** Every request the page made, and what the fake host answers. */
let asked: Array<{ url: string; method: string; body: unknown }> = []
let answer: (url: string, method: string) => unknown = () => null

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    asked.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    const body = answer(url, method)
    return new Response(body === null ? '{}' : JSON.stringify(body), { status: body === null ? 404 : 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Onboarding = await import('../src/canvas/Onboarding.tsx')
  Layouts = await import('../src/canvas/Layouts.tsx')
  Bar = await import('../src/canvas/Bar.tsx')
  Box = await import('../src/canvas/Container.tsx')
  tour = await import('../src/host/tour.ts')
  onboarding = await import('../src/host/onboarding.ts')
  layouts = await import('../src/host/layouts.ts')
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
  asked = []
  answer = () => null
})

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
  return host
}

const settle = (ms = 50) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

async function press(element: Element | null) {
  if (!element) throw new Error('nothing to press')
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

const nothing = () => {}

function host(state: { intro: number }) {
  answer = (url) => {
    if (url.startsWith('/host/onboarding')) return { intro: state.intro, tour: { at: null, finished: false } }
    if (url.startsWith('/host/settings')) return { settings: { asked: true } }
    return null
  }
  return (
    <Onboarding.OnboardingHost project={1} open={null} registered={new Map()} onMade={nothing} onFill={nothing} onInstalled={nothing} />
  )
}

describe('the introduction', () => {
  if (!inChild) return

  test('opens by itself when it has not been seen, walks its steps, and closing it says it was seen', async () => {
    await render(host({ intro: 0 }))
    await settle()
    const dialog = () => document.querySelector('[data-intro]')
    expect(dialog()?.getAttribute('data-intro')).toBe('project')
    /* Every step has its own picture, and a dot. */
    expect(document.querySelectorAll('[data-intro-dot]')).toHaveLength(6)
    for (const id of ['epics', 'kehikko', 'inbox', 'settings', 'last']) {
      await press(document.querySelector('[data-intro-next]'))
      expect(dialog()?.getAttribute('data-intro')).toBe(id)
      expect(document.querySelector('[data-intro-picture]')).not.toBeNull()
    }
    expect(document.querySelector('[data-intro-tour]')?.textContent).toContain('Take the tour')
    expect(document.querySelector('[data-intro-layouts]')?.textContent).toContain('Start with a suggested layout')
    await press(document.querySelector('[data-intro-layouts]'))
    await settle()
    expect(asked.some((one) => one.method === 'POST' && one.url === '/host/onboarding' && (one.body as { intro?: string }).intro === 'seen')).toBe(true)
    /* "Start with a suggested layout" opened the picker. */
    expect(document.querySelector('[data-layout-picker]')).not.toBeNull()
  })

  test('does not open by itself once seen, and the ? menu opens it again', async () => {
    await render(
      host({ intro: onboarding.INTRO_VERSION }),
    )
    await settle()
    expect(document.querySelector('[data-intro]')).toBeNull()
    await act(async () => onboarding.openIntro())
    expect(document.querySelector('[data-intro]')?.getAttribute('data-intro')).toBe('project')
    /* Skip closes it. */
    await press(document.querySelector('[data-intro-skip]'))
    expect(document.querySelector('[data-intro]')).toBeNull()
  })

  test('waits for a window already open, and opens when it closes', async () => {
    const blocker = document.createElement('div')
    blocker.setAttribute('role', 'dialog')
    document.body.appendChild(blocker)
    await render(host({ intro: 0 }))
    await settle()
    expect(document.querySelector('[data-intro]')).toBeNull()
    blocker.remove()
    await settle(400)
    expect(document.querySelector('[data-intro]')).not.toBeNull()
  })
})

describe('the help menu', () => {
  if (!inChild) return

  test('offers the introduction, the tour, and a resume when the tour was left part way', async () => {
    const { HelpMenu } = await import('../src/canvas/Help.tsx')
    await render(<HelpMenu read={async () => ({ intro: 1, tour: { at: 3, finished: false } })} />)
    const trigger = document.querySelector('[data-tour="help"]') as HTMLElement
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    })
    await settle()
    const items = [...document.querySelectorAll('[data-help]')].map((one) => one.getAttribute('data-help'))
    expect(items).toEqual(['intro', 'resume', 'tour', 'layouts'])
    expect(document.querySelector('[data-help="resume"]')?.textContent).toContain(`4/${tour.TOUR_STOPS.length}`)
  })
})

describe('the tour', () => {
  if (!inChild) return

  test('every stop resolves to an element of the bar and a container as they are drawn', async () => {
    const presence = { id: 'kehikot.paper', at: 'http://127.0.0.1:7870', condition: 'ready', reached: true, name: 'Paper', line: '' } as never
    const canvas = { id: 1, key: 'k', name: 'writing', project: 1, placements: [] } as never
    const project = { id: 1, name: 'proj', path: '/p', epics: true } as never
    await render(
      <>
        <Bar.Bar
          registry={{ presences: [] } as never}
          canvases={[canvas]}
          open={canvas}
          placed={[]}
          subject={{ epic: 'one', project } as never}
          projects={[project]}
          project={project}
          held={{ epics: [{ slug: 'one', title: 'One' }] } as never}
          onRetitleEpic={async () => true}
          onCreateEpic={async () => true}
          onDeleteEpic={nothing}
          onProject={nothing}
          onAddProject={nothing}
          onShareProject={nothing}
          onForgetProject={nothing}
          onOpen={nothing}
          onRename={nothing}
          onCreate={nothing}
          onDelete={nothing}
          onSubject={nothing}
          parts={[{ id: 'a', heading: 'A', refs: [], steps: 0 }]}
          pickedParts={[]}
          onParts={nothing}
          onPlace={nothing}
          onUnplace={nothing}
          focus="off"
          onFocus={nothing}
          theme="dark"
          onTheme={nothing}
          onTools={nothing}
          trouble={null}
          onLookAgain={nothing}
          looking={false}
          activity={{ epics: new Map(), parts: new Map(), kehikot: new Map(), kehikotCounts: new Map(), inbox: {
              entries: [], earlierCount: 0, at: { epic: 'one', kehikko: 'k' }, scope: 'here', onScope: nothing, names: () => '',
              tally: { needHere: 0, needElsewhere: 0, working: 0, finished: 0, unknown: 0 }, next: null, open: false,
              onOpenChange: nothing, onGo: nothing, onNext: nothing, onSee: nothing, onDismiss: nothing,
            } as never, worst: null }}
        />
        <div className="react-grid-item">
          <Box.Container
            presence={presence}
            showing={{ kind: 'page' } as never}
            fault={null}
            body={nothing}
            grow={false}
            onGrow={nothing}
            pinned={false}
            onPin={nothing}
            collapsed={false}
            onCollapse={nothing}
            header={[{ kind: 'run', id: 'compile', label: 'Compile' }] as never}
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
            kehikko="writing"
            epic={null}
          />
        </div>
      </>,
    )
    await settle()
    const shown = tour.stopsOnScreen(document, { layout: false }).map(({ stop }) => stop.id)
    expect(shown).toEqual(tour.TOUR_STOPS.map((stop) => stop.id))
    /* The Settings stop is the gear, by its own mark. */
    expect(tour.resolveStop(tour.TOUR_STOPS.find((one) => one.id === 'settings')!, document, false)?.getAttribute('aria-label')).toBe('Settings')
  })

  test('a stop whose element is not on screen is left out, and a resume starts at the next one that is', async () => {
    await render(<button data-tour="project">p</button>)
    const shown = tour.stopsOnScreen(document, { layout: false })
    expect(shown.map(({ stop }) => stop.id)).toEqual(['project'])
    const hidden = document.querySelector('[data-tour="project"]') as HTMLElement
    hidden.style.display = 'none'
    expect(tour.stopsOnScreen(document, { layout: false })).toEqual([])
    const all = tour.TOUR_STOPS.map((stop) => ({ stop }))
    expect(tour.startIndex(all.filter(({ stop }) => stop.id !== 'parts'), tour.TOUR_STOPS.findIndex((one) => one.id === 'parts'))).toBe(2)
    expect(tour.startIndex(all, null)).toBe(0)
  })

  test('is drawn in the app’s own tokens: the popover class, and a stylesheet that dresses it', async () => {
    const source = readFileSync(new URL('../src/canvas/Tour.ts', import.meta.url), 'utf8')
    expect(source).toContain('popoverClass: TOUR_CLASS')
    expect(source).toContain('allowKeyboardControl: true')
    expect(tour.TOUR_CLASS).toBe('kehikot-tour')
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    expect(css).toContain("@import 'driver.js/dist/driver.css'")
    const block = css.slice(css.indexOf('.driver-popover.kehikot-tour {'))
    for (const token of ['var(--popover)', 'var(--popover-foreground)', 'var(--border)', 'var(--radius)', 'font-family: inherit']) {
      expect(block).toContain(token)
    }
    /* Pinned exactly. */
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.dependencies['driver.js']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('the layout picker', () => {
  if (!inChild) return

  test('says what a layout would install, asks before installing, and installs only on that press', async () => {
    const used: Array<{ id: string; install: string[] }> = []
    const shelves = {
      builtIn: [...layouts.BUILT_IN_LAYOUTS],
      project: [{ id: 'team', from: 'project' as const, name: 'Team', summary: '', containers: [{ module: 'acme.secret', x: 0, y: 0, w: 4, h: 4 }] }],
      mine: [],
      trouble: [],
    }
    await render(
      <Layouts.LayoutPicker
        open
        onOpenChange={nothing}
        mode="new"
        project={1}
        registered={new Map([['kehikot.claude', 'Claude']])}
        load={async () => shelves}
        loadOfficial={async () => [{ id: 'kehikot.references', name: 'References', installed: false }]}
        onUse={async (layout, _available, install) => {
          used.push({ id: layout.id, install })
          return null
        }}
      />,
    )
    await settle()
    const card = (id: string) => document.querySelector(`[data-layout-card="${id}"]`)
    expect(card('builtin:blank')?.getAttribute('aria-pressed')).toBe('true')
    expect(card('builtin:start-simple')?.querySelector('[data-layout-availability]')?.textContent).toBe('will install References')
    expect(card('project:team')?.querySelector('[data-layout-availability]')?.textContent).toBe('not available: acme.secret')
    expect(card('builtin:start-simple')?.querySelector('[data-layout-preview]')).not.toBeNull()

    await press(card('builtin:start-simple'))
    await press(document.querySelector('[data-layout-create]'))
    /* Asked, not done. */
    expect(document.querySelector('[data-layout-confirm]')?.textContent).toContain('References')
    expect(used).toEqual([])
    await press(document.querySelector('[data-layout-install]'))
    expect(used).toEqual([{ id: 'start-simple', install: ['kehikot.references'] }])

    /* "Create without them" makes it with nothing installed. */
    await press(card('builtin:start-simple'))
    await press(document.querySelector('[data-layout-create]'))
    await press(document.querySelector('[data-layout-without]'))
    expect(used.at(-1)).toEqual({ id: 'start-simple', install: [] })
    /* A host never asked to install anything by itself. */
    expect(asked.filter((one) => one.url.includes('/install'))).toEqual([])
  })
})
