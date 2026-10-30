import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The sort switch inside the project, epic and kehikko dropdowns, rendered and
 * pressed: both orders, the special rows that stay put, the state announced,
 * and each press sent to the host. In a process of its own, as
 * `header-menus.test.tsx` explains: Radix decides at load whether it has a DOM.
 */

const inChild = process.env.PICKER_SORT_DOM === '1'
const TESTS = 7

if (!inChild) {
  test('the pickers’ sort switch, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, PICKER_SORT_DOM: '1' },
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
let Projects: typeof import('../src/canvas/Projects.tsx').Projects
let Epics: typeof import('../src/canvas/Epics.tsx').Epics
let Canvases: typeof import('../src/canvas/Canvases.tsx').Canvases
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let store: typeof import('../src/host/pickerStore.ts')
const realFetch = globalThis.fetch

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Projects } = await import('../src/canvas/Projects.tsx'))
  ;({ Epics } = await import('../src/canvas/Epics.tsx'))
  ;({ Canvases } = await import('../src/canvas/Canvases.tsx'))
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  store = await import('../src/host/pickerStore.ts')
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
const sent: Array<{ url: string; body: { picker?: Record<string, string> } | undefined }> = []
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
  store.resetPickerStore()
  sent.length = 0
  globalThis.fetch = realFetch
})

function hostSays() {
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    sent.push({ url, body })
    return Response.json(url === '/host/settings' ? { ok: true, picker: { projects: 'recent', epics: 'az', kehikot: 'recent', ...body?.picker } } : { ok: true })
  }) as never
}

async function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
}

async function openMenu(label: string) {
  const trigger = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
  })
  expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()
}

const rows = () => [...document.querySelectorAll('[role="menuitem"]')].map((one) => (one.textContent ?? '').trim())
const firstWords = (list: string[]) => list.map((text) => (text.split(/\s+/)[0] ?? '').replace(/\d+$/, ''))
const choice = (word: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((one) => one.textContent === word)!
const press = async (element: HTMLElement) => {
  await act(async () => element.click())
  await act(async () => {})
}

const project = (id: number, name: string) => ({ id, name, path: `/p/${name}`, epics: true, git: true, shared: true })
const epic = (slug: string, title: string) => ({ slug, title, parts: [] })
const projects = [project(1, 'zebra'), project(2, 'mango'), project(3, 'apple'), project(4, 'quince')]
const noop = () => undefined

function drawProjects() {
  return mount(<Projects projects={projects} open={projects[0]!} onOpen={noop} onAdd={noop} onShare={noop} onForget={noop} />)
}

describe('the sort switch in each dropdown', () => {
  if (!inChild) return

  test('projects: Recent is first by default, the most recent visit on top, the never-visited A–Z after', async () => {
    hostSays()
    store.noteVisit({ project: 4 }, 100)
    store.noteVisit({ project: 2 }, 200)
    await drawProjects()
    await openMenu('switch project')
    expect(firstWords(rows().slice(0, 4))).toEqual(['mango', 'quince', 'apple', 'zebra'])
  })

  test('projects: A–Z reorders at once, keeps the menu open, and is sent to the host', async () => {
    hostSays()
    store.noteVisit({ project: 4 }, 100)
    await drawProjects()
    await openMenu('switch project')
    await press(choice('A–Z'))
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull()
    expect(firstWords(rows().slice(0, 4))).toEqual(['apple', 'mango', 'quince', 'zebra'])
    expect(sent.find((one) => one.url === '/host/settings')?.body).toEqual({ picker: { projects: 'az' } })
  })

  test('the switch is a labelled group of two, the state is checked and said in words', async () => {
    hostSays()
    await drawProjects()
    await openMenu('switch project')
    const group = document.querySelector('[role="group"][aria-label="order of projects"]')!
    expect(group.querySelectorAll('[role="menuitemradio"]').length).toBe(2)
    expect(choice('Recent').getAttribute('aria-checked')).toBe('true')
    expect(choice('A–Z').getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector('[role="status"]')?.textContent).toBe('projects ordered recently visited first')
    await press(choice('A–Z'))
    expect(choice('A–Z').getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[role="status"]')?.textContent).toBe('projects ordered alphabetical')
  })

  test('a change the host refuses goes back, and does not throw into the page', async () => {
    globalThis.fetch = (async () => Response.json({ ok: false, why: 'no' }, { status: 400 })) as never
    await drawProjects()
    await openMenu('switch project')
    await press(choice('A–Z'))
    expect(choice('Recent').getAttribute('aria-checked')).toBe('true')
  })

  test('epics: keep today’s A–Z until changed; "All epics" and "no epic" stay in place under either order', async () => {
    hostSays()
    const held = { holds: true, epics: [epic('c', 'Cherry'), epic('a', 'Apricot'), epic('b', 'Banana')] }
    store.noteVisit({ project: 1, epic: 'c' }, 100)
    await mount(
      <Epics epic="b" held={held} hasProject project={1} onPick={noop} onPickAll={noop} onRetitle={async () => true} onCreate={async () => true} onDelete={noop} />,
    )
    await openMenu('the epic this project is on')
    expect(rows()[0]).toContain('All epics')
    expect(firstWords(rows().slice(1, 4))).toEqual(['Apricot', 'Banana', 'Cherry'])
    expect(rows().some((text) => text.includes('no epic'))).toBe(true)
    await press(choice('Recent'))
    expect(rows()[0]).toContain('All epics')
    expect(firstWords(rows().slice(1, 4))).toEqual(['Cherry', 'Apricot', 'Banana'])
    expect(rows().some((text) => text.includes('no epic'))).toBe(true)
    expect(rows().findIndex((text) => text.includes('no epic'))).toBeGreaterThan(3)
  })

  test('epics: a visit to the same slug in another project does not count', async () => {
    hostSays()
    const held = { holds: true, epics: [epic('a', 'Apricot'), epic('b', 'Banana')] }
    store.noteVisit({ project: 2, epic: 'b' }, 100)
    await mount(<Epics epic={null} held={held} hasProject project={1} onPick={noop} onRetitle={async () => true} onCreate={async () => true} onDelete={noop} />)
    await openMenu('the epic this project is on')
    await press(choice('Recent'))
    expect(firstWords(rows().slice(0, 2))).toEqual(['Apricot', 'Banana'])
  })

  test('kehikot: ordered by their own visits within the project, never-visited A–Z last', async () => {
    hostSays()
    const canvas = (id: number, key: string, name: string) => ({ id, key, name, project: 1, placements: [], connections: undefined }) as never
    store.noteVisit({ project: 1, kehikko: 'k2' }, 100)
    store.noteVisit({ project: 2, kehikko: 'k3' }, 900)
    await mount(
      <Canvases
        canvases={[canvas(1, 'k1', 'Wide'), canvas(2, 'k2', 'Narrow'), canvas(3, 'k3', 'Alpha')]}
        open={null}
        onOpen={noop}
        onRename={noop}
        onCreate={noop}
        onDelete={noop}
      />,
    )
    await openMenu('switch kehikko')
    expect(firstWords(rows().slice(0, 3))).toEqual(['Narrow', 'Alpha', 'Wide'])
  })
})
