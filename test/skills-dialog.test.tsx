import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

import type { SkillRow } from '../src/host/skills.ts'

/*
 * The Skills window, rendered: every status in words, and Install and Update
 * offered only inside the text they would write. In a process of its own for
 * the reason `header-menus.test.tsx` gives (Radix decides at load whether it
 * has a DOM).
 */

const inChild = process.env.SKILLS_DIALOG_DOM === '1'
const TESTS = 3

if (!inChild) {
  test('the skills window, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, SKILLS_DIALOG_DOM: '1' },
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
let Skills: typeof import('../src/canvas/Skills.tsx')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Skills = await import('../src/canvas/Skills.tsx')
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

const text = (name: string, body: string) => `---\nname: ${name}\n---\n${body}\n`
const row = (over: Partial<SkillRow> & Pick<SkillRow, 'name' | 'status' | 'says'>): SkillRow => ({
  summary: `About ${over.name}.`,
  version: '2',
  installedVersion: null,
  text: text(over.name, 'Now.'),
  sha256: `sha-${over.name}`,
  unreadable: null,
  installedText: null,
  path: `/scratch/.claude/skills/${over.name}`,
  ...over,
})

const ROWS: SkillRow[] = [
  row({ name: 'fresh', status: 'absent', says: 'Not installed' }),
  row({ name: 'same', status: 'installed', says: 'Installed', installedVersion: '2' }),
  row({ name: 'older', status: 'outdated', says: 'Outdated', installedVersion: '1', installedText: text('older', 'Then.') }),
  row({ name: 'mine', status: 'edited', says: 'Changed by you', installedVersion: '2', installedText: text('mine', 'Mine.') }),
  row({ name: 'theirs', status: 'taken', says: 'Name taken', who: 'a skill Kehikot did not install' }),
]

async function mount() {
  const posts: unknown[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true, said: 'Installed.' }), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, module: 'kehikot.claude', name: 'Claude', writesTo: '/scratch/.claude/skills', skills: ROWS }), { status: 200 })
  }) as unknown as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<Skills.SkillsDialog open onOpenChange={() => {}} module="kehikot.claude" name="Claude" />)
  })
  await act(async () => {})
  unmount = () => root.unmount()
  return { posts }
}

const item = (name: string) => document.querySelector<HTMLElement>(`[data-skill="${name}"]`)!
const press = (name: string, what: string) => item(name).querySelector<HTMLElement>(`[data-press="${what}"]`)

test('every status is said in words, with its own presses', async () => {
  if (!inChild) return
  await mount()
  expect(ROWS.map((r) => item(r.name).querySelector('[data-says]')!.textContent)).toEqual([
    'Not installed', 'Installed', 'Outdated', 'Changed by you', 'Name taken',
  ])
  expect(document.body.textContent).toContain('sessions started after it is installed')
  /* Nothing is installed or updated from the list: only Read, and Remove for an untouched install. */
  expect(document.querySelectorAll('[data-press="install"], [data-press="update"]')).toHaveLength(0)
  expect(ROWS.map((r) => !!press(r.name, 'remove'))).toEqual([false, true, true, false, false])
  expect(item('mine').textContent).toContain('Kehikot leaves your changes alone')
  expect(item('theirs').textContent).toContain('will not write over it')
})

test('Install is offered under the whole text, and sends the hash of what was shown', async () => {
  if (!inChild) return
  const { posts } = await mount()
  await act(async () => press('fresh', 'read')!.click())
  expect(item('fresh').querySelector('[data-text]')!.textContent).toBe(text('fresh', 'Now.'))
  await act(async () => press('fresh', 'install')!.click())
  await act(async () => {})
  expect(posts).toEqual([{ module: 'kehikot.claude', name: 'fresh', press: 'install', sha256: 'sha-fresh' }])
})

test('Update shows the diff first, and the whole text a press away', async () => {
  if (!inChild) return
  await mount()
  await act(async () => press('older', 'read')!.click())
  const lines = [...item('older').querySelectorAll('[data-diff] [data-line]')].map((el) => el.getAttribute('data-line'))
  expect(lines).toContain('removed')
  expect(lines).toContain('added')
  expect(press('older', 'update')).not.toBeNull()
  /* An edited one can be read against the module's, and has nothing to press. */
  await act(async () => press('mine', 'read')!.click())
  expect(item('mine').querySelector('[data-diff]')).not.toBeNull()
  expect(press('mine', 'update')).toBeNull()
})
