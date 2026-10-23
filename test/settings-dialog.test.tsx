import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

import { DEFAULT_SETTINGS, type SettingsAnswer } from '../src/host/agentSettings.ts'
import { DEFAULT_NOTICES } from '../src/host/trackerNotices.ts'

/*
 * Settings and the one-time question, rendered. In a process of its own for
 * the reason `header-menus.test.tsx` gives (Radix decides at load whether it
 * has a DOM).
 */

const inChild = process.env.SETTINGS_DIALOG_DOM === '1'
const TESTS = 16

if (!inChild) {
  test('the settings windows, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, SETTINGS_DIALOG_DOM: '1' },
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
let Settings: typeof import('../src/canvas/Settings.tsx')
let Tools: typeof import('../src/canvas/Tools.tsx')
let Bar: typeof import('../src/canvas/Bar.tsx')
let AgentSettings: typeof import('../src/host/agentSettings.ts')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Settings = await import('../src/canvas/Settings.tsx')
  Tools = await import('../src/canvas/Tools.tsx')
  Bar = await import('../src/canvas/Bar.tsx')
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
  document.body.innerHTML = ''
})

function answer(over: Partial<SettingsAnswer> = {}): SettingsAnswer {
  return {
    ok: true,
    settings: { ...DEFAULT_SETTINGS, asked: true, tools: { auto: true, except: ['kehikot.notes'] } },
    status: {
      at: 1,
      running: false,
      problems: ['The /mine skill from Claude was changed by you, so Kehikot does not update it.'],
      modules: [
        { id: 'kehikko', name: 'Kehikot', tools: 'connected', skills: [], answering: true },
        { id: 'kehikot.browser', name: 'Browser', tools: 'connected', skills: [], answering: false },
        { id: 'kehikot.notes', name: 'Notes', tools: 'excepted', skills: [], answering: true },
        { id: 'kehikot.claude', name: 'Claude', tools: null, skills: [{ name: 'kehikot-here', state: 'installed' }, { name: 'mine', state: 'edited' }], answering: true },
      ],
    },
    hook: { file: '/scratch/.claude/settings.json', on: false },
    skillsAt: '/scratch/.claude/skills',
    ...over,
  }
}

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  await act(async () => {})
  unmount = () => root.unmount()
}

const switches = (root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
const on = (one: Element) => one.getAttribute('aria-checked') === 'true'
/** What a reader is told a switch is: its label, or its aria-label. */
const named = (one: Element) => one.getAttribute('aria-label') ?? (one.id ? document.querySelector(`label[for="${one.id}"]`)?.textContent : null) ?? ''
/* Radix's tab activates on a press of the main button, not on `click`. */
const pressTab = (one: Element) => one.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))

const button = (text: string) => [...document.querySelectorAll('button')].find((one) => one.textContent?.trim() === text) as HTMLButtonElement

test('the one-time question: its words, both boxes checked, and what each answer stores', async () => {
  if (!inChild) return
  const saved: unknown[] = []
  const load = async () => answer({ settings: DEFAULT_SETTINGS })
  const save = async (change: unknown) => {
    saved.push(change)
    return answer()
  }
  await render(<Settings.AgentSettingsHost load={load} save={save as typeof Settings.postSettings} />)
  const dialog = document.querySelector('[data-first-question]')!
  expect(dialog.textContent).toContain('Let Kehikot keep your agent set up?')
  expect(dialog.textContent).toContain('claude mcp add --scope user')
  expect(dialog.textContent).toContain('~/.claude/skills/<name>')
  expect(dialog.textContent).toContain('change this any time in Settings')
  const boxes = switches(dialog)
  expect(boxes.map(on)).toEqual([true, true])
  expect(boxes.map(named)).toEqual(['Connect every module’s tools', 'Install every module’s skills and keep them up to date'])
  expect(button('Save')).toBeTruthy()
  expect(button('I’ll do it myself')).toBeTruthy()
  await act(async () => boxes[1]!.click())
  expect(on(boxes[1]!)).toBe(false)
  await act(async () => button('Save').click())
  expect(saved).toEqual([{ settings: { asked: true, tools: { auto: true }, skills: { auto: false } } }])
  expect(document.querySelector('[data-first-question]')).toBeNull()
})

