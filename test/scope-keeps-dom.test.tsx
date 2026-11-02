import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A container's scope keeps its page, rendered: the layer of pages, fed the
 * way `App.tsx` feeds it (the kehikot kept, `framesKept` with each
 * container's scope, and the record of what is loaded), keeps the same
 * document for a page at This computer when its kehikko and its project are
 * left, and for one at Project across its project's kehikot — but lets the
 * one at Project go with its project. A kept page on another kehikko is
 * hidden, inert and not told the open kehikko's context.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.SCOPE_KEEPS_DOM === '1'
const TESTS = 3

if (!inChild) {
  test('pages kept by their container’s scope, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, SCOPE_KEEPS_DOM: '1' },
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
let Layer: typeof import('../src/canvas/Frames.tsx')
let Talk: typeof import('../src/host/conversation.ts')
let Press: typeof import('../src/host/presses.ts')
let Ctx: typeof import('../src/host/context.ts')
let Kept: typeof import('../src/host/canvases.ts')
let Scope: typeof import('../src/host/scope.ts')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Layer = await import('../src/canvas/Frames.tsx')
  Talk = await import('../src/host/conversation.ts')
  Press = await import('../src/host/presses.ts')
  Ctx = await import('../src/host/context.ts')
  Kept = await import('../src/host/canvases.ts')
  Scope = await import('../src/host/scope.ts')
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

const nothing = () => {}
const inert = <T,>() => new Proxy({}, { get: () => nothing }) as T

type FramedModule = import('../src/host/registry.ts').FramedModule
type Canvas = import('../src/host/canvases.ts').Canvas

/* A module offering This computer and Project, This computer its default. */
const module = (id: string, port: number) =>
  ({
    id,
    name: id,
    version: '1.0.0',
    summary: '',
    entry: `http://127.0.0.1:${port}/`,
    icon: null,
    health: null,
    mcp: null,
    modes: [
      { id: 'all', label: 'All', scope: 'machine' },
      { id: 'here', label: 'Here', scope: 'project' },
      { id: 'one', label: 'One', scope: 'epic' },
    ],
    extensions: { emits: [], consumes: [] },
    declares: { uses: [] },
  }) as unknown as FramedModule

const registered = new Map<string, FramedModule>([
  ['kehikot.tests', module('kehikot.tests', 7901)],
  ['kehikot.notes', module('kehikot.notes', 7902)],
  ['kehikot.flows', module('kehikot.flows', 7903)],
])

const project = (id: number, name: string) => ({ id, name, path: `/w/${name}`, epics: true, git: true, shared: false })
const PROJECTS = { 10: project(10, 'webapp'), 20: project(20, 'other') } as const

/* Kehikko 1 holds the three at This computer (default), Project, Epic. Kehikot 2, 3, 4, 5 of the
   same project and 6 of another hold only a module that is not registered here. */
const k = (id: number, projectId: number, ...placements: { i: string; scope?: string | null }[]) =>
  ({ id, key: `k${id}`, name: `K${id}`, project: projectId, placements }) as unknown as Canvas
const canvases: Canvas[] = [
  k(1, 10, { i: 'kehikot.tests', scope: null }, { i: 'kehikot.notes', scope: 'project' }, { i: 'kehikot.flows', scope: null }),
  k(2, 10, { i: 'kehikot.missing' }),
  k(3, 10, { i: 'kehikot.missing' }),
  k(4, 10, { i: 'kehikot.missing' }),
  k(5, 10, { i: 'kehikot.missing' }),
  k(6, 20, { i: 'kehikot.missing' }),
]
/* kehikot.flows is at Epic on kehikko 1, by its pick. */
canvases[0]!.placements[2]!.scope = 'epic'

describe('the layer of pages, kept by scope', () => {
  if (!inChild) return

  /* What `App.tsx` does each render: the kehikot kept, the pages kept, the record of what is loaded. */
  async function app() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const loaded = new Set<string>()
    let recent: number[] = []
    const open = async (id: number) => {
      const here = canvases.find((one) => one.id === id)!
      recent = Kept.recentlyOpen(recent, id)
      const kept = Kept.framesKept(canvases, recent, (p) => Scope.keptScope(registered.get(p.i), p.scope))
      for (const one of [...loaded]) if (!kept.has(one)) loaded.delete(one)
      const onOpen = new Set(here.placements.map((p) => p.i))
      for (const p of here.placements) if (registered.has(p.i)) loaded.add(p.i)
      const framings: import('../src/canvas/Frames.tsx').Framing[] = [...loaded].sort().map((one) => ({
        module: registered.get(one)!,
        generation: 0,
        rect: onOpen.has(one) ? { x: 0, y: 0, width: 400, height: 300 } : null,
        shown: onOpen.has(one),
        away: !onOpen.has(one),
        state: null,
        pinned: false,
        prompt: null,
        filters: {},
        scope: 'machine',
        covers: null,
      }))
      const context = Ctx.toWireContext({ epic: `epic-of-${id}`, project: PROJECTS[here.project as 10 | 20] }, 'light')
      await act(async () => {
        root.render(
          <Layer.Frames
            framings={framings}
            context={context}
            canvas={inert()}
            bus={{ join: nothing, leave: nothing } as unknown as import('../src/host/events.ts').EventBus}
            presses={new Press.Presses()}
            watcherFor={() => inert()}
            onDocument={nothing}
            moving={null}
          />,
        )
      })
    }
    unmount = () => root.unmount()
    const frame = (id: string) => host.querySelector<HTMLElement>(`[data-frame="${id}"]`)
    const iframe = (id: string) => frame(id)?.querySelector('iframe') ?? null
    return { open, frame, iframe }
  }

  test('a page at This computer keeps its document when its kehikko is left, past the kehikot kept, and into another project', async () => {
    const { open, frame, iframe } = await app()
    await open(1)
    const document = iframe('kehikot.tests')
    expect(document).not.toBeNull()
    for (const next of [2, 3, 4, 5, 6]) {
      await open(next)
      expect(iframe('kehikot.tests')).toBe(document)
    }
    /* Hidden and inert, as every kept page on another kehikko is. */
    expect(frame('kehikot.tests')!.style.visibility).toBe('hidden')
    expect(frame('kehikot.tests')!.hasAttribute('inert')).toBe(true)
    /* And the page at Epic went with its kehikko, as today. */
    expect(iframe('kehikot.flows')).toBeNull()
    /* Back on its kehikko, the same document, shown. */
    await open(1)
    expect(iframe('kehikot.tests')).toBe(document)
    expect(frame('kehikot.tests')!.style.visibility).toBe('visible')
  })

  test('a page at Project keeps its document across its project’s kehikot, and is let go with the project', async () => {
    const { open, iframe } = await app()
    await open(1)
    const document = iframe('kehikot.notes')
    expect(document).not.toBeNull()
    /* More kehikot of the same project than are kept. */
    for (const next of [2, 3, 4, 5]) {
      await open(next)
      expect(iframe('kehikot.notes')).toBe(document)
    }
    await open(6)
    expect(iframe('kehikot.notes')).toBeNull()
  })

  test('a kept page in another project is not told that project’s context', async () => {
    const told: { project: unknown; epic: unknown }[] = []
    const was = Talk.Conversation.prototype.sendContext
    Talk.Conversation.prototype.sendContext = function (context) {
      told.push({ project: context.project, epic: context.epic })
      return was.call(this, context)
    }
    try {
      const { open } = await app()
      await open(1)
      const before = told.length
      /* Only the page at This computer is still loaded in the other project. */
      await open(6)
      expect(told.slice(before).some((one) => one.project === 'other' || one.epic === 'epic-of-6')).toBe(false)
    } finally {
      Talk.Conversation.prototype.sendContext = was
    }
  })
})
