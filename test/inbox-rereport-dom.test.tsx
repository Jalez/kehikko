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
 * Jalez/kehikko#195, the page's half: a module's new page that does not say
 * its list again within its grace has what the old page said closed, as
 * `unreported`; one that does keeps it. The host's own items are never closed
 * for having no container. Driven through `useInbox` against a real store,
 * over the real routes (`fetch` is the desk).
 *
 * In a process of its own, as `whats-new-dom.test.tsx` explains.
 */

const inChild = process.env.INBOX_REREPORT_DOM === '1'
const TESTS = 3

if (!inChild) {
  test('a module’s new page re-reports or its old word closes, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, INBOX_REREPORT_DOM: '1' },
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

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useInbox } = await import('../src/canvas/useInbox.ts'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const item = (id: string, state: ActivityItem['state'] = 'attention'): ActivityItem => ({ id, state, label: id, since: 5 })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Hook = ReturnType<typeof useInbox>

describe.if(inChild)('a module’s new page', () => {
  let db: Database
  let folder: string
  let project: number
  let inbox: Inbox
  let hook: Hook | null
  let unmount: () => void
  const realFetch = globalThis.fetch

  beforeEach(() => {
    db = openDb(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-inbox-rereport-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    inbox = new Inbox(db)
    const desk = inboxDesk({ inbox, pathOf: (id) => (id === project ? folder : undefined), changed: () => undefined })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1:4180')
      const response = await desk.route(new Request(url, init), url)
      return response ?? new Response('{}', { status: 404 })
    }) as typeof fetch
    hook = null
  })
  afterEach(() => {
    act(() => unmount())
    globalThis.fetch = realFetch
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  async function mount(alive: ReadonlySet<string>) {
    function Probe() {
      hook = useInbox({
        project,
        projects: [{ id: project, name: 'a project', path: folder }],
        alive,
        at: { epic: null, parts: [], kehikko: null },
        nameOf: (module) => module,
        graceMs: 30,
        rereportMs: 60,
      })
      return null
    }
    const node = document.createElement('div')
    document.body.append(node)
    const root = createRoot(node)
    await act(async () => root.render(<Probe />))
    unmount = () => root.unmount()
    /* The first read of the record. */
    await act(async () => wait(20))
  }

  test('one that says nothing: what the last page said closes as unreported, after the grace and not before', async () => {
    inbox.report(project, 'kehikot.paper', 'Paper', [item('review:e:main.tex')])
    await mount(new Set(['kehikot.paper']))
    expect(hook!.live.map((e) => e.id)).toEqual(['review:e:main.tex'])
    act(() => hook!.greeted('kehikot.paper'))
    await act(async () => wait(20))
    expect(inbox.open(project).map((e) => e.id)).toEqual(['review:e:main.tex'])
    await act(async () => wait(100))
    expect(inbox.all(project).map((e) => [e.id, e.how])).toEqual([['review:e:main.tex', 'unreported']])
    expect(hook!.live).toEqual([])
  })

  test('one that says its list again keeps what is still true', async () => {
    inbox.report(project, 'kehikot.claude', 'Claude', [item('s')])
    await mount(new Set(['kehikot.claude']))
    act(() => hook!.greeted('kehikot.claude'))
    act(() => void hook!.receive('kehikot.claude', [item('s')]))
    await act(async () => wait(120))
    expect(inbox.open(project).map((e) => [e.id, e.how])).toEqual([['s', null]])
    expect(hook!.live.map((e) => e.id)).toEqual(['s'])
  })

  test('the host’s own items stand without a container; a module with none closes as silent', async () => {
    inbox.report(project, 'kehikko', 'Kehikot', [item('place-ask:x')])
    inbox.report(project, 'kehikot.gone', 'Gone', [item('a')])
    await mount(new Set())
    await act(async () => wait(100))
    expect(inbox.all(project).map((e) => [e.module, e.closed === null, e.how])).toEqual([
      ['kehikko', true, null],
      ['kehikot.gone', false, 'silent'],
    ])
  })
})