test('“I’ll do it myself” turns both off and is an answer; an answered question is not asked', async () => {
  if (!inChild) return
  const saved: unknown[] = []
  const save = async (change: unknown) => {
    saved.push(change)
    return answer()
  }
  await render(<Settings.AgentSettingsHost load={async () => answer({ settings: DEFAULT_SETTINGS })} save={save as typeof Settings.postSettings} />)
  await act(async () => button('I’ll do it myself').click())
  expect(saved).toEqual([{ settings: { asked: true, tools: { auto: false }, skills: { auto: false } } }])
  act(() => unmount?.())
  document.body.innerHTML = ''
  await render(<Settings.AgentSettingsHost load={async () => answer()} />)
  expect(document.querySelector('[data-first-question]')).toBeNull()
})

test('Settings: a section nav, agents, tools and skills with status in words and exceptions, and the start hook read only', async () => {
  if (!inChild) return
  const saved: unknown[] = []
  await render(
    <Settings.SettingsDialog
      open
      onOpenChange={() => {}}
      load={async () => answer()}
      save={(async (change: unknown) => {
        saved.push(change)
        return answer()
      }) as typeof Settings.postSettings}
    />,
  )
  const body = document.querySelector('[data-settings]')!
  /* The nav: one tab per section, the first chosen; no Tracker notices from a host that says nothing of them. */
  const tabs = [...body.querySelectorAll('[role="tab"]')]
  expect(tabs.map((one) => one.textContent)).toEqual(['Agents1 left alone', 'Module tools', 'Skills', 'Conversations', 'About'])
  expect(body.querySelector('[role="tablist"]')!.getAttribute('aria-orientation')).toBe('vertical')
  expect(tabs[0]!.getAttribute('aria-selected')).toBe('true')
  for (const heading of ['Agents', 'Module tools', 'Skills', 'Conversations started outside Kehikot', 'About']) {
    expect([...body.querySelectorAll('h3')].map((one) => one.textContent)).toContain(heading)
  }
  expect(body.textContent).toContain('Set up Claude Code')
  expect(body.textContent).toContain('More agents are coming')
  expect(body.textContent).toContain('Left alone')
  expect(body.querySelector('[data-status="tools"]')!.textContent).toBe('2 connected (1 not running now), 1 left to you')
  /* Status chips, in words. */
  expect(body.querySelector('[data-module="kehikot.browser"]')!.textContent).toContain('Connected (not running now)')
  expect(body.querySelector('[data-module="kehikko"] [data-tone="ok"]')!.textContent).toBe('Connected')
  expect(body.querySelector('[data-module="kehikot.notes"]')!.textContent).toContain('Left to you')
  expect(body.querySelector('[data-module="kehikot.claude"]')!.textContent).toContain('/mine · Changed by you')
  expect(body.querySelector('[data-status="skills"]')!.textContent).toBe('1 installed, 1 changed by you')
  expect(body.querySelector('[data-hook="off"]')).not.toBeNull()
  expect(body.textContent).toContain('Report them')
  expect(body.textContent).toContain('changed by you')
  /* Every switch has a name a reader can say. */
  for (const one of switches(body)) expect(named(one).length).toBeGreaterThan(0)
  /* The other sections are there and hidden until chosen; a press on a tab shows its own. */
  const panel = (key: string) => body.querySelector(`[role="tabpanel"][id$="-content-${key}"]`)!
  expect(panel('tools').getAttribute('data-state')).toBe('inactive')
  await act(async () => pressTab(tabs[1]!))
  expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
  expect(panel('tools').getAttribute('data-state')).toBe('active')
  /* A module's switch leaves it out, at once: no Save. */
  const browser = body.querySelector<HTMLButtonElement>('[data-module="kehikot.browser"] [role="switch"]')!
  expect(on(browser)).toBe(true)
  expect(named(browser)).toBe('Browser: keep connected')
  await act(async () => browser.click())
  expect(saved).toEqual([{ except: { kind: 'tools', module: 'kehikot.browser', out: true } }])
  expect(body.querySelector('[data-saved]')!.textContent).toBe('Saved')
  expect(body.querySelector('[data-saved]')!.getAttribute('role')).toBe('status')
  const toggle = switches(body).find((one) => named(one).startsWith('Connect every module'))!
  await act(async () => toggle.click())
  expect(saved.at(-1)).toEqual({ settings: { tools: { auto: false }, asked: true } })
  expect([...body.querySelectorAll('button')].some((one) => one.textContent === 'Save')).toBe(false)
})

