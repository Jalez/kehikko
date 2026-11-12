import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * "From another project" in the New kehikko dialog, rendered: the projects (recent first, searchable),
 * a project's kehikot as cards with their picture and "Not installed: …", the settings to take, and
 * Create. In a process of its own for the reason `onboarding-dom.test.tsx` gives: Radix decides at
 * load whether it has a DOM.
 *
 * happy-dom lays nothing out, so "does not overflow" is held here as the classes that make it so —
 * one column until there is room, every box allowed to shrink, every long line cut or wrapped — and
 * measured for real, at a phone width, in WebKit and Chromium by `dev/layout-chips.drive.mjs`.
 */

const inChild = process.env.FROM_PROJECT_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('From another project, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, FROM_PROJECT_DOM: '1' },
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
let Layouts: typeof import('../src/canvas/Layouts.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

type ElsewhereProject = import('../src/host/fromProject.ts').ElsewhereProject
type CopyTake = import('../src/host/fromProject.ts').CopyTake

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Layouts = await import('../src/canvas/Layouts.tsx')
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
})

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
}

const settle = (ms = 60) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

async function press(element: Element | null) {
  if (!element) throw new Error('nothing to press')
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

async function type(element: Element | null, value: string) {
  if (!element) throw new Error('nothing to type in')
  const input = element as HTMLInputElement
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const LONG = 'A project with an extraordinarily long name that nobody would ever type out in full'

const PROJECTS: ElsewhereProject[] = [
  {
    id: 2,
    name: LONG,
    path: '/Users/somebody/Projects/deeply/nested/long',
    visited: 300,
    missing: false,
    kehikot: [
      {
        id: 20,
        key: 'review',
        name: 'Review desk with a very long name that has to be cut by its card',
        containers: [
          { module: 'kehikot.one', x: 0, y: 0, w: 12, h: 28 },
          { module: 'kehikot.agent', x: 12, y: 0, w: 12, h: 28 },
          { module: 'kehikot.absent', x: 0, y: 28, w: 24, h: 28 },
        ],
        folded: 1,
        skills: ['review-first', 'write-tests'],
        primary: 'kehikot.agent',
        connections: true,
      },
      { id: 21, key: 'blank', name: 'Blank one', containers: [], folded: 0, skills: [], primary: null, connections: false },
    ],
  },
  { id: 3, name: 'Kollekti', path: '/p/kollekti', visited: 200, missing: false, kehikot: [] },
  { id: 4, name: 'Thesis', path: '/home/väitös', visited: null, missing: false, kehikot: [] },
]

const REGISTERED = new Map([
  ['kehikot.one', 'One'],
  ['kehikot.agent', 'Agent'],
])

function picker(more: Partial<React.ComponentProps<typeof Layouts.LayoutPicker>> = {}) {
  return (
    <Layouts.LayoutPicker
      open
      onOpenChange={() => {}}
      mode="new"
      project={1}
      registered={REGISTERED}
      load={async () => ({ builtIn: [], project: [], mine: [], trouble: [] })}
      loadOfficial={async () => [{ id: 'kehikot.absent', name: 'Absent', installed: false }]}
      onUse={async () => null}
      loadElsewhere={async () => PROJECTS}
      onCopy={async () => null}
      {...more}
    />
  )
}

describe('From another project', () => {
  if (!inChild) return

  test('offered only when a new kehikko is made and the page can copy', async () => {
    await render(picker())
    await settle()
    expect(document.querySelector('[data-layout-source-tab="project"]')?.textContent).toBe('From another project')
    expect(document.querySelector('[data-layout-source-tab="templates"]')?.getAttribute('aria-selected')).toBe('true')
    act(() => unmount?.())
    document.body.innerHTML = ''
    await render(picker({ mode: 'fill' }))
    await settle()
    expect(document.querySelector('[data-layout-source]')).toBeNull()
    act(() => unmount?.())
    document.body.innerHTML = ''
    await render(picker({ onCopy: undefined }))
    await settle()
    expect(document.querySelector('[data-layout-source]')).toBeNull()
  })

  test('the projects, recent first and searchable; the most recent is open with its kehikot as cards', async () => {
    await render(picker())
    await settle()
    await press(document.querySelector('[data-layout-source-tab="project"]'))
    await settle()
    const listed = () => [...document.querySelectorAll('[data-elsewhere-project]')].map((one) => one.getAttribute('data-elsewhere-project'))
    expect(listed()).toEqual(['2', '3', '4'])
    expect(document.querySelector('[data-elsewhere-project="2"]')?.getAttribute('aria-pressed')).toBe('true')
    /* Searched by name or folder, accents aside. */
    await type(document.querySelector('[data-elsewhere-search]'), 'vaitos')
    expect(listed()).toEqual(['4'])
    await type(document.querySelector('[data-elsewhere-search]'), 'nothing like it')
    expect(document.querySelector('[data-from-project]')?.textContent).toContain('No project matches')
    await type(document.querySelector('[data-elsewhere-search]'), '')

    const cards = [...document.querySelectorAll('[data-elsewhere-card]')]
    expect(cards.map((one) => one.getAttribute('data-elsewhere-card'))).toEqual(['review', 'blank'])
    const review = cards[0]!
    /* The picture with each module's icon, the module that is not here dashed. */
    expect([...review.querySelectorAll('[data-preview-module]')].map((one) => one.getAttribute('data-preview-module'))).toEqual(['kehikot.one', 'kehikot.agent', 'kehikot.absent'])
    for (const spot of review.querySelectorAll('[data-preview-module]')) expect(spot.querySelector('svg')).not.toBeNull()
    expect(review.querySelector('[data-preview-module="kehikot.absent"]')?.getAttribute('data-preview-state')).toBe('missing')
    expect(review.querySelector('[data-elsewhere-lacking]')?.textContent).toBe('Not installed: Absent')
    expect(review.textContent).toContain('3 containers · 1 folded or tiled · 2 skills · primary agent Agent · connection choices')
    expect(cards[1]!.querySelector('[data-elsewhere-lacking]')).toBeNull()

    /* Another project, and its kehikot instead. */
    await press(document.querySelector('[data-elsewhere-project="3"]'))
    expect(document.querySelectorAll('[data-elsewhere-card]')).toHaveLength(0)
    expect(document.querySelector('[data-from-project]')?.textContent).toContain('Kollekti has no kehikot.')
  })

  test('pick one, untick a settings group, name it and create: the copy is asked for with exactly that', async () => {
    const asked: Array<{ key: string; name: string; take: CopyTake }> = []
    await render(picker({ onCopy: async (from, name, take) => (asked.push({ key: from.key, name, take }), null) }))
    await settle()
    await press(document.querySelector('[data-layout-source-tab="project"]'))
    await settle()
    const create = () => document.querySelector('[data-layout-create]') as HTMLButtonElement
    /* Nothing picked, nothing to create. */
    expect(create().disabled).toBe(true)
    expect(document.querySelector('[data-elsewhere-take]')).toBeNull()

    await press(document.querySelector('[data-elsewhere-card="review"]'))
    expect(create().disabled).toBe(false)
    const box = (group: string) => document.querySelector(`[data-elsewhere-group="${group}"]`) as HTMLInputElement
    /* Every group on by default, skills included. */
    expect([box('general').checked, box('skills').checked, box('agents').checked]).toEqual([true, true, true])
    expect(document.querySelector('[data-elsewhere-take]')?.textContent).toContain('review-first, write-tests')
    const name = document.querySelector('#layout-name') as HTMLInputElement
    expect(name.placeholder).toBe('Review desk with a very long name that has to be cut by its card')

    await press(box('skills'))
    await type(name, 'My review')
    await press(create())
    await settle()
    expect(asked).toEqual([{ key: 'review', name: 'My review', take: { general: true, skills: false, agents: true } }])
  })

  test('nothing can push the dialog sideways: one column until there is room, every box shrinks, every long line is cut or wraps', async () => {
    await render(picker())
    await settle()
    await press(document.querySelector('[data-layout-source-tab="project"]'))
    await settle()
    await press(document.querySelector('[data-elsewhere-card="review"]'))
    const panel = document.querySelector('[data-from-project]')!
    const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/)
    /* Projects above kehikot on a narrow window; side by side, with a bounded list, from sm. */
    expect(classes(panel)).toContain('grid-cols-1')
    expect(classes(panel)).toContain('min-w-0')
    expect(classes(panel).some((one) => one.startsWith('sm:grid-cols-[minmax(0,'))).toBe(true)
    for (const section of panel.querySelectorAll(':scope > section')) expect(classes(section)).toContain('min-w-0')
    expect(classes(document.querySelector('[data-elsewhere-cards]'))).toContain('grid-cols-1')
    /* Each card shrinks and clips; its long name is cut and says itself in full. */
    for (const card of panel.querySelectorAll('[data-elsewhere-card]')) {
      expect(classes(card)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full', 'overflow-hidden']))
    }
    const title = [...panel.querySelectorAll('[data-elsewhere-card="review"] .truncate')].find((one) => one.textContent?.startsWith('Review desk'))!
    expect(title.getAttribute('title')).toBe('Review desk with a very long name that has to be cut by its card')
    expect(classes(document.querySelector('[data-elsewhere-lacking]'))).toContain('[overflow-wrap:anywhere]')
    /* A project's long name and folder are cut, with the whole in a title. */
    const row = panel.querySelector('[data-elsewhere-project="2"]')!
    expect(classes(row)).toContain('min-w-0')
    expect(row.querySelector(`.truncate[title="${LONG}"]`)).not.toBeNull()
    /* The settings' lines wrap. */
    for (const line of panel.querySelectorAll('[data-elsewhere-take] label > span > span:last-child')) {
      expect(classes(line)).toContain('[overflow-wrap:anywhere]')
    }
  })
})
