import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The hooks moved out of `App.tsx`, run as the page runs them:
 *
 *   - `useAgentMarks`: a fold or an arrangement somebody other than the person
 *     made is marked, the mark goes once what is drawn is no longer what was
 *     left, and Undo hands back the arrangement before.
 *   - `useTrackerReading`: read on a project switch, and an answer about a
 *     project that is no longer open is dropped, from the read on the switch,
 *     from the host's news, and from "Refresh all".
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.APP_HOOKS_DOM === '1'
const TESTS = 5

if (!inChild) {
  test('the hooks out of App.tsx, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, APP_HOOKS_DOM: '1' },
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
let Marks: typeof import('../src/app/useAgentMarks.ts')
let Reading: typeof import('../src/app/useTrackerReading.ts')

const realFetch = globalThis.fetch

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Marks = await import('../src/app/useAgentMarks.ts')
  Reading = await import('../src/app/useTrackerReading.ts')
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  if (!inChild) return
  globalThis.fetch = realFetch
  document.body.innerHTML = ''
})

/** Render a hook in a component and hand back what it returned last, and a way to render it again. */
async function mountHook<A, R>(hook: (arg: A) => R, first: A) {
  const out: { current: R | null } = { current: null }
  function Probe({ arg }: { arg: A }) {
    out.current = hook(arg)
    return null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Probe arg={first} />))
  return {
    get now(): R {
      return out.current as R
    },
    async render(arg: A) {
      await act(async () => root.render(<Probe arg={arg} />))
    },
    unmount: () => act(async () => root.unmount()),
  }
}

const place = (i: string, x: number, y: number, collapsed = false) => ({ i, x, y, w: 6, h: 10, wish: 10, collapsed })
const geometry = (p: ReturnType<typeof place>) => ({ i: p.i, x: p.x, y: p.y, w: p.w, h: p.h, wish: p.wish, collapsed: p.collapsed })

describe.if(inChild)('useAgentMarks', () => {
  test('a fold made by an agent is signed until the container is not as it was left', async () => {
    const left = { id: 1, placements: [place('a', 0, 0, true), place('b', 6, 0)] }
    const marks = await mountHook(Marks.useAgentMarks, left)
    await act(async () => marks.now.noteFold(1, { by: 'An agent', fold: ['a'], unfold: [] }))
    expect(marks.now.signed).toEqual({ kehikko: 1, marks: { a: { by: 'An agent', collapsed: true } } })
    /* The same arrangement drawn again keeps the very same mark. */
    const signed = marks.now.signed
    await marks.render({ id: 1, placements: [place('a', 0, 0, true), place('b', 6, 0)] })
    expect(marks.now.signed).toBe(signed)
    /* The person unfolded it: the mark goes with it. */
    await marks.render({ id: 1, placements: [place('a', 0, 0, false), place('b', 6, 0)] })
    expect(marks.now.signed).toBeNull()
    await marks.unmount()
  })

  test('an agent’s arrangement is marked, undone to what was before, and gone once the person moves it', async () => {
    const before = [place('a', 0, 0), place('b', 6, 0)]
    const after = [place('a', 6, 0), place('b', 0, 0)]
    const marks = await mountHook(Marks.useAgentMarks, { id: 1, placements: after })
    await act(async () => marks.now.noteArranged(1, { by: 'An agent', changed: ['a', 'b'], before: before.map(geometry), after: after.map(geometry) }))
    expect(marks.now.arrangeMark?.by).toBe('An agent')
    let undone: ReturnType<typeof marks.now.undoArranged> = null
    await act(async () => {
      undone = marks.now.undoArranged()
    })
    expect(undone!.map((p) => [p.i, p.x])).toEqual([['a', 0], ['b', 6]])
    expect(marks.now.arrangeMark).toBeNull()

    /* Marked again, then the person drags: the mark no longer stands, and Undo puts nothing back. */
    await act(async () => marks.now.noteArranged(1, { by: 'An agent', changed: ['a', 'b'], before: before.map(geometry), after: after.map(geometry) }))
    await marks.render({ id: 1, placements: [place('a', 12, 0), place('b', 0, 0)] })
    expect(marks.now.arrangeMark).toBeNull()
    await marks.unmount()
  })
})

