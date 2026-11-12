import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

import { PAGE_ONLY } from '../server/guard.ts'
import { DEFAULT_SETTINGS, SETTINGS_TARGETS, type SettingsAnswer } from '../src/host/agentSettings.ts'
import { forgetEveryRead } from '../src/host/hostRead.ts'
import type { TrackerState } from '../src/host/projects.ts'
import type { ListedSource, TrackerListing } from '../src/host/trackerSources.ts'

/*
 * The bar's Trackers menu, which only says what was read, and Settings ›
 * Trackers, where everything about the trackers is changed. In a process of
 * its own for the reason `header-menus.test.tsx` gives (Radix decides at load
 * whether it has a DOM).
 */

const inChild = process.env.TRACKER_SETTINGS_DOM === '1'
const TESTS = 7

if (!inChild) {
  test('the trackers menu and Settings › Trackers, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TRACKER_SETTINGS_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)

  test('the routes the moved controls write to are still the page’s alone', () => {
    expect(PAGE_ONLY).toContain('/host/trackers')
    expect(PAGE_ONLY).toContain('/host/settings')
    expect(PAGE_ONLY).toContain('/host/messages/mute')
  })
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Settings: typeof import('../src/canvas/Settings.tsx')
let Reading: typeof import('../src/canvas/TrackerReading.tsx')
let AgentSettings: typeof import('../src/host/agentSettings.ts')

const realFetch = globalThis.fetch
/** What the page posted to `/host/trackers`. */
let posted: unknown[] = []

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Settings = await import('../src/canvas/Settings.tsx')
  Reading = await import('../src/canvas/TrackerReading.tsx')
  AgentSettings = await import('../src/host/agentSettings.ts')
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
  forgetEveryRead()
  document.body.innerHTML = ''
  globalThis.fetch = realFetch
  posted = []
})

const NOW = new Date().toISOString()
const LIMIT_NOTICE = "Kehikot's share of your GitHub GraphQL limit is used until 09:52 AM."

function source(over: Partial<ListedSource> = {}): ListedSource {
  return {
    tracker: 'github',
    host: 'github.com',
    repo: 'acme/app',
    default: true,
    listed: true,
    origin: 'remote',
    remote: 'origin',
    off: false,
    at: NOW,
    error: null,
    issues: 41,
    changes: 296,
    ...over,
  }
}

function listing(over: Partial<TrackerListing> = {}): TrackerListing {
  return {
    sources: [
      source(),
      source({ repo: 'acme/slow', default: false, origin: 'file', remote: null, error: 'Reading acme/slow timed out after 30 s. Try again.' }),
      source({ repo: 'acme/limited', default: false, origin: 'file', remote: null, error: LIMIT_NOTICE }),
    ],
    remotes: true,
    every: 15,
    broken: null,
    ...over,
  }
}

function tracker(over: Partial<TrackerListing> = {}): TrackerState {
  const l = listing(over)
  return { at: NOW, refreshing: false, project: 7, listing: l, sources: l.sources.map((s) => ({ tracker: s.tracker, host: s.host, repo: s.repo, default: s.default, listed: s.listed, at: s.at, error: s.error, refreshing: false })) }
}

function answer(over: Partial<SettingsAnswer> = {}): SettingsAnswer {
  return {
    ok: true,
    settings: { ...DEFAULT_SETTINGS, asked: true },
    status: { at: 1, running: false, problems: [], modules: [] },
    hook: { file: '/scratch/.claude/settings.json', on: false },
    skillsAt: '/scratch/.claude/skills',
    github: { share: 20 },
    ...over,
  }
}

/** `/host/trackers` answers every edit "changed", with the listing it was given. */
function answerEdits(l: TrackerListing) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) === '/host/trackers') {
      posted.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ outcome: 'changed', why: '', said: 'Changed.', listing: l }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
}

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  await act(async () => {})
  unmount = () => root.unmount()
}

const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 60))))
const buttonIn = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((one) => one.textContent?.trim() === text) as HTMLButtonElement
const button = (text: string) => buttonIn(document, text)

async function openMenu() {
  const trigger = document.querySelector('button[aria-label]') as HTMLButtonElement
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger.click()
  })
  await act(async () => {})
  return document.querySelector('[data-tracker-menu]')!
}

