import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { forgetEveryRead } from '../src/host/hostRead.ts'

/*
 * The introduction, the tour and the layout picker, rendered. In a process of
 * its own for the reason `header-menus.test.tsx` gives: Radix decides at load
 * whether it has a DOM.
 */

const inChild = process.env.ONBOARDING_DOM === '1'
const TESTS = 24

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
let Intro: typeof import('../src/canvas/Intro.tsx')
let Layouts: typeof import('../src/canvas/Layouts.tsx')
let Bar: typeof import('../src/canvas/Bar.tsx')
let Box: typeof import('../src/canvas/Container.tsx')
let Tour: typeof import('../src/canvas/Tour.ts')
let tour: typeof import('../src/host/tour.ts')
let onboarding: typeof import('../src/host/onboarding.ts')
let layouts: typeof import('../src/host/layouts.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

type TourView = import('../src/canvas/Tour.ts').TourView
type Facts = import('../src/host/tour.ts').Facts
type OnboardingState = import('../src/host/onboarding.ts').Onboarding

/** Every request the page made, and what the fake host answers. */
let asked: Array<{ url: string; method: string; body: unknown }> = []
let answer: (url: string, method: string, body: unknown) => unknown = () => null

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const sent = init?.body ? JSON.parse(String(init.body)) : null
    asked.push({ url, method, body: sent })
    const body = answer(url, method, sent)
    return new Response(body === null ? '{}' : JSON.stringify(body), {
      status: body === null ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Onboarding = await import('../src/canvas/Onboarding.tsx')
  Intro = await import('../src/canvas/Intro.tsx')
  Layouts = await import('../src/canvas/Layouts.tsx')
  Bar = await import('../src/canvas/Bar.tsx')
  Box = await import('../src/canvas/Container.tsx')
  Tour = await import('../src/canvas/Tour.ts')
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
let guides: Array<{ stop(): void }> = []
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  /* What the page read once per load is read again by the next test's page. */
  forgetEveryRead()
  for (const one of guides) one.stop()
  guides = []
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
  return { host, again: (next: React.ReactNode) => act(async () => root.render(<TooltipProvider>{next}</TooltipProvider>)) }
}

const settle = (ms = 80) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

async function press(element: Element | null) {
  if (!element) throw new Error('nothing to press')
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

async function openMenu(trigger: Element | null) {
  if (!trigger) throw new Error('no trigger')
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  await settle()
}

async function escape() {
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await settle()
}

const nothing = () => {}

/** A drawer that records what the guide would have drawn. */
function recorder() {
  const views: TourView[] = []
  return {
    views,
    get last(): TourView | null {
      return views.at(-1) ?? null
    },
    drawer: {
      show: (view: TourView) => void views.push(view),
      hide: nothing,
    },
  }
}

/** The fake host's onboarding row, changed by what the page posts. */
function remembering(start: Partial<OnboardingState> = {}) {
  let state: OnboardingState = { ...onboarding.NOT_STARTED, intro: onboarding.INTRO_VERSION, ...start }
  answer = (url, method, body) => {
    if (url.startsWith('/host/onboarding')) {
      if (method === 'POST') state = onboarding.edited(state, body as never)
      return state
    }
    if (url.startsWith('/host/settings')) return { settings: { asked: true } }
    return null
  }
  return {
    get state() {
      return state
    },
  }
}

function host(props: Partial<Parameters<typeof Onboarding.OnboardingHost>[0]> = {}) {
  return (
    <Onboarding.OnboardingHost
      project={1}
      open={null}
      registered={new Map()}
      onMade={nothing}
      onFill={nothing}
      onInstalled={nothing}
      layout={false}
      {...props}
    />
  )
}

describe('the introduction', () => {
  if (!inChild) return

  test('opens by itself with the welcome, walks the pitch in order, and ends on Show me around', async () => {
    remembering({ intro: 0 })
    const rec = recorder()
    await render(
      <>
        <button data-tour="project">project</button>
        {host({ drawer: rec.drawer })}
      </>,
    )
    await settle()
    const dialog = () => document.querySelector('[data-intro]')
    /* Welcome first: what it is, before anything about how. */
    expect(Intro.INTRO_SLIDES[0]!.id).toBe('welcome')
    expect(Intro.INTRO_SLIDES[0]!.title).toBe('Welcome to Kehikot')
    expect(dialog()?.getAttribute('data-intro')).toBe('welcome')
    expect(dialog()?.textContent).toContain('Welcome to Kehikot')
    expect(Intro.INTRO_SLIDES.map((one) => one.id)).toEqual(['welcome', 'together', 'keep-working', 'ways', 'agents', 'inbox', 'modules', 'yours'])
    expect(document.querySelectorAll('[data-intro-dot]')).toHaveLength(Intro.INTRO_SLIDES.length)
    /* It pitches; it does not explain controls — that is the tour's job. */
    const words = Intro.INTRO_SLIDES.map((one) => one.body).join(' ').toLowerCase()
    expect(words).not.toMatch(/drag|resize|from any corner|the gear/)
    for (const said of ['keep running', 'design, research, development, review, learning', '/kehikot-here', '/journey', '/factory', '/review-factory', 'alt+shift+n', 'releases', 'private modules', 'your computer', 'your team']) {
      expect(words).toContain(said)
    }
    for (const id of Intro.INTRO_SLIDES.slice(1).map((one) => one.id)) {
      await press(document.querySelector('[data-intro-next]'))
      expect(dialog()?.getAttribute('data-intro')).toBe(id)
      expect(document.querySelector('[data-intro-picture]')).not.toBeNull()
    }
    expect(document.querySelector('[data-intro-tour]')?.textContent).toContain('Show me around')
    expect(document.querySelector('[data-intro-explore]')?.textContent).toContain('I’ll explore myself')
    await press(document.querySelector('[data-intro-tour]'))
    await settle(150)
    expect(asked.some((one) => one.method === 'POST' && one.url === '/host/onboarding' && (one.body as { intro?: string }).intro === 'seen')).toBe(true)
    /* "Show me around" started the tour, at the project. */
    expect(rec.last?.title).toBe('Pick a project to start')
  })

  test('the five ways turn in the picture; with reduced motion every picture stands still', async () => {
    const was = window.matchMedia
    remembering()
    try {
      window.matchMedia = ((query: string) => ({
        matches: query.includes('reduce'),
        media: query,
        addEventListener: nothing,
        removeEventListener: nothing,
      })) as never
      await render(host())
      await act(async () => onboarding.openIntro())
      expect(document.querySelector('[data-intro]')?.getAttribute('data-motion')).toBe('still')
      for (let i = 0; i < 3; i++) await press(document.querySelector('[data-intro-next]'))
      expect(document.querySelector('[data-intro]')?.getAttribute('data-intro')).toBe('ways')
      expect([...document.querySelectorAll('[data-way]')].map((one) => one.getAttribute('data-way'))).toEqual([...Intro.WAYS])
      /* The first way stands for all five when still. */
      expect(document.querySelector('[data-way="design"]')?.getAttribute('class')).toContain('ia-first')
    } finally {
      window.matchMedia = was
    }
    /* The stylesheet stills every picture both ways: the dialog's own mark, and the media query. */
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    expect(css).toContain("[data-motion='still'] .intro-art *")
    const media = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(media).toContain('.intro-art *')
    expect(media).toContain('animation: none !important')
  })

  test('the close has a row of its own, above the picture, and never sits on it', async () => {
    remembering()
    await render(host())
    await act(async () => onboarding.openIntro())
    const close = document.querySelector('[data-intro-close]')!
    const top = document.querySelector('[data-intro-top]')!
    const art = document.querySelector('[data-intro-art]')!
    expect(top.contains(close)).toBe(true)
    expect(art.contains(close)).toBe(false)
    expect(top.contains(art)).toBe(false)
    /* The row comes first, the picture after it. */
    expect(top.compareDocumentPosition(art) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    /* The dialog's own corner ✕, absolutely placed over whatever is there, is not drawn as well. */
    expect([...document.querySelectorAll('[role="dialog"] .sr-only')].filter((one) => one.textContent === 'Close')).toHaveLength(0)
    await press(close)
    expect(document.querySelector('[data-intro]')).toBeNull()
  })

  test('does not open by itself once seen; Help opens it again; Skip closes it', async () => {
    remembering()
    await render(host())
    await settle()
    expect(document.querySelector('[data-intro]')).toBeNull()
    await act(async () => onboarding.openIntro())
    expect(document.querySelector('[data-intro]')?.getAttribute('data-intro')).toBe('welcome')
    await press(document.querySelector('[data-intro-skip]'))
    expect(document.querySelector('[data-intro]')).toBeNull()
  })

  test('waits for a window already open, and opens when it closes', async () => {
    remembering({ intro: 0 })
    const blocker = document.createElement('div')
    blocker.setAttribute('role', 'dialog')
    document.body.appendChild(blocker)
    await render(host())
    await settle()
    expect(document.querySelector('[data-intro]')).toBeNull()
    blocker.remove()
    await settle(400)
    expect(document.querySelector('[data-intro]')).not.toBeNull()
  })
})

describe('the help menu', () => {
  if (!inChild) return

  test('the introduction and the tour, Continue only while paused, and no layouts', async () => {
    const { HelpMenu } = await import('../src/canvas/Help.tsx')
    let state: OnboardingState = { intro: 2, tour: { step: null, paused: false, finished: false } }
    await render(<HelpMenu read={async () => state} />)
    const items = () => [...document.querySelectorAll('[data-help]')].map((one) => one.getAttribute('data-help'))
    await openMenu(document.querySelector('[data-tour="help"]'))
    expect(items()).toEqual(['intro', 'restart'])
    expect(document.querySelector('[data-help="restart"]')?.textContent).toBe('Take the tour')
    expect(document.querySelector('[data-help-menu]')?.textContent?.toLowerCase()).not.toContain('layout')
    await escape()

    state = { intro: 2, tour: { step: 'epic', paused: true, finished: false } }
    await openMenu(document.querySelector('[data-tour="help"]'))
    expect(items()).toEqual(['intro', 'continue', 'restart'])
    expect(document.querySelector('[data-help="continue"]')?.textContent).toContain('Continue tour')
    expect(document.querySelector('[data-help="restart"]')?.textContent).toBe('Restart tour')
  })
})

/** A page with the tour's controls on it, built by hand: what each step points at. */
function page(...extra: string[]) {
  document.body.innerHTML = `
    <div id="bar">
      <button data-tour="project">p</button>
      <button data-tour="epic">e</button>
      <button data-tour="parts">parts</button>
      <button data-tour="kehikko">k</button>
      <button data-inbox-control>inbox</button>
      <button data-tour="updates">u</button>
      <button data-tour="settings">s</button>
      <button data-tour="help">?</button>
    </div>
    ${extra.join('\n')}`
}

function add(html: string): HTMLElement {
  const holder = document.createElement('div')
  holder.innerHTML = html
  const element = holder.firstElementChild as HTMLElement
  document.body.appendChild(element)
  return element
}

const CONTAINER =
  '<div class="react-grid-item"><div data-module="kehikot.paper"><header class="container-grip">h<button data-menu="frame">f</button><span data-header-menus>m</span></header></div>' +
  ['nw', 'ne', 'sw', 'se'].map((c) => `<span class="react-resizable-handle react-resizable-handle-${c} corner-handle"></span>`).join('') +
  '</div>'

function guide(facts: Facts) {
  const rec = recorder()
  const said = { steps: [] as string[], paused: [] as string[], finished: 0 }
  const one = new Tour.Guide({
    facts: () => facts,
    onStep: (step) => said.steps.push(step),
    onPause: (step) => said.paused.push(step),
    onFinish: () => (said.finished += 1),
    drawer: rec.drawer,
    layout: false,
    patience: 0,
    settle: 5,
  })
  guides.push(one)
  return { one, rec, said }
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the tour waits for the person', () => {
  if (!inChild) return

  test('the project, the epic, the parts and the kehikko each move on only when done, following the menus as they open', async () => {
    page()
    const facts = { ...tour.NO_FACTS }
    const { one, rec, said } = guide(facts)
    one.start(null)
    expect(one.step).toBe('project')
    expect(rec.last).toMatchObject({ title: 'Pick a project to start', mode: 'wait', gotThis: true })
    /* Nothing to press past it: it waits for a project. */
    expect(rec.last?.next).toBeUndefined()
    one.refresh()
    await tick()
    expect(one.step).toBe('project')

    /* The menu opens: the tour points into it. */
    const item = add('<div role="menuitem" data-tour="add-project">add a project…</div>')
    await tick()
    expect(rec.last?.title).toBe('Add your project')
    expect(rec.last?.body).toContain('add a project…')
    /* The folder chooser opens: into that. */
    item.remove()
    const chooser = add('<div role="dialog"><button data-tour="add-folder">add this folder</button></div>')
    await tick()
    expect(rec.last?.title).toBe('Choose its folder')
    chooser.remove()

    facts.project = true
    one.refresh()
    await tick()
    expect(one.step).toBe('epic')
    expect(rec.last).toMatchObject({ title: 'Create your first epic', next: 'Skip for now' })
    const form = add('<div data-tour="epic-form">new epic</div>')
    await tick()
    expect(rec.last?.title).toBe('Name your epic')
    form.remove()
    facts.epic = true
    one.refresh()
    await tick()
    expect(one.step).toBe('parts')
    expect(rec.last?.next).toBe('Next')
    rec.last!.onNext()
    expect(one.step).toBe('kehikko')
    expect(rec.last?.title).toBe('Your kehikot live here')
    expect(rec.last?.next).toBeUndefined()
    const menu = add('<div role="menuitem" data-tour="new-kehikko">new kehikko…</div>')
    await tick()
    expect(rec.last?.title).toBe('Create your first kehikko')
    menu.remove()
    const picker = add('<div role="dialog"><button data-layout-create>Create kehikko</button></div>')
    await tick()
    expect(rec.last?.body).toContain('Design, Research, Development, Review or Learning')
    /* An empty kehikko made is not a kehikko made: still waiting. */
    one.refresh()
    await tick()
    expect(one.step).toBe('kehikko')

    picker.remove()
    add(CONTAINER)
    facts.kehikko = true
    one.refresh()
    await tick()
    expect(one.step).toBe('header')
    expect(rec.last).toMatchObject({ mode: 'show', next: 'Next', back: false })
    expect(said.steps).toEqual(['project', 'epic', 'parts', 'kehikko', 'header'])
  })

  test('the explanations: Next and Back over what is on screen, Done finishes', async () => {
    page(CONTAINER)
    const { one, rec, said } = guide({ project: true, projects: 1, epic: true, parts: false, kehikko: true })
    one.start(null)
    const ids = () => rec.views.map((view) => view.key.split(':')[0])
    expect(one.step).toBe('header')
    for (let i = 0; i < 7; i++) rec.last!.onNext()
    expect(ids()).toEqual(['header', 'frame', 'menus', 'corners', 'inbox', 'updates', 'settings', 'help'])
    expect(rec.last).toMatchObject({ next: 'Done', progress: '8 of 8', back: true })
    rec.last!.onBack()
    expect(one.step).toBe('settings')
    rec.last!.onNext()
    rec.last!.onNext()
    expect(said.finished).toBe(1)
    expect(one.running).toBe('idle')
  })

  test('skips what is done: everything done is the explanations only; a project and an epic start at the parts', async () => {
    page(CONTAINER)
    const all = guide({ project: true, projects: 2, epic: true, parts: false, kehikko: true })
    all.one.start(null)
    expect(all.one.step).toBe('header')
    all.one.stop()

    const some = guide({ project: true, projects: 1, epic: true, parts: false, kehikko: false })
    some.one.start(null)
    expect(some.one.step).toBe('parts')
    some.one.stop()

    const none = guide({ project: true, projects: 1, epic: false, parts: false, kehikko: false })
    none.one.start(null)
    expect(none.one.step).toBe('epic')
    /* With projects to pick from, the menu's words say so. */
    expect(tour.bodyOf(tour.TOUR_STEPS[0]!.frames[1]!, { ...tour.NO_FACTS, projects: 3 })).toContain('Pick one of your projects')
  })

  test('“I’ve got this” pauses where it is and points at Help; Escape does the same; Continue picks up at that step', async () => {
    page()
    const facts = { project: true, projects: 1, epic: false, parts: false, kehikko: false }
    const { one, rec, said } = guide(facts)
    one.start(null)
    expect(one.step).toBe('epic')
    rec.last!.onPause()
    expect(said.paused).toEqual(['epic'])
    expect(rec.last).toMatchObject({ title: 'Tour paused!', gotThis: false, next: 'Got it' })
    expect(rec.last?.body).toBe('If you’d like to continue where you left off, open the Help menu and click Continue tour.')
    expect(rec.last?.element.getAttribute('data-tour')).toBe('help')
    /* Help opened: the note has done its job. */
    const help = add('<div data-help-menu role="menu"></div>')
    await tick()
    expect(one.running).toBe('idle')
    help.remove()

    /* Continue: the same step. */
    one.start('epic')
    expect(one.step).toBe('epic')
    expect(rec.last?.title).toBe('Create your first epic')
    /* Escape pauses the same way — unless a menu or window is open, which Escape is closing. */
    const menu = add('<div role="menu"></div>')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(said.paused).toEqual(['epic'])
    menu.remove()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(said.paused).toEqual(['epic', 'epic'])
    expect(rec.last?.title).toBe('Tour paused!')

    /* Restart: from the first thing not done. */
    facts.epic = true
    one.start(null)
    expect(one.step).toBe('parts')
  })

  test('drawn by driver.js: every step has the “I’ve got this” box, and ticking it pauses', async () => {
    page()
    const facts = { ...tour.NO_FACTS }
    const paused: string[] = []
    const one = new Tour.Guide({ facts: () => facts, onStep: nothing, onPause: (step) => paused.push(step), onFinish: nothing, layout: false, settle: 5 })
    guides.push(one)
    one.start(null)
    await tick(50)
    const popover = document.querySelector('.driver-popover.kehikot-tour')
    expect(popover?.textContent).toContain('Pick a project to start')
    expect(document.documentElement.dataset.tourMode).toBe('wait')
    /* Waiting: the page stays usable. */
    expect(document.body.classList.contains('driver-active')).toBe(false)
    const box = popover?.querySelector<HTMLInputElement>('[data-tour-got-this]')
    expect(box?.closest('label')?.textContent).toBe(tour.GOT_THIS)
    box!.checked = true
    box!.dispatchEvent(new Event('change'))
    expect(paused).toEqual(['project'])
    await tick(50)
    expect(document.querySelector('.driver-popover.kehikot-tour')?.textContent).toContain('Tour paused!')
    one.stop()
    expect(document.documentElement.dataset.tourMode).toBeUndefined()
  })
})

describe('the tour in the app', () => {
  if (!inChild) return

  function controls(facts: Facts, drawer: ReturnType<typeof recorder>['drawer']) {
    return (
      <>
        <button data-tour="project">p</button>
        <button data-tour="epic">e</button>
        <button data-tour="parts">parts</button>
        <button data-tour="kehikko">k</button>
        <button data-tour="help">?</button>
        {host({ drawer, facts })}
      </>
    )
  }

  test('remembers each step, the pause and its step; Continue tour picks it up there; Restart starts from the first undone', async () => {
    const store = remembering()
    const rec = recorder()
    const facts = { project: true, projects: 1, epic: false, parts: false, kehikko: false }
    const { again } = await render(controls(facts, rec.drawer))
    await settle()
    await act(async () => onboarding.openTour('over'))
    await settle()
    expect(store.state.tour).toEqual({ step: 'epic', paused: false, finished: false })
    /* The epic is made: the app's facts move, the tour with them. */
    await again(controls({ ...facts, epic: true }, rec.drawer))
    await settle()
    expect(store.state.tour.step).toBe('parts')
    await act(async () => rec.last!.onPause())
    await settle()
    expect(store.state.tour).toEqual({ step: 'parts', paused: true, finished: false })
    expect(rec.last?.title).toBe('Tour paused!')
    await act(async () => onboarding.openTour('resume'))
    await settle()
    expect(rec.last?.title).toBe('Divide it into parts — if you like')
    expect(store.state.tour).toEqual({ step: 'parts', paused: false, finished: false })
    await act(async () => onboarding.openTour('over'))
    await settle()
    expect(store.state.tour.step).toBe('parts')
  })

  test('a tour left running picks up by itself when the page comes back', async () => {
    remembering({ tour: { step: 'kehikko', paused: false, finished: false } })
    const rec = recorder()
    await render(
      <>
        <button data-tour="kehikko">k</button>
        {host({ drawer: rec.drawer, facts: { project: true, projects: 1, epic: true, parts: false, kehikko: false } })}
      </>,
    )
    await settle(150)
    expect(rec.last?.title).toBe('Your kehikot live here')
  })

  test('every step’s control is found in the bar and a container as they are drawn', async () => {
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
          held={{ epics: [{ slug: 'one', title: 'One' }], holds: true } as never}
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
          activity={{
            epics: new Map(),
            parts: new Map(),
            kehikot: new Map(),
            kehikotCounts: new Map(),
            inbox: {
              entries: [],
              earlierCount: 0,
              at: { epic: 'one', kehikko: 'k' },
              scope: 'here',
              onScope: nothing,
              names: () => '',
              tally: { needHere: 0, needElsewhere: 0, working: 0, finished: 0, unknown: 0 },
              next: null,
              open: false,
              onOpenChange: nothing,
              onGo: nothing,
              onNext: nothing,
              onSee: nothing,
              onDismiss: nothing,
            } as never,
            worst: null,
          }}
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
    /* The controls themselves: each waiting step's last frame, and every explanation. */
    /* The corner handles belong to the grid, not the container: stand one in. */
    const example = tour.pickExample(document, false)!
    example.setAttribute(tour.EXAMPLE_ATTR, '')
    example.insertAdjacentHTML('beforeend', '<span class="react-resizable-handle react-resizable-handle-se corner-handle"></span>')
    for (const step of tour.TOUR_STEPS) {
      const frame = step.frames.at(-1)!
      expect([step.id, tour.resolveFrame(frame, document, false) !== null]).toEqual([step.id, true])
    }
    expect(tour.resolveFrame(tour.TOUR_STEPS.find((one) => one.id === 'settings')!.frames[0]!, document, false)?.getAttribute('aria-label')).toBe('Settings')
    /* Inside the menus: opened, each has the item the tour points at. */
    await openMenu(document.querySelector('[data-tour="project"]'))
    expect(document.querySelector('[data-tour="add-project"]')?.textContent).toContain('add a project…')
    await escape()
    await openMenu(document.querySelector('[data-tour="epic"]'))
    expect(document.querySelector('[data-tour="new-epic"]')?.textContent).toContain('new epic…')
    await escape()
    await openMenu(document.querySelector('[data-tour="parts"]'))
    expect(document.querySelector('[data-tour="parts-menu"]')).not.toBeNull()
    await escape()
    await openMenu(document.querySelector('[data-tour="kehikko"]'))
    expect(document.querySelector('[data-tour="new-kehikko"]')?.textContent).toContain('new kehikko…')
  })

  test('is drawn in the app’s own tokens, and waits without dimming or switching the page off', async () => {
    const source = readFileSync(new URL('../src/canvas/Tour.ts', import.meta.url), 'utf8')
    expect(source).toContain('popoverClass: TOUR_CLASS')
    expect(tour.TOUR_CLASS).toBe('kehikot-tour')
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    expect(css).toContain("@import 'driver.js/dist/driver.css'")
    const block = css.slice(css.indexOf('.driver-popover.kehikot-tour {'))
    for (const token of ['var(--popover)', 'var(--popover-foreground)', 'var(--border)', 'var(--radius)', 'font-family: inherit']) {
      expect(block).toContain(token)
    }
    expect(css).toContain("html[data-tour-mode='wait'] .driver-overlay")
    /* Pinned exactly. */
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.dependencies['driver.js']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('the layout picker', () => {
  if (!inChild) return

  test('offers the five ways first, says what a layout would install, and installs only on that press', async () => {
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
    const suggested = document.querySelector('[data-tour="layouts-suggested"]')!
    expect([...suggested.querySelectorAll('[data-layout-card]')].map((one) => one.getAttribute('data-layout-card'))).toEqual([
      'builtin:blank',
      'builtin:design',
      'builtin:research',
      'builtin:development',
      'builtin:review',
      'builtin:learning',
      'builtin:write-a-paper',
      'builtin:plan-an-epic',
      'builtin:start-simple',
    ])
    const card = (id: string) => document.querySelector(`[data-layout-card="${id}"]`)
    /* Each with its picture and its one line. */
    for (const id of ['design', 'research', 'development', 'review', 'learning']) {
      expect(card(`builtin:${id}`)?.querySelector('[data-layout-preview]')).not.toBeNull()
    }
    expect(card('builtin:design')?.textContent).toContain('Flows if installed')
    expect(card('builtin:blank')?.getAttribute('aria-pressed')).toBe('true')
    expect(card('builtin:start-simple')?.querySelector('[data-layout-availability]')?.textContent).toBe('will install References')
    expect(card('project:team')?.querySelector('[data-layout-availability]')?.textContent).toBe('not available: acme.secret')

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

  test('a card names its modules in a wrapping list that can shrink, shows the first few and says "+N more" for the rest', async () => {
    const names = Array.from({ length: 9 }, (_, i) => `Module number ${i + 1}`)
    const long = 'unbreakablemodulenamewithoutanyseparatorsatallinit'
    const many = { id: 'many', from: 'builtin' as const, name: 'Many', summary: '', containers: names.map((_, i) => ({ module: `kehikot.m${i}`, x: 0, y: i, w: 4, h: 1 })) }
    const few = { id: 'few', from: 'builtin' as const, name: 'Few', summary: '', containers: [0, 1].map((i) => ({ module: `kehikot.m${i}`, x: 0, y: i, w: 4, h: 1 })) }
    const one = { id: 'five', from: 'builtin' as const, name: 'Five', summary: '', containers: [0, 1, 2, 3, 4].map((i) => ({ module: `kehikot.m${i}`, x: 0, y: i, w: 4, h: 1 })) }
    const longest = { id: 'long', from: 'builtin' as const, name: 'Long', summary: '', containers: [{ module: 'kehikot.long', x: 0, y: 0, w: 4, h: 1 }] }
    await render(
      <Layouts.LayoutPicker
        open
        onOpenChange={nothing}
        mode="new"
        project={1}
        registered={new Map()}
        load={async () => ({ builtIn: [many, few, one, longest], project: [], mine: [], trouble: [] })}
        loadOfficial={async () => [
          ...names.map((name, i) => ({ id: `kehikot.m${i}`, name, installed: true })),
          { id: 'kehikot.long', name: long, installed: true },
        ]}
        onUse={async () => null}
      />,
    )
    await settle()
    const card = (id: string) => document.querySelector(`[data-layout-card="builtin:${id}"]`)!
    const chips = (id: string) => [...card(id).querySelectorAll('[data-layout-chip] .truncate')].map((el) => el.textContent)

    /* The list wraps, and it and everything in it may shrink below its content. */
    const list = card('many').querySelector('[data-layout-chips]')!
    expect(list.className).toContain('flex-wrap')
    expect(list.className).toContain('min-w-0')
    for (const chip of list.querySelectorAll('[data-layout-chip]')) {
      expect(chip.className).toContain('min-w-0')
      expect(chip.querySelector('.truncate')).not.toBeNull()
    }
    expect(card('many').className).toContain('min-w-0')

    /* The first few, then a count; the rest are in its tooltip, and a card never grows with them. */
    expect(chips('many')).toEqual(names.slice(0, layouts.CHIPS_SHOWN))
    expect(card('many').querySelector('[data-layout-more]')?.textContent).toBe(`+${names.length - layouts.CHIPS_SHOWN} more`)
    /* Short lists say everything; one over the limit is shown rather than hidden behind "+1 more". */
    expect(chips('few')).toEqual(names.slice(0, 2))
    expect(card('few').querySelector('[data-layout-more]')).toBeNull()
    expect(chips('five')).toEqual(names.slice(0, 5))
    expect(card('five').querySelector('[data-layout-more]')).toBeNull()

    /* A name is cut with an ellipsis and says itself in full. */
    const chip = card('long').querySelector('[data-layout-chip]')!
    expect(chip.getAttribute('title')).toBe(long)
    expect(chip.querySelector('.truncate')?.textContent).toBe(long)
  })
})

const ALL_DONE: Facts = { project: true, projects: 1, epic: true, parts: false, kehikko: true }
const HIDDEN = () => document.documentElement.classList.contains('focus-mode')
const stepOf = (rec: ReturnType<typeof recorder>) => rec.last?.key.split(':')[0]

describe('the tour and container headers', () => {
  if (!inChild) return

  /* A cookie jar that records every write (a blank page has none of its own). */
  const writes: string[] = []
  let jar = ''
  beforeAll(() => {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => jar,
      set: (value: string) => {
        writes.push(value)
        jar = value.split(';')[0]!
      },
    })
  })
  const hide = () => {
    document.documentElement.classList.add('focus-mode')
    jar = 'kehikko.focus=on'
    writes.length = 0
  }
  afterEach(() => {
    document.documentElement.classList.remove('focus-mode')
    jar = ''
    writes.length = 0
  })

  test('hidden headers are shown for the header stops, put back on leaving, pausing and finishing — and never written down', async () => {
    page(CONTAINER)
    hide()
    {
      const { one, rec } = guide(ALL_DONE)
      one.start(null)
      expect(stepOf(rec)).toBe('header')
      expect(HIDDEN()).toBe(false)
      expect(rec.last?.note).toBe(tour.HEADERS_NOTE)
      rec.last!.onNext()
      expect(stepOf(rec)).toBe('frame')
      expect(HIDDEN()).toBe(false)
      expect(rec.last?.note).toBeUndefined()
      rec.last!.onNext()
      rec.last!.onNext()
      expect(stepOf(rec)).toBe('corners')
      expect(HIDDEN()).toBe(true)
      rec.last!.onBack()
      expect(stepOf(rec)).toBe('menus')
      expect(HIDDEN()).toBe(false)
      /* Pausing. */
      one.pause()
      expect(HIDDEN()).toBe(true)
      /* Finishing. */
      one.start('header')
      expect(HIDDEN()).toBe(false)
      for (let i = 0; i < 7; i++) rec.last!.onNext()
      expect(HIDDEN()).toBe(true)
      rec.last!.onNext()
      expect(one.running).toBe('idle')
      expect(HIDDEN()).toBe(true)
      /* Stopping (the page going), and the page unloading. */
      one.start('header')
      expect(HIDDEN()).toBe(false)
      one.stop()
      expect(HIDDEN()).toBe(true)
      one.start('header')
      window.dispatchEvent(new Event('pagehide'))
      expect(HIDDEN()).toBe(true)
      one.stop()
      expect(writes).toEqual([])
      expect(document.cookie).toBe('kehikko.focus=on')
    }
  })

  test('headers that were already shown are left alone and the stop says nothing about them', () => {
    page(CONTAINER)
    const { one, rec } = guide(ALL_DONE)
    one.start(null)
    expect(HIDDEN()).toBe(false)
    expect(rec.last?.note).toBeUndefined()
    one.stop()
    expect(HIDDEN()).toBe(false)
  })

  test('a person who turned headers off themselves while the tour ran keeps them off', () => {
    page(CONTAINER)
    hide()
    const { one } = guide(ALL_DONE)
    one.start(null)
    jar = 'kehikko.focus=off'
    one.pause()
    expect(HIDDEN()).toBe(false)
  })

  test('a container off screen is scrolled into view, and the one with menus is the example', () => {
    page(
      '<div class="react-grid-item" id="bare"><div data-module="a"><header class="container-grip">a<button data-menu="frame">f</button></header></div></div>',
      '<div class="react-grid-item" id="menus"><div data-module="b"><header class="container-grip">b<button data-menu="frame">f</button><span data-header-menus>m</span></header></div></div>',
      '<div class="react-grid-item" id="folded"><div data-module="c"><div class="container-reveal" data-collapsed="true"><header class="container-grip" data-dense="true">c<button data-menu="frame">f</button><span data-header-menus>m</span></header></div></div></div>',
    )
    const menus = document.getElementById('menus')!
    let scrolled = 0
    let top = 5000
    menus.getBoundingClientRect = () => ({ top, bottom: top + 200, left: 10, right: 300, width: 290, height: 200, x: 10, y: top, toJSON() {} }) as DOMRect
    menus.scrollIntoView = () => {
      scrolled += 1
      top = 20
    }
    const { one, rec } = guide(ALL_DONE)
    one.start(null)
    expect(menus.hasAttribute('data-tour-example')).toBe(true)
    expect(document.getElementById('bare')!.hasAttribute('data-tour-example')).toBe(false)
    expect(document.getElementById('folded')!.hasAttribute('data-tour-example')).toBe(false)
    expect(scrolled).toBe(1)
    expect(rec.last?.element.closest('.react-grid-item')).toBe(menus)
    one.stop()
    expect(menus.hasAttribute('data-tour-example')).toBe(false)
  })

  test('with no unfolded container the header, Frame, menus and corner stops are left out, and the headers stay as they were', () => {
    page('<div class="react-grid-item"><div data-module="c"><div class="container-reveal" data-collapsed="true"><header class="container-grip" data-dense="true">c<button data-menu="frame">f</button></header></div></div></div>')
    hide()
    const { one, rec } = guide(ALL_DONE)
    one.start(null)
    expect(rec.views.map((view) => view.key.split(':')[0])[0]).toBe('inbox')
    expect(HIDDEN()).toBe(true)
    expect(tour.pickExample(document, false)).toBeNull()
  })

  test('the corner stop anchors on one corner and lights all four of the example only while it stands', async () => {
    page(CONTAINER)
    const drawn = new Tour.Guide({ facts: () => ALL_DONE, onStep: nothing, onPause: nothing, onFinish: nothing, layout: false, settle: 5 })
    guides.push(drawn)
    drawn.start('corners')
    await tick(50)
    expect(document.documentElement.hasAttribute('data-tour-corners')).toBe(true)
    const item = document.querySelector('.react-grid-item')!
    expect(item.hasAttribute('data-tour-example')).toBe(true)
    expect(item.querySelectorAll(':scope > .corner-handle')).toHaveLength(4)
    expect(document.querySelector('.driver-active-element')?.classList.contains('react-resizable-handle-se')).toBe(true)
    drawn.pause()
    await tick(50)
    expect(document.documentElement.hasAttribute('data-tour-corners')).toBe(false)
    drawn.stop()
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    expect(css).toContain("html[data-tour-corners] [data-tour-example] > .corner-handle::after")
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*html\[data-tour-corners\][^}]*animation: none/)
  })

  test('the layout name pills of the carousel keep a gap and fit the picture', () => {
    const names = ['Design', 'Research', 'Development', 'Review', 'Learning']
    const row = Intro.pillRow(names)
    for (let i = 1; i < row.length; i++) expect(row[i]!.x - (row[i - 1]!.x + row[i - 1]!.width)).toBeGreaterThanOrEqual(8)
    expect(row[0]!.x).toBeGreaterThanOrEqual(8)
    expect(row.at(-1)!.x + row.at(-1)!.width).toBeLessThanOrEqual(312)
    /* Development, the longest, has the widest pill. */
    expect(Math.max(...row.map((one) => one.width))).toBe(row[2]!.width)
  })
})
