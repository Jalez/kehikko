import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityItem } from 'kehikot-module-protocol'

import { open as openDb } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'
import { addProject } from '../server/projects.ts'

/*
 * "The notice of an instance that I have already opened keeps on reopening", and
 * an Inbox cluttered with what the person already went to. The same item — one
 * module, one id, its state and `since` unchanged — is never news again: no
 * toast and no chime (both are `notify`, the one decision), and what was seen
 * stays seen through a re-report, a module restart, a reload of the page and a
 * restart of the host. Only a real change is news again.
 *
 * Driven through `useInbox` against the real store over the real routes, as
 * `inbox-rereport-dom.test.tsx` is; `see` is what Open on an Inbox row or a
 * toast calls (`goToEntry` in App.tsx). In a process of its own, as that file
 * explains.
 */

const inChild = process.env.INBOX_SEEN_STICKS_DOM === '1'
const TESTS = 5

if (!inChild) {
  test('the same item is never news twice, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, INBOX_SEEN_STICKS_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 120_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let useInbox: typeof import('../src/canvas/useInbox.ts').useInbox
let isSeen: typeof import('../src/host/inbox.ts').isSeen

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useInbox } = await import('../src/canvas/useInbox.ts'))
  ;({ isSeen } = await import('../src/host/inbox.ts'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

type Hook = ReturnType<typeof useInbox>
type Told = { id: string; state: string; entered: number }

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MODULE = 'kehikot.claude'

describe.if(inChild)('the same Inbox item', () => {
  let db: Database
  let folder: string
  let project: number
  let inbox: Inbox
  let hook: Hook | null
  let told: Told[]
  let unmount: () => void
  const paths = new Map<number, string>()
  const realFetch = globalThis.fetch
  /* Newer than any page: a first list's item is news only when it says it is newer than the page. */
  const T = Date.now() + 60_000
  const item = (id: string, state: ActivityItem['state'], since: number): ActivityItem => ({ id, state, label: `session ${id}`, since })

  /** The host's server, as on a start: the routes over a store over the one database. */
  function serve() {
    inbox = new Inbox(db)
    const desk = inboxDesk({ inbox, pathOf: (id) => paths.get(id), changed: () => undefined })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1:4180')
      const response = await desk.route(new Request(url, init), url)
      return response ?? new Response('{}', { status: 404 })
    }) as typeof fetch
  }

  beforeEach(() => {
    db = openDb(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-inbox-seen-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    paths.set(project, folder)
    serve()
    hook = null
    told = []
    unmount = () => undefined
  })
  afterEach(() => {
    act(() => unmount())
    globalThis.fetch = realFetch
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  /** The page, as on a load. `notify` is what the chime and the toast are both told. */
  async function mount() {
    act(() => unmount())
    function Probe() {
      hook = useInbox({
        project,
        projects: [{ id: project, name: 'a project', path: folder }],
        alive: new Set([MODULE]),
        at: { epic: null, parts: [], kehikko: null },
        nameOf: () => 'Claude',
        graceMs: 10_000,
        rereportMs: 10_000,
        notify: (entry) => told.push({ id: entry.id, state: entry.state, entered: entry.entered }),
      })
      return null
    }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    await act(async () => root.render(<Probe />))
    unmount = () => root.unmount()
    await act(async () => wait(20))
  }
  async function report(list: ActivityItem[]) {
    act(() => void hook!.receive(MODULE, list))
    await act(async () => wait(30))
  }
  const entryOf = (id: string) => hook!.open.find((one) => one.id === id)

  test('a re-report is not news: not on a change elsewhere in the list, a module restart, a drop and return, or a reload', async () => {
    await mount()
    await report([item('a', 'done', T)])
    expect(told).toEqual([{ id: 'a', state: 'done', entered: T }])

    /* The list changes elsewhere, so the page posts it again: `a` is the same item. */
    await report([item('a', 'done', T), item('b', 'working', T)])
    /* The module's page restarted and says its list again. */
    act(() => hook!.greeted(MODULE))
    await report([item('b', 'working', T), item('a', 'done', T)])
    /* It dropped `a` for a moment, then said it again unchanged. */
    await report([item('b', 'working', T)])
    expect(entryOf('a')).toBeUndefined()
    await report([item('a', 'done', T), item('b', 'working', T)])
    expect(entryOf('a')).toMatchObject({ state: 'done', entered: T })
    /* The host page reloaded. */
    await mount()
    await report([item('a', 'done', T), item('b', 'working', T)])
    expect(told).toEqual([{ id: 'a', state: 'done', entered: T }])
  })

  test('Open marks it seen, and it stays seen through a re-report, a reload and a host restart', async () => {
    await mount()
    await report([item('a', 'done', T)])
    /* Open on its row or its toast: `goToEntry` sees a done item. */
    act(() => hook!.see([entryOf('a')!]))
    await act(async () => wait(30))
    expect(isSeen(entryOf('a')!)).toBe(true)
    expect(hook!.live).toEqual([])

    await report([item('a', 'done', T), item('b', 'working', T)])
    expect(isSeen(entryOf('a')!)).toBe(true)

    /* The host restarts: a new store over the same database, and a new page. */
    act(() => unmount())
    serve()
    await mount()
    expect(isSeen(entryOf('a')!)).toBe(true)
    act(() => hook!.greeted(MODULE))
    await report([item('a', 'done', T)])
    expect(isSeen(entryOf('a')!)).toBe(true)
    expect(hook!.live.map((one) => one.id)).toEqual([])
    expect(told).toEqual([{ id: 'a', state: 'done', entered: T }])
  })

  test('a real change is news again: a new turn that finishes, and a new question', async () => {
    await mount()
    await report([item('a', 'done', T)])
    act(() => hook!.see([entryOf('a')!]))
    await act(async () => wait(30))
    /* A new turn: working, then finished again with its own since. */
    await report([item('a', 'working', T + 1000)])
    await report([item('a', 'done', T + 2000)])
    expect(isSeen(entryOf('a')!)).toBe(false)
    /* A question, withdrawn when the person looked, then a new one. */
    await report([item('a', 'attention', T + 3000)])
    await report([])
    await report([item('a', 'attention', T + 4000)])
    expect(told).toEqual([
      { id: 'a', state: 'done', entered: T },
      { id: 'a', state: 'done', entered: T + 2000 },
      { id: 'a', state: 'attention', entered: T + 3000 },
      { id: 'a', state: 'attention', entered: T + 4000 },
    ])
  })

  test('in another project: an item that closed and came back unchanged is not news when the page reads it again', async () => {
    const other = addProject(db, mkdtempSync(join(tmpdir(), 'kehikko-inbox-seen-other-')), 'another project')
    if (!other.ok) throw new Error(other.why)
    const B = other.project.id
    const otherPath = other.project.path
    paths.set(B, otherPath)
    inbox.report(B, MODULE, 'Claude', [item('x', 'done', T)])
    act(() => unmount())
    function Probe() {
      hook = useInbox({
        project,
        projects: [{ id: project, name: 'a project', path: folder }, { id: B, name: 'another project', path: otherPath }],
        alive: new Set([MODULE]),
        at: { epic: null, parts: [], kehikko: null },
        nameOf: () => 'Claude',
        graceMs: 10_000,
        rereportMs: 10_000,
        notify: (entry) => told.push({ id: entry.id, state: entry.state, entered: entry.entered }),
      })
      return null
    }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    await act(async () => root.render(<Probe />))
    unmount = () => root.unmount()
    await act(async () => wait(30))
    expect(hook!.others.map((one) => one.entries.map((entry) => entry.id))).toEqual([['x']])
    /* Written by the module's page elsewhere (another window, or the module restarting slowly):
       it closes as unreported, and comes back as it was. Each write wakes this page. */
    inbox.report(B, MODULE, 'Claude', [], { unreported: true })
    act(() => hook!.refresh(B))
    await act(async () => wait(30))
    inbox.report(B, MODULE, 'Claude', [item('x', 'done', T)])
    act(() => hook!.refresh(B))
    await act(async () => wait(30))
    expect(hook!.others.map((one) => one.entries.map((entry) => entry.id))).toEqual([['x']])
    expect(told).toEqual([])
    /* A real change there is news. */
    inbox.report(B, MODULE, 'Claude', [item('x', 'attention', T + 1)])
    act(() => hook!.refresh(B))
    await act(async () => wait(30))
    expect(told).toEqual([{ id: 'x', state: 'attention', entered: T + 1 }])
  })

  test('what a module that moved since meant: the same state with a new since is news (the module keeps since steady)', async () => {
    /* The rule the modules are held to: `since` is when the thing entered its state. A module that
       re-stamped it on every re-send (the Claude and Codex modules did, on a view opening, closing,
       and every restart) made each re-send news — the reported repeat. Pinned so the contract is
       visible here: the host trusts `since`. */
    await mount()
    await report([item('a', 'done', T)])
    act(() => hook!.see([entryOf('a')!]))
    await act(async () => wait(30))
    await report([item('a', 'done', T + 5000)])
    expect(isSeen(entryOf('a')!)).toBe(false)
    expect(told.map((one) => one.entered)).toEqual([T, T + 5000])
  })
})