test('Skills: Kehikot’s own skills apart from the modules’, kept by the same switch, with their text a press away', async () => {
  if (!inChild) return
  const given = answer()
  given.status.modules[0] = { ...given.status.modules[0]!, skills: [{ name: 'kehikot-module', state: 'installed' }] }
  await render(<Settings.SettingsDialog open onOpenChange={() => {}} load={async () => given} section="skills" />)
  const own = document.querySelector('[data-own-skills]')!
  expect(own.querySelector('h4')!.textContent).toBe('Kehikot’s own skills')
  expect(own.querySelector('[data-module="kehikko"]')!.textContent).toContain('/kehikot-module · Installed')
  expect(named(own.querySelector('[role="switch"]')!)).toBe('Kehikot: keep installed')
  expect(button('Read and install…')).toBeTruthy()
  /* Not listed again among the modules. */
  expect(document.querySelector('[data-exceptions="skills"] [data-module="kehikko"]')).toBeNull()
  expect(document.querySelector('[data-exceptions="skills"] [data-module="kehikot.claude"]')).not.toBeNull()
})

test('Skills: a kehikko-bound skill is said where it works, not as a chip to install', async () => {
  if (!inChild) return
  const where = 'Available in conversations on a kehikko that also has Review and Factory'
  const given = answer()
  given.status.modules.push({ id: 'kehikot.factory', name: 'Factory', tools: null, answering: true, skills: [{ name: 'factory', state: 'installed' }, { name: 'review-factory', state: 'bound', bound: where }] })
  await render(<Settings.SettingsDialog open onOpenChange={() => {}} load={async () => given} section="skills" />)
  const row = document.querySelector('[data-exceptions="skills"] [data-module="kehikot.factory"]')!
  expect([...row.querySelectorAll('[data-tone]')].map((one) => one.textContent)).toEqual(['/factory · Installed'])
  expect(row.querySelector('[data-note]')!.textContent).toBe(`/review-factory · ${where}`)
  expect(row.textContent).not.toContain('Install ')
  expect(document.querySelector('[data-status="skills"]')!.textContent).toBe('2 installed, 1 changed by you, 1 only on a kehikko')
})

test('Module tools: “Keep this project’s modules running”, on by default, with its memory price, sent as it is pressed', async () => {
  if (!inChild) return
  const saved: unknown[] = []
  await render(
    <Settings.SettingsDialog
      open
      onOpenChange={() => {}}
      load={async () => answer({ modules: { keep: true } })}
      save={(async (change: { modules?: { keep: boolean } }) => {
        saved.push(change)
        return answer({ modules: { keep: change.modules?.keep ?? true } })
      }) as typeof Settings.postSettings}
      section="tools"
    />,
  )
  const keep = switches().find((one) => named(one) === Settings.KEEP_RUNNING.label)!
  expect(keep).toBeTruthy()
  expect(on(keep)).toBe(true)
  const about = document.getElementById(keep.getAttribute('aria-describedby')!)!
  expect(about.textContent).toContain('MB of memory')
  expect(about.textContent).toContain('only the open kehikko’s modules run')
  await act(async () => keep.click())
  expect(saved).toEqual([{ modules: { keep: false } }])
  expect(on(switches().find((one) => named(one) === Settings.KEEP_RUNNING.label)!)).toBe(false)
})

test('Module tools: no keep-running switch from a host that does not say it', async () => {
  if (!inChild) return
  await render(<Settings.SettingsDialog open onOpenChange={() => {}} load={async () => answer()} section="tools" />)
  expect(switches().some((one) => named(one) === Settings.KEEP_RUNNING.label)).toBe(false)
})

