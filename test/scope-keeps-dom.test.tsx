import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * A container's scope keeps its page, rendered: the layer of pages, fed by
 * the page's own `useFramings` (`app/useFrames.ts`: the kehikot kept,
 * `framesKept` with each container's scope, and the record of what is
 * loaded, across renders as `App.tsx` runs it), keeps the same
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
let Frames: typeof import('../src/app/useFrames.ts')

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
  Frames = await import('../src/app/useFrames.ts')
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
  ({
    id,
    key: `k${id}`,
    name: `K${id}`,
    project: projectId,
    placements: placements.map((p, x) => ({ x: x * 8, y: 0, w: 8, h: 20, wish: 20, collapsed: false, pinned: false, selected: false, prompt: '', promptFor: null, filters: {}, ...p })),
  }) as unknown as Canvas
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

  /* Each registered module, read and answering: its page is what its container shows. */
  const byId = new Map(
    [...registered].map(([id, framed]) => [id, { id, at: framed.entry, condition: 'ready', line: '', module: framed } as unknown as import('../src/host/registry.ts').Presence]),
  )
  const live = Object.fromEntries([...registered.keys()].map((id) => [id, { condition: 'ready' as const, line: null, fault: null }]))
  const RECT = { x: 0, y: 0, width: 400, height: 300 }
  const none = new Map()
  const noSet = new Set<string>()
  const bus = { join: nothing, leave: nothing } as unknown as import('../src/host/events.ts').EventBus
  const presses = () => new Press.Presses()

  /* The layer of pages for the kehikko open, framed by the page's own `useFramings`, as `App.tsx` frames it. */
  function Page({ id, pressing }: { id: number; pressing: import('../src/host/presses.ts').Presses }) {
    const here = canvases.find((one) => one.id === id)!
    const rects = React.useMemo(() => Object.fromEntries(here.placements.map((p) => [p.i, RECT])), [here])
    const framings = Frames.useFramings({
      byId,
      canvases,
      open: here,
      openId: id,
      placements: here.placements,
      live,
      drawing: noSet,
      loadingCovers: none,
      staleOf: () => false,
      askedFor: id,
      restarts: { of: () => undefined },
      generations: {},
      rects,
      pinViews: none,
      readyVersions: none,
      expanded: null,
      about: {},
      footed: noSet,
      drawn: { rows: 'always' },
      keptHere: none,
      guidance: none,
    })
    const context = Ctx.toWireContext({ epic: `epic-of-${id}`, project: PROJECTS[here.project as 10 | 20] }, 'light')
    return (
      <Layer.Frames
        framings={framings}
        context={context}
        canvas={inert()}
        bus={bus}
        presses={pressing}
        watcherFor={() => inert()}
        onDocument={nothing}
        moving={null}
      />
    )
  }

  async function app() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const pressing = presses()
    const open = async (id: number) => {
      await act(async () => {
        root.render(<Page id={id} pressing={pressing} />)
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
