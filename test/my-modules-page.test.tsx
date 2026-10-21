import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * My modules in the module list, rendered: the plain sentence that Kehikot does
 * not vouch for them, "added by you" on one of the person's own, the offer to
 * keep a hand-installed checkout, and Install from repository — checked and
 * shown before the press that installs. In a process of its own for the reason
 * `header-menus.test.tsx` gives (Radix decides at load whether it has a DOM).
 */

const inChild = process.env.MY_MODULES_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('My modules in the list, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MY_MODULES_DOM: '1' },
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
let Modules: typeof import('../src/canvas/Modules.tsx')
let Tooltip: typeof import('../src/components/ui/tooltip.tsx')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Modules = await import('../src/canvas/Modules.tsx')
  Tooltip = await import('../src/components/ui/tooltip.tsx')
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

const AT = 'http://127.0.0.1:9000'
const flows: Presence = { id: 'kehikot.flows', name: 'Flows', summary: 'Staged diagrams.', tags: ['reading'], at: AT, condition: 'silent', reached: false, line: '' }
const registry: RegistryView = { presences: [flows], sweep: { dir: '/registry', rejected: [] }, protocol: 2 }

const mineEntry = {
  id: 'kehikot.flows',
  name: 'Flows',
  repo: 'jaakkorajalasol/kehikko-flows',
  host: 'github.com',
  port: 9000,
  summary: 'Staged diagrams.',
  tags: ['reading'],
  installed: true,
  mine: true,
}

type Sent = { url: string; body: unknown }

function serve(checked: unknown, adoptable: unknown[] = []): Sent[] {
  const sent: Sent[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (init?.method === 'POST') sent.push({ url: path, body })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (path === '/host/official') return json({ modules: [] })
    if (path === '/host/mine') return json({ modules: [mineEntry], adoptable })
    if (path === '/host/mine/check') return json(checked)
    if (path === '/host/mine/add') return json({ ok: true, id: 'me.second', official: false }, 202)
    if (path === '/host/mine/adopt') return json({ ok: true })
    return json({ error: 'no' }, 404)
  }) as typeof fetch
  return sent
}

async function render(): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Tooltip.TooltipProvider>
        <Modules.ModuleList registry={registry} onCanvas={new Set()} canvases={[]} open={null} onPlace={() => {}} onUnplace={() => {}} />
      </Tooltip.TooltipProvider>,
    )
  })
  await act(async () => {
    await new Promise((done) => setTimeout(done, 10))
  })
  unmount = () => root.unmount()
  return host
}

const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find((one) => one.textContent === text) ?? null

async function press(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    ;(element as HTMLElement).click()
    await new Promise((done) => setTimeout(done, 10))
  })
}

async function type(host: HTMLElement, text: string) {
  const input = host.querySelector('input[aria-label="repository to install from"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

if (inChild) {
  test('says plainly that Kehikot does not vouch for them, and marks one of the person’s own', async () => {
    serve(null)
    const host = await render()
    const section = host.querySelector('section[aria-label="My modules"]')
    expect(section?.textContent).toContain('Kehikot does not vouch for them')
    expect(host.textContent).toContain('added by you')
    expect(host.textContent).not.toContain('Official')
  })

  test('Install from repository checks first and shows what it found; Install is the second press', async () => {
    const sent = serve({
      ok: true,
      kind: 'mine',
      id: 'me.second',
      name: 'Second',
      summary: 'A second module.',
      tags: [],
      repo: 'someone/second',
      host: 'github.com',
      protocol: '2.6.0',
      private: true,
    })
    const host = await render()
    await press(button(host, 'Install from repository…'))
    await type(host, 'someone/second')
    await press(button(host, 'Check'))
    expect(sent).toEqual([{ url: '/host/mine/check', body: { repo: 'someone/second' } }])
    expect(host.textContent).toContain('Second')
    expect(host.textContent).toContain('someone/second (private)')
    expect(host.textContent).toContain('needs 2.6.0')
    expect(host.textContent).toContain('Added by you: Kehikot does not vouch for it.')
    await press(button(host, 'Install'))
    expect(sent.map((one) => one.url)).toEqual(['/host/mine/check', '/host/mine/add'])
    expect(sent[1]!.body).toEqual({ repo: 'someone/second' })
  })

  test('a module that needs a newer Kehikot is shown with no Install', async () => {
    serve({
      ok: true,
      kind: 'mine',
      id: 'me.second',
      name: 'Second',
      summary: '',
      tags: [],
      repo: 'someone/second',
      host: 'github.com',
      protocol: '9.0.0',
      newer: { protocol: '9.0.0', has: '2.10.0' },
      private: false,
    })
    const host = await render()
    await press(button(host, 'Install from repository…'))
    await type(host, 'someone/second')
    await press(button(host, 'Check'))
    expect(host.textContent).toContain('needs a newer Kehikot than this one')
    expect(button(host, 'Install')).toBeNull()
  })

  test('a hand-installed checkout is offered, and kept only on the press', async () => {
    const sent = serve(null, [{ id: 'me.hand', name: 'Hand', from: 'someone/hand', moves: { from: 8020, to: 9010 } }])
    const host = await render()
    expect(host.textContent).toContain('Hand was installed by hand from someone/hand')
    expect(host.textContent).toContain('to 9010')
    expect(sent).toEqual([])
    await press(button(host, 'Keep it as one of my modules'))
    expect(sent).toEqual([{ url: '/host/mine/adopt', body: { module: 'me.hand' } }])
  })
}