test('the module list is searched by name or id', async () => {
  if (!inChild) return
  await render(<Settings.SettingsDialog open onOpenChange={() => {}} load={async () => answer()} section="tools" />)
  const list = document.querySelector('[data-exceptions="tools"]')!
  const search = list.querySelector<HTMLInputElement>('input[type="search"]')!
  expect(search.getAttribute('aria-label')).toBe('Search modules')
  const type = async (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(search, text)
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  expect(list.querySelectorAll('[data-module]').length).toBe(3)
  await type('brow')
  expect([...list.querySelectorAll('[data-module]')].map((one) => one.getAttribute('data-module'))).toEqual(['kehikot.browser'])
  await type('kehikot.notes')
  expect([...list.querySelectorAll('[data-module]')].map((one) => one.getAttribute('data-module'))).toEqual(['kehikot.notes'])
  await type('nothing like it')
  expect(list.textContent).toContain('No module matches “nothing like it”.')
})

test('Tracker notices: on, which items, and each event, every one a labelled native control', async () => {
  if (!inChild) return
  const saved: unknown[] = []
  await render(
    <Settings.SettingsDialog
      open
      onOpenChange={() => {}}
      load={async () => answer({ notices: DEFAULT_NOTICES })}
      save={(async (change: unknown) => {
        saved.push(change)
        return answer({ notices: DEFAULT_NOTICES })
      }) as typeof Settings.postSettings}
    />,
  )
  const body = document.querySelector('[data-settings]')!
  expect([...body.querySelectorAll('h3')].map((one) => one.textContent)).toContain('Tracker notices')
  expect(body.querySelector('[data-notices-scope="roles"]')).not.toBeNull()
  expect(body.textContent).toContain('Only where I have a role')
  expect([...body.querySelectorAll('[role="tab"]')].map((one) => one.textContent)).toContain('Tracker notices')
  const told = Object.values(DEFAULT_NOTICES.events).filter(Boolean).length
  expect(body.querySelector('[data-status="notices"]')!.textContent).toBe(`On · only where you have a role · ${told} of ${Object.keys(DEFAULT_NOTICES.events).length} events`)
  const approved = body.querySelector<HTMLButtonElement>('[data-notice-event="approved"] [role="switch"]')!
  expect(on(approved)).toBe(true)
  expect(named(approved)).toBe('Approved')
  await act(async () => approved.click())
  expect(saved.at(-1)).toEqual({ notices: { events: { approved: false } } })
  const epics = [...body.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!
  await act(async () => epics.click())
  expect(saved.at(-1)).toEqual({ notices: { scope: 'epics' } })
  /* An older host says nothing of notices: no section. */
  act(() => unmount?.())
  document.body.innerHTML = ''
  await render(<Settings.SettingsDialog open onOpenChange={() => {}} load={async () => answer()} />)
  expect([...document.querySelectorAll('h3')].map((one) => one.textContent)).not.toContain('Tracker notices')
  expect([...document.querySelectorAll('[role="tab"]')].map((one) => one.textContent)).not.toContain('Tracker notices')
})

test('a module’s Tools window says it is kept connected, and can leave it out', async () => {
  if (!inChild) return
  const posts: unknown[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/host/settings')) {
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(answer()), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, why: 'Browser is not answering.' }), { status: 409 })
  }) as unknown as typeof fetch
  await render(<Tools.ToolsDialog open onOpenChange={() => {}} module="kehikot.browser" name="Browser" onChanged={() => {}} />)
  const kept = document.querySelector('[data-kept]')!
  expect(kept.getAttribute('data-kept')).toBe('on')
  expect(kept.textContent).toContain('Kept connected by Settings · change')
  const out = kept.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  expect(out.checked).toBe(false)
  await act(async () => out.click())
  expect(posts).toEqual([{ except: { kind: 'tools', module: 'kehikot.browser', out: true } }])
})

test('with the setting off, a module’s window points to Settings', async () => {
  if (!inChild) return
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith('/host/settings')) {
      return new Response(JSON.stringify(answer({ settings: { ...DEFAULT_SETTINGS, asked: true, tools: { auto: false, except: [] } } })), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: false, why: 'no' }), { status: 409 })
  }) as unknown as typeof fetch
  await render(<Tools.ToolsDialog open onOpenChange={() => {}} module="kehikot.browser" name="Browser" onChanged={() => {}} />)
  expect(document.querySelector('[data-kept="off"]')!.textContent).toBe('Do this for every module → Settings')
})

