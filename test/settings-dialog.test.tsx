import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

import { DEFAULT_SETTINGS, type SettingsAnswer } from '../src/host/agentSettings.ts'

/*
 * Settings and the one-time question, rendered. In a process of its own for
 * the reason `header-menus.test.tsx` gives (Radix decides at load whether it
 * has a DOM).
 */

const inChild = process.env.SETTINGS_DIALOG_DOM === '1'
const TESTS = 5

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

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Settings = await import('../src/canvas/Settings.tsx')
  Tools = await import('../src/canvas/Tools.tsx')
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
  const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  expect(boxes.map((one) => one.checked)).toEqual([true, true])
  expect(button('Keep it set up')).toBeTruthy()
  expect(button('I’ll do it myself')).toBeTruthy()
  await act(async () => boxes[1]!.click())
  await act(async () => button('Keep it set up').click())
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

test('Settings: agents, tools and skills with status in words and exceptions, and the start hook read only', async () => {
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
  for (const heading of ['Agents', 'Module tools', 'Skills', 'Conversations started outside Kehikot']) {
    expect([...body.querySelectorAll('h3')].map((one) => one.textContent)).toContain(heading)
  }
  expect(body.textContent).toContain('Set up Claude Code')
  expect(body.textContent).toContain('More agents are coming')
  expect(body.querySelector('[data-status="tools"]')!.textContent).toBe('2 connected (1 not running now), 1 left to you')
  expect(body.querySelector('[data-module="kehikot.browser"]')!.textContent).toContain('Connected (not running now)')
  expect(body.querySelector('[data-status="skills"]')!.textContent).toBe('1 installed, 1 changed by you')
  expect(body.querySelector('[data-hook="off"]')).not.toBeNull()
  expect(body.textContent).toContain('Report them')
  expect(body.textContent).toContain('changed by you')
  /* Every checkbox has a label a reader can say. */
  for (const box of body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    expect(body.querySelector(`label[for="${box.id}"]`)?.textContent?.length).toBeGreaterThan(0)
  }
  const browser = body.querySelector<HTMLInputElement>('[data-module="kehikot.browser"] input')!
  expect(browser.checked).toBe(true)
  await act(async () => browser.click())
  expect(saved).toEqual([{ except: { kind: 'tools', module: 'kehikot.browser', out: true } }])
  const toggle = [...body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((one) =>
    body.querySelector(`label[for="${one.id}"]`)?.textContent?.startsWith('Connect every module'),
  )!
  await act(async () => toggle.click())
  expect(saved.at(-1)).toEqual({ settings: { tools: { auto: false }, asked: true } })
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
