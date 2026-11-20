import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The kehikot from the server and back (`app/useCanvases.ts`), run as the page
 * runs it:
 *
 *   - the first read opens the remembered kehikko only within the project
 *     opened, and remembers both in this browser;
 *   - what is open is reported to the server BEFORE the sweep it is followed
 *     by, and only then is the server taken to have been asked about it;
 *   - a first read that fails says so in the page's trouble line;
 *   - the stream says what is open on its own URL and is opened again when
 *     that changes; a kehikko changed elsewhere is re-read after the pending
 *     writes are flushed; a project's epics are re-read only for the project
 *     open.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.USE_CANVASES_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('the kehikot from the server and back, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, USE_CANVASES_DOM: '1' },
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
let Hook: typeof import('../src/app/useCanvases.ts')
let Canvases: typeof import('../src/host/canvases.ts')

const realFetch = globalThis.fetch

/** Every stream opened, with what it is told. */
class FakeStream {
  static all: FakeStream[] = []
  readyState = 1
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  constructor(readonly url: string) {
    FakeStream.all.push(this)
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  say(body: unknown) {
    this.onmessage?.({ data: JSON.stringify(body) } as MessageEvent<string>)
  }
}

beforeAll(async () => {
  if (!inChild) return
  /* At an origin, as the page is: the stream's address is made from it. */
  GlobalRegistrator.register({ url: 'http://127.0.0.1:7700/', settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeStream
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Hook = await import('../src/app/useCanvases.ts')
  Canvases = await import('../src/host/canvases.ts')
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  if (!inChild) return
  globalThis.fetch = realFetch
  FakeStream.all = []
  window.localStorage.clear()
  document.body.innerHTML = ''
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const project = (id: number) => ({ id, name: `p${id}`, path: `/w/p${id}`, epics: true, git: true, shared: false })
const kehikko = (id: number, projectId: number) => ({ id, name: `k${id}`, project: projectId, placements: [] })

/** A host: answers each request from `answers` by path, and keeps every request in order. */
function host(answers: Record<string, () => unknown>) {
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    asked.push(`${init?.method ?? 'GET'} ${url}`)
    const path = url.split('?')[0]!
    const answer = answers[path]
    if (!answer) return new Response('{}', { status: 404 })
    const body = answer()
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return asked
}

/** The page's state for the hook, and the hook, in a component; what it was handed, readable. */
async function mount(options: { projectNow?: () => number | null; onLook?: () => void } = {}) {
  const seen = {
    canvases: [] as unknown[],
    projects: [] as unknown[],
    projectId: null as number | null,
    openId: null as number | null,
    trouble: null as string | null,
    askedFor: null as number | null,
    held: null as unknown,
    looks: 0,
    writer: null as null | ReturnType<typeof Hook.useCanvases>['writer'],
    setOpenId: (_: number | null) => {},
  }
  function Page() {
    const [canvases, setCanvases] = React.useState<import('../src/host/canvases.ts').Canvas[]>([])
    const [, setSubjects] = React.useState({})
    const [projects, setProjects] = React.useState<import('../src/host/projects.ts').Project[]>([])
    const [projectId, setProjectId] = React.useState<number | null>(null)
    const [openId, setOpenId] = React.useState<number | null>(null)
    const [trouble, setTrouble] = React.useState<string | null>(null)
    const [askedFor, setAskedFor] = React.useState<number | null>(null)
    const [held, setHeld] = React.useState<import('../src/host/projects.ts').Epics | null>(null)
    const nothing = React.useRef(null)
    const { writer } = Hook.useCanvases({
      openId,
      projectId,
      setCanvases,
      setSubjects,
      setProjects,
      setProjectId,
      setOpenId,
      setTrouble,
      setAskedFor,
      setHeld,
      orderedRef: nothing,
      addressedRef: nothing,
      jumpedRef: nothing,
      repostRef: nothing,
      inboxWokeRef: nothing,
      relistRef: nothing,
      later: {
        look: async () => {
          seen.looks += 1
          options.onLook?.()
        },
        take: () => {},
        projectNow: options.projectNow ?? (() => projectId),
        noteFold: () => {},
        noteArranged: () => {},
        heard: { marked: () => {}, read: () => {}, rewritten: () => {} },
      },
    })
    Object.assign(seen, { canvases, projects, projectId, openId, trouble, askedFor, held, writer, setOpenId })
    return null
  }
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  await act(async () => {
    root.render(<Page />)
    await settle()
  })
  return { seen, unmount: () => act(async () => root.unmount()) }
}

describe.if(inChild)('useCanvases', () => {
  test('the first read opens the remembered kehikko within the project opened, then reports it before the sweep', async () => {
    /* Kehikko 7 is remembered but belongs to project 2; project 1 is the one opened. */
    window.localStorage.setItem(Canvases.OPEN_KEY, '7')
    const asked = host({
      '/host/canvases': () => ({ canvases: [kehikko(5, 1), kehikko(6, 1), kehikko(7, 2)], projects: [project(1), project(2)], subjects: [] }),
      '/host/open': () => ({ started: true }),
    })
    const { seen, unmount } = await mount({ onLook: () => asked.push('look') })
    await act(settle)
    expect(asked[0]).toBe('GET /host/canvases?open=7')
    expect(seen.projectId).toBe(1)
    expect(seen.openId).toBe(5)
    expect(window.localStorage.getItem(Canvases.OPEN_KEY)).toBe('5')
    /* Reported, then swept (the report started something), then taken as asked. */
    expect(asked.indexOf('POST /host/open')).toBeGreaterThan(0)
    expect(asked.indexOf('look')).toBeGreaterThan(asked.indexOf('POST /host/open'))
    expect(seen.looks).toBe(1)
    expect(seen.askedFor).toBe(5)
    await unmount()
  })

  test('a first read that fails is said in the trouble line', async () => {
    host({ '/host/canvases': () => new Response('no', { status: 500 }) })
    const { seen, unmount } = await mount()
    await act(settle)
    expect(seen.trouble).toBe('Your kehikot could not be read: Kehikot answered with error 500. Reload the window to try again.')
    expect(FakeStream.all.length).toBe(1)
    await unmount()
  })

  test('the stream says what is open, and is opened again when that changes', async () => {
    host({
      '/host/canvases': () => ({ canvases: [kehikko(11, 3), kehikko(12, 3)], projects: [project(3)], subjects: [] }),
      '/host/open': () => ({ started: false }),
    })
    const { seen, unmount } = await mount()
    await act(settle)
    const first = FakeStream.all.at(-1)!
    expect(new URL(first.url, 'http://x').searchParams.get('kehikko')).toBe('11')
    await act(async () => {
      seen.setOpenId(12)
      await settle()
    })
    expect(first.closed).toBe(true)
    expect(new URL(FakeStream.all.at(-1)!.url, 'http://x').searchParams.get('kehikko')).toBe('12')
    await unmount()
    expect(FakeStream.all.at(-1)!.closed).toBe(true)
  })

  test('a kehikko changed elsewhere is re-read after the pending writes; epics only for the project open', async () => {
    const asked = host({
      '/host/canvases': () => ({ canvases: [kehikko(21, 4)], projects: [project(4)], subjects: [] }),
      '/host/open': () => ({ started: false }),
      '/host/canvas': () => ({}),
      '/host/epics': () => ({ holds: true, epics: [] }),
    })
    const { seen, unmount } = await mount({ projectNow: () => 4 })
    await act(settle)
    const stream = FakeStream.all.at(-1)!
    const sent = asked.length
    await act(async () => {
      stream.say({ kehikko: 21 })
      await settle()
      await settle()
    })
    expect(asked.slice(sent)).toContain('GET /host/canvases')
    expect(seen.canvases).toHaveLength(1)

    const before = asked.length
    await act(async () => {
      stream.say({ epics: 9 })
      await settle()
    })
    expect(asked.slice(before).some((one) => one.includes('/host/epics'))).toBe(false)
    await act(async () => {
      stream.say({ epics: 4 })
      await settle()
      await settle()
    })
    expect(asked.slice(before)).toContain('GET /host/epics?project=4')
    expect(seen.held).toEqual({ holds: true, epics: [] })
    await unmount()
  })
})