test('the gear, ⌘, and openSettings(section) open Settings; the bare shell event does too', async () => {
  if (!inChild) return
  await render(
    <>
      <Bar.SettingsGear />
      <Settings.AgentSettingsHost load={async () => answer()} />
    </>,
  )
  const gear = document.querySelector<HTMLButtonElement>('[data-testid="settings-gear"]')!
  expect(gear.getAttribute('aria-label')).toBe('Settings')
  expect(['Meta+,', 'Control+,']).toContain(gear.getAttribute('aria-keyshortcuts')!)
  expect(document.querySelector('[data-settings]')).toBeNull()
  await act(async () => gear.click())
  await act(async () => {})
  expect(document.querySelector('[data-settings]')).not.toBeNull()
  const closeIt = () => [...document.querySelectorAll('button')].find((one) => one.textContent === 'Close')!.click()
  await act(async () => closeIt())
  expect(document.querySelector('[data-settings]')).toBeNull()

  /* The chord, by the platform this page is on. */
  const mac = AgentSettings.onMac()
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: mac, ctrlKey: !mac, bubbles: true }))
  })
  await act(async () => {})
  expect(document.querySelector('[data-settings]')).not.toBeNull()
  await act(async () => closeIt())

  /* Named section: a module's Tools window lands on Module tools. */
  await act(async () => AgentSettings.openSettings('tools'))
  await act(async () => {})
  const selected = document.querySelector('[role="tab"][aria-selected="true"]')!
  expect(selected.textContent).toBe('Module tools')
  await act(async () => closeIt())

  /* What the desktop shell would send: the bare event, no section. */
  await act(async () => window.dispatchEvent(new Event(AgentSettings.OPEN_EVENT)))
  await act(async () => {})
  expect(document.querySelector('[data-settings]')).not.toBeNull()
})

test('the chord is ⌘, on a Mac and Ctrl+, elsewhere, never with Shift or Alt', () => {
  if (!inChild) return
  const key = (over: Partial<KeyboardEvent>) => ({ key: ',', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over })
  expect(AgentSettings.isSettingsChord(key({ metaKey: true }), true)).toBe(true)
  expect(AgentSettings.isSettingsChord(key({ ctrlKey: true }), true)).toBe(false)
  expect(AgentSettings.isSettingsChord(key({ ctrlKey: true }), false)).toBe(true)
  expect(AgentSettings.isSettingsChord(key({ metaKey: true }), false)).toBe(false)
  expect(AgentSettings.isSettingsChord(key({ metaKey: true, shiftKey: true }), true)).toBe(false)
  expect(AgentSettings.isSettingsChord(key({ metaKey: true, altKey: true }), true)).toBe(false)
  expect(AgentSettings.isSettingsChord(key({ key: 'n', altKey: true, shiftKey: true }), true)).toBe(false)
  expect(AgentSettings.chordSaid(true)).toBe('⌘,')
  expect(AgentSettings.chordSaid(false)).toBe('Ctrl+,')
})

test('About: the version, the protocol, and the release notes and storage overview', async () => {
  if (!inChild) return
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith('/host/health')) return new Response(JSON.stringify({ ok: true, version: '0.1.99' }), { status: 200 })
    return new Response(JSON.stringify({ ok: false }), { status: 404 })
  }) as unknown as typeof fetch
  let storage = 0
  window.addEventListener('kehikot:storage', () => storage++)
  let closed = 0
  await render(<Settings.SettingsDialog open onOpenChange={(open) => (closed += open ? 0 : 1)} load={async () => answer()} section="about" />)
  await act(async () => {})
  const about = document.querySelector('[data-about]')!
  expect(about.querySelector('[data-protocol]')!.textContent).toMatch(/^kehikot-module-protocol \d+\.\d+\.\d+$/)
  expect(about.querySelector('[data-version="host"]')!.textContent).toContain('host 0.1.99')
  expect(button('All release notesKehikot’s releases on GitHub, newest first.')).toBeTruthy()
  expect(button('Build your own moduleThe guide to making a Kehikot module, from the first question to its first release. In Claude Code, /kehikot-module walks you through it.')).toBeTruthy()
  await act(async () => button('Storage overviewWhat every module’s data takes in every project, and Kehikot’s own.').click())
  await act(async () => new Promise((done) => setTimeout(done, 5)))
  expect(closed).toBe(1)
  expect(storage).toBe(1)
})

