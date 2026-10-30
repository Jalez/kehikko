import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

import type { Entry } from '../src/host/inbox.ts'
import type { InstalledModule, WhatsNewRecord } from '../src/host/whatsNew.ts'

/*
 * "You're mentioned in What's new", rendered: the Inbox item opens What's new
 * at its release with the handle marked (as text, never markup); the page
 * names the releases the person gets to the host; and a mention the host files
 * in the open project is news the toast and chime hear, while a tracker notice
 * there stays quiet as before.
 *
 * In a process of its own for the reason `whats-new-dom.test.tsx` gives.
 */

const inChild = process.env.WHATS_NEW_MENTION_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('"You\'re mentioned in What\'s new", rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, WHATS_NEW_MENTION_DOM: '1' },
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
let WhatsNew: typeof import('../src/canvas/WhatsNew.tsx')
let Rules: typeof import('../src/host/whatsNew.ts')
let Mentions: typeof import('../src/host/whatsNewMentions.ts')
let useInbox: typeof import('../src/canvas/useInbox.ts').useInbox
let TRACKER_NOTICES_MODULE: string
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let record: WhatsNewRecord
let modules: InstalledModule[]
let posted: { project: number; releases: { item: string; tag: string }[] }[]
let inboxSnaps: Record<number, { rev: number; open: Entry[]; earlier: number }>

const body = (tag: string) =>
  `### What's new\n- **Boards.** Thank you, @TP-coder and @tp-coder2! <3 <3 ${tag}\n- <img src=x onerror="window.hacked=1">\n\n<sub>Built from abc1234</sub>`

function answer(url: string, init?: RequestInit): Response {
  if (url.startsWith('/host/whats-new/mentions')) {
    posted.push(JSON.parse(String(init?.body)))
    return json({ told: 0 })
  }
  if (url.startsWith('/host/whats-new')) {
    if (init?.method === 'POST') return json({ record })
    return json({ record, modules, updating: [] })
  }
  if (url.startsWith('/host/releases')) return json({ releases: [] })
  if (url.startsWith('/host/release-notes')) {
    const query = new URL(url, 'http://x').searchParams
    const repo = query.get('repo')!
    const tag = query.get('tag')!
    return json({ repo, tag, name: tag, body: body(tag), url: `https://github.com/${repo}/releases/tag/${tag}`, publishedAt: null, prerelease: false })
  }
  if (url.startsWith('/host/inbox?')) {
    const project = Number(new URL(url, 'http://x').searchParams.get('project'))
    return json({ ok: true, ...(inboxSnaps[project] ?? { rev: 0, open: [], earlier: 0 }) })
  }
  return json({}, 404)
}

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (url: string, init?: RequestInit) => answer(String(url), init)) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  WhatsNew = await import('../src/canvas/WhatsNew.tsx')
  Rules = await import('../src/host/whatsNew.ts')
  Mentions = await import('../src/host/whatsNewMentions.ts')
  ;({ useInbox } = await import('../src/canvas/useInbox.ts'))
  ;({ TRACKER_NOTICES_MODULE } = await import('../src/host/trackerNotices.ts'))
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

const tick = (ms = 10) => act(async () => await new Promise((resolve) => setTimeout(resolve, ms)))
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await tick(15)
}

async function render(node: React.ReactNode) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const made = createRoot(root)
  await act(async () => made.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => made.unmount()
  await tick()
  return root
}

const module = (release: string, range: string[]): InstalledModule => ({
  id: 'kehikot.example',
  name: 'Example',
  repo: 'o/example',
  follows: 'release',
  position: { release, commit: null },
  range,
  works: {},
})

function fresh() {
  posted = []
  inboxSnaps = {}
}