test('the menu says only what was read: the time, Refresh all, a line per source, Try again, Change limit and the link', async () => {
  if (!inChild) return
  let refreshed = 0
  await render(<Reading.TrackerReading tracker={tracker()} onRefresh={() => (refreshed += 1)} />)
  const menu = await openMenu()
  expect(menu).toBeTruthy()
  expect(menu.querySelector('[data-tracker-read]')!.textContent).toMatch(/^Trackers · read \S/)
  expect([...menu.querySelectorAll('button')].map((one) => one.textContent?.trim())).toEqual(['Refresh all', 'Try again', 'Change limit', 'Tracker settings…'])
  /* Nothing to change here. */
  expect(menu.querySelectorAll('input, select, textarea, [role="switch"], [role="checkbox"]').length).toBe(0)
  expect(menu.querySelector('[data-tracker-line="acme/app"]')!.textContent).toBe('acme/app GitHub41 issues · 296 changes · just now')
  expect(menu.textContent).not.toContain('Read again every')
  expect(menu.textContent).not.toContain('git remotes')
  expect(menu.textContent).not.toContain('Tracker news to agents')
  expect(menu.textContent).not.toContain('Where references like')
  await act(async () => buttonIn(menu, 'Try again').click())
  await act(async () => buttonIn(menu, 'Refresh all').click())
  expect(refreshed).toBe(2)
})

test('"Tracker settings…" closes the menu and opens Settings › Trackers at the sources', async () => {
  if (!inChild) return
  const door = { tracker: tracker(), onRefresh() {}, news: { on: true, onChange() {} } }
  await render(
    <>
      <Reading.TrackerReading tracker={door.tracker} onRefresh={() => {}} />
      <Settings.AgentSettingsHost load={async () => answer()} save={async () => answer()} trackers={door} project={{ id: 7, name: 'app', git: true }} />
    </>,
  )
  const menu = await openMenu()
  await act(async () => buttonIn(menu, 'Tracker settings…').click())
  await settle()
  expect(document.querySelector('[data-tracker-menu]')).toBeNull()
  expect(document.querySelector('[role="tab"][data-state="active"]')!.textContent).toBe('Trackers')
  const sources = document.querySelector('[data-settings-target="tracker-sources"]')!
  expect(sources.getAttribute('data-lit')).toBe('true')
  expect(document.querySelector('[data-trackers-for]')!.textContent).toContain('For app.')
})

test('with no source, the link lands on the add row with its field focused', async () => {
  if (!inChild) return
  const empty = tracker({ sources: [] })
  await render(
    <>
      <Reading.TrackerReading tracker={empty} onRefresh={() => {}} />
      <Settings.AgentSettingsHost load={async () => answer()} save={async () => answer()} trackers={{ tracker: empty, onRefresh() {}, news: null }} />
    </>,
  )
  const menu = await openMenu()
  expect([...menu.querySelectorAll('button')].map((one) => one.textContent?.trim())).toEqual(['Tracker settings…'])
  await act(async () => buttonIn(menu, 'Tracker settings…').click())
  await settle()
  const add = document.querySelector('[data-settings-target="tracker-add"]')!
  expect(add.getAttribute('data-lit')).toBe('true')
  expect(document.activeElement).toBe(add.querySelector('input'))
})

