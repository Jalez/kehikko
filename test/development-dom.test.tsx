import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'

import type { Development } from '../src/host/development.ts'

/*
 * Settings › Development, rendered: where every official module runs from is said whether Kehikko
 * development is on or off, under a count. In a process of its own for the reason
 * `header-menus.test.tsx` gives (Radix decides at load whether it has a DOM).
 */

const inChild = process.env.DEVELOPMENT_DOM === '1'
const TESTS = 2

if (!inChild) {
  test('Settings › Development, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], { env: { ...process.env, DEVELOPMENT_DOM: '1' }, stdout: 'pipe', stderr: 'pipe' })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let UI: typeof import('../src/canvas/Development.tsx')
let realFetch: typeof fetch

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  UI = await import('../src/canvas/Development.tsx')
  realFetch = globalThis.fetch
})

afterAll(async () => {
  if (!inChild) return
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

const one = (id: string, name: string, runs: Development['modules'][number]['runs']): Development['modules'][number] => ({
  id,
  name,
  runs,
  folder: runs.from === 'folder' ? runs.dir : null,
  release: false,
  keeps: false,
  wants: 'release',
  found: null,
  move: null,
})

async function draw(state: Development) {
  globalThis.fetch = (async () => new Response(JSON.stringify(state), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<UI.DevelopmentSetting />))
  await act(async () => {})
  return () => act(() => root.unmount())
}

const MODULES = [
  one('kehikot.notes', 'Notes', { from: 'release', version: 'v1.6.1' }),
  one('kehikot.flows', 'Flows', { from: 'release', version: '2.0.0' }),
  one('kehikot.paper', 'Paper', { from: 'folder', dir: '/Users/me/Projects/kehikko-paper' }),
]

test('with development off, every module’s line is there, under the count', async () => {
  if (!inChild) return
  const done = await draw({ on: false, home: '/Users/me', modules: MODULES, moving: false, summary: null })
  expect(document.querySelector('[data-testid="development-switch"]')!.getAttribute('aria-checked')).toBe('false')
  expect(document.querySelector('[data-development-count]')!.textContent).toBe('2 from releases · 1 from your folder')
  const lines = [...document.querySelectorAll('[data-development-module]')]
  expect(lines.map((line) => line.getAttribute('data-development-module'))).toEqual(['kehikot.notes', 'kehikot.flows', 'kehikot.paper'])
  expect(lines[0]!.textContent).toContain('Release 1.6.1')
  expect(lines[2]!.textContent).toContain('Your folder ~/Projects/kehikko-paper')
  await done()
})

test('with development on, the same lines and count', async () => {
  if (!inChild) return
  const done = await draw({ on: true, home: '/Users/me', modules: MODULES.slice(0, 2), moving: false, summary: null })
  expect(document.querySelector('[data-development-count]')!.textContent).toBe('2 from releases')
  expect(document.querySelectorAll('[data-development-module]').length).toBe(2)
  await done()
})
