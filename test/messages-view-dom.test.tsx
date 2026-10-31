import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { beforeAll, expect, test } from 'bun:test'
import type { AgentMessage } from 'kehikot-module-protocol'

/*
 * The person's view of the messages between agent sessions (protocol 2.41.0):
 * folded at the foot of the Inbox with a count, newest first when opened, a
 * body drawn as TEXT (never markup), cleared only on a second press. In a
 * process of its own, as the other DOM tests here are.
 */

const inChild = process.env.MESSAGES_VIEW_DOM === '1'
const TESTS = 2

if (!inChild) {
  test('the messages view, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], { env: { ...process.env, MESSAGES_VIEW_DOM: '1' }, stdout: 'pipe', stderr: 'pipe' })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 120_000)
}

const message = (id: number, body: string): AgentMessage => ({
  id,
  at: '2026-10-31T12:00:00.000Z',
  from: { module: 'stand.alpha', name: 'Alpha', session: 'conv-a', place: { epic: 'methods', parts: [], kehikko: 'writing' } },
  to: { place: { epic: 'methods' } },
  thread: null,
  body,
})

let React: typeof import('react')
let createRoot: typeof import('react-dom/client').createRoot
let MessagesSection: typeof import('../src/canvas/Messages.tsx').MessagesSection
let announce: typeof import('../src/host/messagesClient.ts').announceMessagesChanged
let kept: AgentMessage[] = []
let cleared = 0

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:4180')
    if (url.pathname === '/host/messages/clear' && init?.method === 'POST') {
      cleared++
      kept = []
      return Response.json({ ok: true, cleared: 1 })
    }
    const limit = url.searchParams.get('limit')
    return Response.json({ ok: true, count: kept.length, messages: limit === '0' ? [] : [...kept].reverse() })
  }) as typeof fetch
  React = await import('react')
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MessagesSection } = await import('../src/canvas/Messages.tsx'))
  ;({ announceMessagesChanged: announce } = await import('../src/host/messagesClient.ts'))
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => {
    root.render(React.createElement(MessagesSection, { view: { project: 3, nameOf: (id: string) => id } }))
    await settle()
  })
  return { host, root }
}

if (inChild) {
  test('nothing at all without messages; folded with a count, then newest first, the body as text', async () => {
    kept = []
    const empty = await mount()
    expect(empty.host.querySelector('[data-messages]')).toBeNull()
    kept = [message(1, 'first'), message(2, '<b>bold</b> <a href="https://x.test">link</a>')]
    await React.act(async () => {
      announce(3)
      await settle()
    })
    expect(empty.host.textContent).toContain('Messages between agents2')
    const toggle = empty.host.querySelector('[data-messages] button') as HTMLButtonElement
    await React.act(async () => {
      toggle.click()
      await settle()
    })
    const items = [...empty.host.querySelectorAll('[data-message]')]
    expect(items.map((one) => one.getAttribute('data-message'))).toEqual(['2', '1'])
    expect(empty.host.querySelector('[data-message] b')).toBeNull()
    expect(empty.host.querySelector('[data-message] a')).toBeNull()
    expect(items[0]!.textContent).toContain('<b>bold</b>')
    expect(items[0]!.textContent).toContain('Alpha')
    expect(items[0]!.textContent).toContain('→ epic methods')
    empty.root.unmount()
  })

  test('Clear asks a second press', async () => {
    kept = [message(1, 'first')]
    cleared = 0
    const { host, root } = await mount()
    await React.act(async () => {
      ;(host.querySelector('[data-messages] button') as HTMLButtonElement).click()
      await settle()
    })
    const clear = [...host.querySelectorAll('button')].find((one) => one.textContent === 'Clear') as HTMLButtonElement
    await React.act(async () => {
      clear.click()
      await settle()
    })
    expect(cleared).toBe(0)
    expect(clear.textContent).toBe('Press again to clear')
    await React.act(async () => {
      clear.click()
      await settle()
    })
    expect(cleared).toBe(1)
    root.unmount()
  })
}