/** A host that answers the tracker and the dispositions per project, when told to. */
function host() {
  const waiting: { url: string; answer: (body: unknown) => void }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/host/tracker/refresh') return new Response('{}', { status: 200 })
    return await new Promise<Response>((resolve) => {
      waiting.push({ url, answer: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })) })
    })
  }) as typeof fetch
  const reading = (refreshing = false, at: string | null = null) => ({ at, refreshing, sources: [] })
  return {
    waiting,
    async answer(match: string, body: unknown) {
      const at = waiting.findIndex((one) => one.url.includes(match))
      if (at < 0) throw new Error(`nothing asked ${match}: ${waiting.map((one) => one.url).join(', ')}`)
      const [one] = waiting.splice(at, 1)
      await act(async () => {
        one!.answer(body)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    },
    reading,
  }
}

describe.if(inChild)('useTrackerReading', () => {
  test('read on a project switch, and an answer for the project left is dropped', async () => {
    const server = host()
    const r = await mountHook(Reading.useTrackerReading, null as number | null)
    expect(server.waiting).toEqual([])
    expect(r.now.tracker).toEqual({ at: null, refreshing: false, sources: [] })

    await r.render(1)
    expect(server.waiting.map((one) => one.url).sort()).toEqual(['/host/dispositions?project=1', '/host/tracker?project=1'])
    await r.render(2)
    /* Project 1's reads land after the switch: aborted, so dropped. */
    await server.answer('tracker?project=1', server.reading(false, '2026-01-01T00:00:00.000Z'))
    expect(r.now.tracker.at).toBeNull()
    await server.answer('tracker?project=2', server.reading(false, '2026-02-02T00:00:00.000Z'))
    expect(r.now.tracker).toEqual({ at: '2026-02-02T00:00:00.000Z', refreshing: false, sources: [], project: 2 })
    await server.answer('dispositions?project=2', { dispositions: [] })
    expect(r.now.marks).toEqual([])
    await r.unmount()
  })

  test('the host’s news is taken only for the open project', async () => {
    const server = host()
    const r = await mountHook(Reading.useTrackerReading, 2 as number | null)
    await server.answer('tracker?project=2', server.reading())
    await server.answer('dispositions?project=2', { dispositions: [] })

    await act(async () => r.now.heard.read(1, { at: 'x', refreshing: true }))
    expect(r.now.tracker.refreshing).toBe(false)
    await act(async () => r.now.heard.read(2, { at: null, refreshing: true }))
    expect(r.now.tracker.refreshing).toBe(true)
    /* A read that landed re-reads the sources for the bar. */
    await act(async () => r.now.heard.read(2, { at: '2026-03-03T00:00:00.000Z', refreshing: false }))
    expect(r.now.tracker).toMatchObject({ at: '2026-03-03T00:00:00.000Z', refreshing: false })
    await server.answer('tracker?project=2', server.reading(false, '2026-03-03T00:00:00.000Z'))
    expect(r.now.tracker.project).toBe(2)

    const changes = [{ module: 'kehikot.x', epic: 'e', at: '2026-03-03T00:00:00.000Z' }] as never
    await act(async () => r.now.heard.rewritten(1, changes))
    expect(r.now.rewritten).toEqual([])
    await act(async () => r.now.heard.rewritten(2, changes))
    expect(r.now.rewritten).toBe(changes)

    await act(async () => r.now.heard.marked(1))
    expect(server.waiting).toEqual([])
    await act(async () => r.now.heard.marked(2))
    expect(server.waiting.map((one) => one.url)).toEqual(['/host/dispositions?project=2'])
    await r.unmount()
  })

  test('"Refresh all" shows the read running and lands what the host read', async () => {
    const server = host()
    const r = await mountHook(Reading.useTrackerReading, 3 as number | null)
    await server.answer('tracker?project=3', server.reading())
    await server.answer('dispositions?project=3', { dispositions: [] })

    await act(async () => r.now.onRefreshTrackers())
    expect(r.now.tracker.refreshing).toBe(true)
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await server.answer('tracker?project=3', server.reading(false, '2026-04-04T00:00:00.000Z'))
    expect(r.now.tracker).toMatchObject({ at: '2026-04-04T00:00:00.000Z', refreshing: false, project: 3 })
    await r.unmount()
  })
})