test('Project: the open project’s base branch, origin’s default until set, checked before it is taken', async () => {
  if (!inChild) return
  const saved: (string | null)[] = []
  const door = {
    load: async () => ({ set: null, origin: 'main', branch: 'main' }),
    save: async (_project: number, branch: string | null) => {
      saved.push(branch)
      if (branch === 'nope') return { ok: false as const, why: 'origin has no branch called nope. Push it first, or name a branch origin has. The base branch was not changed.' }
      const base = { set: branch, origin: 'main', branch: branch ?? 'main' }
      return { ok: true as const, said: branch ? `The base branch is ${branch}.` : "The base branch is origin's default, main.", base }
    },
  }
  await render(
    <Settings.SettingsDialog
      open
      onOpenChange={() => {}}
      load={async () => answer()}
      section="project"
      project={{ id: 4, name: 'kollekti', git: true }}
      baseBranch={door}
    />,
  )
  const body = document.querySelector('[data-settings]')!
  expect([...body.querySelectorAll('[role="tab"]')].map((one) => one.textContent)).toEqual(['Agents1 left alone', 'Module tools', 'Skills', 'Conversations', 'Project', 'About'])
  const form = body.querySelector('[data-base-branch]')!
  expect(form.getAttribute('data-base-branch')).toBe('default')
  expect(form.textContent).toContain('The branch agents start their work from and updates are pulled from.')
  expect(form.querySelector('[data-base-branch-now]')!.textContent).toBe('Nothing is set, so origin’s default is used: main.')
  const field = form.querySelector<HTMLInputElement>('input')!
  expect(document.querySelector(`label[for="${field.id}"]`)!.textContent).toBe('Base branch')
  expect(field.placeholder).toBe('main')
  expect(button('Save').disabled).toBe(true)
  expect(button('Use origin’s default')).toBeUndefined()

  const type = async (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await type('nope')
  await act(async () => button('Save').click())
  expect(saved).toEqual(['nope'])
  expect(form.querySelector('[role="alert"]')!.textContent).toContain('origin has no branch called nope')
  expect(form.getAttribute('data-base-branch')).toBe('default')

  await type('development')
  await act(async () => button('Save').click())
  expect(saved).toEqual(['nope', 'development'])
  expect(form.querySelector('[role="alert"]')).toBeNull()
  expect(form.getAttribute('data-base-branch')).toBe('set')
  expect(form.querySelector('[data-base-branch-now]')!.textContent).toBe('development is set for this project. Origin’s default is main.')
  expect(form.querySelector('[data-base-branch-said]')!.textContent).toBe('The base branch is development.')

  await act(async () => button('Use origin’s default').click())
  expect(saved).toEqual(['nope', 'development', null])
  expect(form.getAttribute('data-base-branch')).toBe('default')
  expect(field.value).toBe('')
})

test('Project: no section without an open project, and a sentence for one that cannot have a base branch', async () => {
  if (!inChild) return
  let loads = 0
  const door = {
    load: async () => {
      loads += 1
      return { set: null, origin: 'main', branch: 'main' }
    },
    save: async () => ({ ok: false as const, why: 'unused' }),
  }
  await render(<Settings.SettingsDialog open onOpenChange={() => {}} load={async () => answer()} baseBranch={door} />)
  expect([...document.querySelectorAll('[role="tab"]')].map((one) => one.textContent)).not.toContain('Project')
  act(() => unmount?.())
  document.body.innerHTML = ''
  await render(
    <Settings.SettingsDialog open onOpenChange={() => {}} load={async () => answer()} section="project" project={{ id: 2, name: 'thesis', git: false }} baseBranch={door} />,
  )
  expect(document.querySelector('[data-base-branch="unavailable"]')!.textContent).toBe('thesis is not a git repository, so it has no base branch.')
  expect(loads).toBe(0)
})