test('every source control in Settings › Trackers sends the same edit as before', async () => {
  if (!inChild) return
  const l = listing()
  answerEdits(l)
  await render(
    <Settings.SettingsBody answer={answer()} busy={false} section="trackers" onSection={() => {}} onChange={() => {}} trackers={{ tracker: tracker(), onRefresh() {}, news: null }} />,
  )
  const row = (repo: string) => document.querySelector(`[data-tracker-source="${repo}"]`)!
  const press = async (repo: string, text: string) => {
    await act(async () => buttonIn(row(repo), text).click())
    await act(async () => {})
  }
  await press('acme/app', 'Stop listing recent')
  await press('acme/app', 'Turn off')
  await press('acme/slow', 'Make default')
  await press('acme/slow', 'Remove')
  const key = { tracker: 'github', host: 'github.com' }
  expect(posted).toEqual([
    { project: 7, edit: { kind: 'set', ...key, repo: 'acme/app', list: false } },
    { project: 7, edit: { kind: 'set', ...key, repo: 'acme/app', off: true } },
    { project: 7, edit: { kind: 'set', ...key, repo: 'acme/slow', default: true } },
    { project: 7, edit: { kind: 'remove', ...key, repo: 'acme/slow' } },
  ])
  posted = []

  /* What a listed source reads (#318). */
  const reads = row('acme/app').querySelector('[data-tracker-reads] > button') as HTMLButtonElement
  expect(reads.textContent).toMatch(/^Reads /)
  await act(async () => reads.click())
  const states = row('acme/app').querySelector('select[aria-label="Which states to read"]') as HTMLSelectElement
  await act(async () => {
    states.value = 'open'
    states.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ project: 7, edit: { kind: 'set', ...key, repo: 'acme/app', reads: { closed: false } } })
  posted = []

  /* The schedule and the remotes. */
  const every = document.querySelector('[data-settings-target="tracker-every"] select') as HTMLSelectElement
  await act(async () => {
    every.value = '60'
    every.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
  const remotes = document.querySelector('[data-settings-target="tracker-remotes"] [role="switch"]') as HTMLButtonElement
  await act(async () => remotes.click())
  await act(async () => {})
  expect(posted).toEqual([
    { project: 7, edit: { kind: 'schedule', every: 60 } },
    { project: 7, edit: { kind: 'remotes', on: false } },
  ])
  posted = []

  /* Adding one. */
  const field = document.querySelector('[data-settings-target="tracker-add"] input') as HTMLInputElement
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(field, 'https://github.com/acme/more')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Add').click())
  await act(async () => {})
  expect(posted).toEqual([{ project: 7, edit: { kind: 'add', input: 'https://github.com/acme/more' } }])
  expect(document.querySelector('[data-tracker-sources] [role="status"]')?.textContent).toContain('Changed.')
})

test('the news switch and the GitHub share are in Settings › Trackers, and the share is gone from Modules', async () => {
  if (!inChild) return
  const turned: boolean[] = []
  const changes: unknown[] = []
  await render(
    <Settings.SettingsBody
      answer={answer()}
      busy={false}
      section="trackers"
      onSection={() => {}}
      onChange={(what) => changes.push(what)}
      trackers={{ tracker: tracker(), onRefresh() {}, news: { on: true, onChange: (on) => turned.push(on) } }}
      modulesApi={{ list: async () => ({ ok: true, modules: [] }) } as never}
    />,
  )
  const news = document.querySelector('[data-settings-target="tracker-news"]')!
  expect(news.textContent).toContain('Tracker news to agents')
  await act(async () => (news.querySelector('[role="switch"]') as HTMLButtonElement).click())
  expect(turned).toEqual([false])

  const share = document.querySelector('[data-settings-target="github-share"]')!
  expect(share.closest('[data-trackers-machine]')).toBeTruthy()
  const input = share.querySelector('input')!
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, '35')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(changes).toEqual([{ github: { share: 35 } }])
  /* Only one share control on the page, and it is not in Modules. */
  expect(document.querySelectorAll('[data-settings-target="github-share"]').length).toBe(1)
})

test('with no project open, Settings › Trackers says so and still holds the share', async () => {
  if (!inChild) return
  await render(<Settings.SettingsBody answer={answer()} busy={false} section="trackers" onSection={() => {}} onChange={() => {}} />)
  expect(document.querySelector('[data-trackers-project="none"]')!.textContent).toContain('No project is open')
  expect(document.querySelector('[data-settings-target="github-share"]')).toBeTruthy()
  act(() => unmount?.())
  document.body.innerHTML = ''
  /* No project and an older host that says no share: no Trackers tab at all. */
  await render(<Settings.SettingsBody answer={answer({ github: undefined })} busy={false} section="tools" onSection={() => {}} onChange={() => {}} />)
  expect([...document.querySelectorAll('[role="tab"]')].map((one) => one.textContent)).not.toContain('Trackers')
})

test('a deep link lands on each moved control: the schedule, the remotes, the news', async () => {
  if (!inChild) return
  const door = { tracker: tracker(), onRefresh() {}, news: { on: false, onChange() {} } }
  await render(<Settings.AgentSettingsHost load={async () => answer()} save={async () => answer()} trackers={door} />)
  const cases = [
    [SETTINGS_TARGETS.trackerSchedule, 'select'],
    [SETTINGS_TARGETS.trackerRemotes, '[role="switch"]'],
    [SETTINGS_TARGETS.trackerNews, '[role="switch"]'],
    [SETTINGS_TARGETS.githubShare, 'input'],
  ] as const
  for (const [link, control] of cases) {
    await act(async () => AgentSettings.openSettings(link.section, link.target))
    await settle()
    const row = document.querySelector(`[data-settings-target="${link.target}"]`)!
    expect(row.getAttribute('data-lit')).toBe('true')
    expect(document.activeElement).toBe(row.querySelector(control))
  }
  expect(document.querySelector('[data-tracker-news]')!.getAttribute('data-tracker-news')).toBe('off')
})