if (inChild) {
  test('the item opens What’s new at its release, the mention marked as text', async () => {
    fresh()
    /* Acknowledged already: opened on demand, the row would show its installed release alone. */
    record = { app: null, modules: { 'kehikot.example': { release: 'v1.3.0', commit: null } }, show: true, told: Object.keys(Rules.NOTES) }
    modules = [module('v1.3.0', [])]
    await render(<WhatsNew.WhatsNewHost app={null} />)
    const id = Mentions.mentionId({ item: 'kehikot.example', tag: 'v1.2.0' }, 'tp-coder')!
    await act(async () => Rules.openWhatsNew(Mentions.parseMentionId(id)!))
    await until(() => !!document.querySelector('[data-focus] [data-mention]'))
    const selected = document.querySelector('[data-whats-new] [data-item][data-state="active"]')
    expect(selected?.getAttribute('data-item')).toBe('kehikot.example')
    const sections = [...document.querySelectorAll('[data-pane="kehikot.example"] [data-testid="release-notes-release"]')].map((one) => one.getAttribute('data-tag'))
    expect(sections).toEqual(['v1.3.0', 'v1.2.0'])
    const focused = document.querySelector('[data-focus]')!
    expect(focused.getAttribute('data-tag')).toBe('v1.2.0')
    expect([...focused.querySelectorAll('mark[data-mention]')].map((one) => one.textContent)).toEqual(['@TP-coder'])
    /* The notes are still text: the tag in them is characters, not an element. */
    expect(focused.querySelector('img')).toBeNull()
    expect(focused.textContent).toContain('<img src=x')
    /* The release not opened at has nothing marked. */
    expect(document.querySelector('[data-tag="v1.3.0"] mark')).toBeNull()
  })

  test('opened without a release, nothing is marked', async () => {
    fresh()
    record = { app: null, modules: { 'kehikot.example': { release: 'v1.3.0', commit: null } }, show: true, told: Object.keys(Rules.NOTES) }
    modules = [module('v1.3.0', [])]
    await render(<WhatsNew.WhatsNewHost app={null} />)
    await act(async () => Rules.openWhatsNew())
    await until(() => !!document.querySelector('[data-tag="v1.3.0"] .release-notes'))
    expect(document.querySelector('mark')).toBeNull()
    expect(document.querySelector('[data-focus]')).toBeNull()
  })

  test('the page names the releases the person gets, once, for the open project', async () => {
    fresh()
    record = { app: null, modules: { 'kehikot.example': { release: 'v1.0.0', commit: null } }, show: true, told: Object.keys(Rules.NOTES) }
    modules = [module('v1.2.0', ['v1.2.0', 'v1.1.0'])]
    await render(<WhatsNew.WhatsNewHost app={null} project={7} />)
    await until(() => posted.length > 0)
    await tick(50)
    expect(posted).toEqual([
      {
        project: 7,
        releases: [
          { item: 'kehikot.example', tag: 'v1.2.0' },
          { item: 'kehikot.example', tag: 'v1.1.0' },
        ],
      },
    ])
  })

  test('a mention filed in the open project is news the toast and chime hear; a tracker notice there, or a module’s item, is not', async () => {
    fresh()
    const told: string[] = []
    const entry = (module: string, id: string): Entry => ({
      module, name: 'Kehikot', id, state: 'done', label: id, priority: 'normal', refs: [],
      entered: Date.now(), opened: Date.now(), closed: null, how: null, seen: null, dismissed: null, origin: 'activity',
    })
    inboxSnaps[1] = { rev: 1, open: [], earlier: 0 }
    let refresh: ((id?: number, rev?: number | null) => void) | null = null
    function Probe() {
      const inbox = useInbox({
        project: 1,
        projects: [],
        alive: null,
        at: { epic: null, parts: [], kehikko: null },
        nameOf: (one) => one,
        notify: (one) => told.push(one.id),
      })
      refresh = inbox.refresh
      return null
    }
    await render(<Probe />)
    await tick(30)
    inboxSnaps[1] = {
      rev: 2,
      open: [
        entry(Mentions.MENTIONS_MODULE, 'mention:kehikot@v0.1.90:tp-coder'),
        entry(TRACKER_NOTICES_MODULE, 'github:github.com/o/r#12'),
        entry('kehikot.example', 'a-module-item'),
      ],
      earlier: 0,
    }
    await act(async () => refresh!(1, 2))
    await until(() => told.length > 0)
    await tick(30)
    expect(told).toEqual(['mention:kehikot@v0.1.90:tp-coder'])
    /* Read again: told once. */
    inboxSnaps[1] = { ...inboxSnaps[1], rev: 3 }
    await act(async () => refresh!(1, 3))
    await tick(50)
    expect(told).toEqual(['mention:kehikot@v0.1.90:tp-coder'])
  })
}
