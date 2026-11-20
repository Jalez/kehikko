import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * Going places (`app/useProjectSwitch.ts`), run as the page runs it: the
 * page's state, the hook, and the arrival that carries a jump on in another
 * project (`useAgentArrival`).
 *
 *   - an agent's `jump` within the project moves the kehikko and the epic,
 *     answers the press once the screen is there, and leaves a mark whose
 *     Go back restores the person's place exactly and takes the mark away;
 *   - a jump into another project waits for that project's epics: not while
 *     the project left's epics still stand, not while the new ones are read,
 *     only once they land;
 *   - a second jump while one into another project waits answers the first
 *     as declined.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.PROJECT_SWITCH_DOM === '1'
const TESTS = 3

if (!inChild) {
  test('going places, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, PROJECT_SWITCH_DOM: '1' },
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
let Hook: typeof import('../src/app/useProjectSwitch.ts')
let Subject: typeof import('../src/host/subject.ts')
let Press: typeof import('../src/host/presses.ts')

type Canvas = import('../src/host/canvases.ts').Canvas
type HeldEpics = import('../src/host/projects.ts').Epics

const realFetch = globalThis.fetch

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register({ url: 'http://127.0.0.1:7700/', settings: { disableIframePageLoading: true } })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Hook = await import('../src/app/useProjectSwitch.ts')
  Subject = await import('../src/host/subject.ts')
  Press = await import('../src/host/presses.ts')
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const project = (id: number) => ({ id, name: `p${id}`, path: `/w/p${id}`, epics: true, git: true, shared: false })
const PROJECTS = [project(1), project(2)]
const CANVASES = [
  { id: 1, key: 'main', name: 'Main', project: 1, placements: [] },
  { id: 2, key: 'side', name: 'Side', project: 1, placements: [] },
  { id: 3, key: 'other', name: 'Other', project: 2, placements: [] },
] as unknown as Canvas[]
const EPICS = { holds: true, epics: [{ slug: 'alpha', parts: [] }, { slug: 'beta', parts: [] }] } as unknown as HeldEpics

/** Every press answered to the host, in order. */
function host() {
  const answered: { id: string; ok: boolean; why: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/host/pressed') answered.push(JSON.parse(String(init?.body)))
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return answered
}

/** The page's state around the hook, as `App.tsx` keeps it; what it holds, readable. */
async function mount() {
  const page = {
    projectId: 1 as number | null,
    openId: 1 as number | null,
    epic: null as string | null,
    held: EPICS as HeldEpics | null,
    hook: null as unknown as ReturnType<typeof Hook.useProjectSwitch>,
    jumpedRef: null as unknown as { current: ((order: import('../src/host/canvases.ts').JumpOrder) => void) | null },
    setHeld: (_: HeldEpics | null) => {},
  }
  function Page() {
    const [projectId, setProjectId] = React.useState<number | null>(1)
    const [openId, setOpenId] = React.useState<number | null>(1)
    const [subjects, setSubjects] = React.useState<import('../src/host/subject.ts').Subjects>({})
    const [held, setHeld] = React.useState<HeldEpics | null>(EPICS)
    const [, setSelectedBy] = React.useState<Record<number, string | null>>({})
    const [, setShownTo] = React.useState<import('../src/host/navigate.ts').HeldShow | null>(null)
    const [, setTrouble] = React.useState<string | null>(null)
    /* The project's epics are cleared when it changes and read again there, as `App.tsx` does. */
    const first = React.useRef(true)
    React.useEffect(() => {
      if (first.current) {
        first.current = false
        return
      }
      setHeld(null)
    }, [projectId])
    const about = Subject.subjectOf(subjects, projectId)
    const open = CANVASES.find((one) => one.id === openId) ?? null
    const openRef = React.useRef(open)
    openRef.current = open
    const canvasesRef = React.useRef(CANVASES)
    const projectRef = React.useRef(projectId)
    projectRef.current = projectId
    const changeSubject = (edit: import('../src/host/subject.ts').SubjectEdit) => {
      const id = projectRef.current
      if (id !== null) setSubjects((was) => Subject.withEdit(was, id, edit))
    }
    const changeSubjectRef = React.useRef(changeSubject)
    changeSubjectRef.current = changeSubject
    const setSelectedByRef = React.useRef(setSelectedBy)
    const gotoHereRef = React.useRef<(call: import('../src/host/ask.ts').GotoCall, from?: string) => import('../src/host/ask.ts').GotoAnswer>(() => ({ outcome: 'declined', epic: null, why: '' }))
    const walkStepRef = React.useRef<(target: { epic: string; step: number }, from: string) => void>(() => {})
    const jumpedRef = React.useRef<((order: import('../src/host/canvases.ts').JumpOrder) => void) | null>(null)
    const presses = React.useMemo(() => new Press.Presses(), [])
    /* Another project, as the person's own switch opens it: its first kehikko. */
    const onProject = (id: number) => {
      setProjectId(id)
      setOpenId(CANVASES.find((one) => one.project === id)?.id ?? null)
    }
    const here = CANVASES.filter((one) => one.project === projectId)
    const hook = Hook.useProjectSwitch({
      projectId,
      openId,
      open,
      about,
      held,
      spaceTree: [],
      projects: PROJECTS,
      subjects,
      presses,
      openRef,
      canvasesRef,
      projectRef,
      setOpenId,
      onProject,
      changeSubjectRef,
      setSelectedByRef,
      setShownTo,
      setTrouble,
      gotoHereRef,
      walkStepRef,
      jumpedRef,
      later: { here: () => here, inbox: () => ({ act: () => Promise.resolve() }) as never },
    })
    Hook.useAgentArrival(hook.agentArrival, projectId, held)
    Object.assign(page, { projectId, openId, epic: about.epic, held, hook, jumpedRef, setHeld })
    return null
  }
  const node = document.createElement('div')
  document.body.append(node)
  const root = createRoot(node)
  await act(async () => root.render(<Page />))
  return { page, unmount: () => act(async () => root.unmount()) }
}

/** Long enough for the screen to be polled as arrived (`untilThere` looks every 100 ms). */
const arrive = () => act(async () => wait(260))

describe.if(inChild)('useProjectSwitch', () => {
  test('a jump within the project goes there, answers, and Go back restores the place exactly', async () => {
    const answered = host()
    const { page, unmount } = await mount()
    await act(async () => page.jumpedRef.current!({ id: 'j1', kehikko: 'side', epic: 'beta' }))
    await arrive()
    expect([page.openId, page.epic]).toEqual([2, 'beta'])
    expect(answered).toEqual([expect.objectContaining({ id: 'j1', ok: true })])
    const mark = page.hook.shownJumpMark!
    expect(mark.back).toMatchObject({ project: 1, kehikko: 'main', epic: null })
    expect(mark.to).toMatchObject({ project: 1, kehikko: 'side', epic: 'beta' })
    /* The same order again is not made twice. */
    await act(async () => page.jumpedRef.current!({ id: 'j1', kehikko: 'side', epic: 'beta' }))
    expect(answered).toHaveLength(1)

    await act(async () => page.hook.jumpBack())
    await arrive()
    expect([page.openId, page.epic]).toEqual([1, null])
    expect(page.hook.shownJumpMark).toBeNull()
    await unmount()
  })

  test('a jump into another project waits for that project’s epics to be read there', async () => {
    const answered = host()
    const { page, unmount } = await mount()
    await act(async () => page.jumpedRef.current!({ id: 'j2', project: 2 }))
    /* Switched, its epics cleared to be read: not arrived. */
    expect(page.projectId).toBe(2)
    expect(page.held).toBeNull()
    await act(async () => wait(150))
    expect(answered).toEqual([])
    /* Its epics land: the jump is carried on there, and answered once the screen shows it. */
    await act(async () => page.setHeld(EPICS))
    await arrive()
    expect(answered).toEqual([expect.objectContaining({ id: 'j2', ok: true })])
    expect(page.hook.shownJumpMark?.back).toMatchObject({ project: 1 })
    expect(page.hook.agentArrival.current).toBeNull()
    await unmount()
  })

  test('a second jump while one into another project waits declines the first', async () => {
    const answered = host()
    const { page, unmount } = await mount()
    await act(async () => page.jumpedRef.current!({ id: 'j3', project: 2 }))
    await act(async () => page.jumpedRef.current!({ id: 'j4', project: 1 }))
    await act(async () => wait(20))
    expect(answered[0]).toEqual(expect.objectContaining({ id: 'j3', ok: false, why: 'Another jump came first.' }))
    await unmount()
  })
})
