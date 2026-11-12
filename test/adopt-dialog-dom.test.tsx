import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

/*
 * The adoption dialog with the kehikko's agent (protocol 2.91.0), rendered: its primary (or only)
 * agent is started at once; with several and none primary the cubes come first, say that the one
 * chosen becomes the kehikko's primary agent, make it so, then start it; with none, the picker. In a
 * process of its own for the reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.ADOPT_DIALOG_DOM === '1'
const TESTS = 6

if (!inChild) {
  test('the adoption dialog, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], { env: { ...process.env, ADOPT_DIALOG_DOM: '1' }, stdout: 'pipe', stderr: 'pipe' })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Adopt: typeof import('../src/canvas/AdoptDialog.tsx')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Adopt = await import('../src/canvas/AdoptDialog.tsx')
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

const ITEM = { ref: '!7', title: 'Fix it', url: 'https://example.org/7', repo: 'g/app', host: 'example.org' }
const EPICS = [{ epic: 'auth', title: 'Auth', parts: [], refs: [] }]

function adoption(over: Record<string, unknown>) {
  return { outcome: 'ok', why: '', item: ITEM, epics: EPICS, suggested: null, conversations: [], agent: null, proposal: null, ...over }
}

/** The host's routes, faked: what `/host/inbox/adoption` answers next, and every request seen. */
const STARTED = { state: 'started', module: 'kehikot.b', name: 'B', session: 't1', view: 'about:blank' }

function host(answers: () => Record<string, unknown>, task: { begin?: unknown; then?: unknown; fail?: boolean } = {}) {
  const seen: { path: string; query: string; body: unknown }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const at = new URL(url, 'http://127.0.0.1')
    seen.push({ path: at.pathname, query: at.search, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (at.pathname === '/host/inbox/adoption') return Response.json({ ok: true, adoption: answers() })
    if (at.pathname === '/host/inbox/task') {
      if (task.fail) throw new TypeError('Load failed')
      /* Answered at once with "starting"; the page reads how it went. */
      return Response.json({ ok: true, result: init?.method === 'POST' ? (task.begin ?? { state: 'starting', module: 'kehikot.b', name: 'B' }) : (task.then ?? STARTED) })
    }
    return Response.json({ ok: false }, { status: 404 })
  }) as unknown as typeof fetch
  return seen
}

async function render(node: React.ReactNode) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => root.render(node))
  for (let i = 0; i < 4; i++) await act(async () => {})
  unmount = () => root.unmount()
}

const button = (text: string) => [...document.querySelectorAll('button')].find((one) => one.textContent?.trim() === text) as HTMLButtonElement | undefined

test('the kehikko’s primary agent is started at once, on that kehikko, with no question', async () => {
  if (!inChild) return
  let reads = 0
  const seen = host(() =>
    adoption({ agent: { module: 'kehikot.b', name: 'B' }, ...(++reads > 1 ? { proposal: { epic: 'auth', parts: [], conversations: [], why: 'Same repository.' } } : {}) }),
  )
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" kehikkoId={3} onClose={() => {}} pollMs={20} taskPollMs={5} />)
  await act(async () => new Promise((done) => setTimeout(done, 30)))
  expect(seen[0]!.query).toContain('kehikko=k1')
  const task = seen.find((one) => one.path === '/host/inbox/task')!
  expect(task.body).toMatchObject({ project: 1, module: 'kehikko.tracker', id: 'x', kehikko: 'k1' })
  expect(document.querySelector('[data-adopt-choose]')).toBeNull()
  /* The agent's conversation is on show while it works. */
  expect(document.querySelector('[data-adopt-agent="kehikot.b"] [data-adopt-view]')).not.toBeNull()
  /* It proposes; the person confirms with one press. */
  await act(async () => new Promise((done) => setTimeout(done, 80)))
  expect(document.querySelector('[data-adopt-proposal="auth"]')).not.toBeNull()
  expect(document.querySelector('[data-adopt-confirm="proposal"]')!.textContent).toBe('Adopt into Auth')
})

test('several agents and none primary: the cubes, what choosing means, then it becomes primary and is started', async () => {
  if (!inChild) return
  let primary: string | null = null
  const seen = host(() =>
    primary
      ? adoption({ agent: { module: primary, name: 'B' } })
      : adoption({ taskAgents: [{ module: 'kehikot.a', name: 'A' }, { module: 'kehikot.b', name: 'B' }] }),
  )
  const made: [number, string][] = []
  await render(
    <Adopt.AdoptDialog
      project={1}
      item={{ module: 'kehikko.tracker', id: 'x' }}
      kehikko="k1"
      kehikkoId={3}
      makePrimary={async (id, module) => {
        made.push([id, module])
        primary = module
      }}
      onClose={() => {}}
      pollMs={60_000}
    />,
  )
  const ask = document.querySelector('[data-adopt-choose]')!
  expect([...ask.querySelectorAll('[data-agent-cube]')].map((one) => one.getAttribute('data-agent-cube'))).toEqual(['kehikot.a', 'kehikot.b'])
  expect(ask.querySelector('[data-adopt-becomes]')!.textContent).toContain('becomes this kehikko’s primary agent')
  /* Nothing is started, and the picker waits, until the person chooses. */
  expect(seen.some((one) => one.path === '/host/inbox/task')).toBe(false)
  expect(document.querySelector('[data-adopt-picker]')).toBeNull()
  await act(async () => ask.querySelector<HTMLButtonElement>('[data-agent-cube="kehikot.b"]')!.click())
  await act(async () => button('Choose and start')!.click())
  for (let i = 0; i < 4; i++) await act(async () => {})
  expect(made).toEqual([[3, 'kehikot.b']])
  expect(document.querySelector('[data-adopt-choose]')).toBeNull()
  expect(seen.filter((one) => one.path === '/host/inbox/task')).toHaveLength(1)
})

test('no agent module that can: the picker alone; and “choose myself” from the cubes is the picker too', async () => {
  if (!inChild) return
  const seen = host(() => adoption({ taskAgents: [] }))
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" kehikkoId={3} onClose={() => {}} />)
  expect(document.querySelector('[data-adopt-picker]')).not.toBeNull()
  expect(document.querySelector('[data-adopt-choose]')).toBeNull()
  expect(seen.some((one) => one.path === '/host/inbox/task')).toBe(false)
  act(() => unmount?.())
  document.body.innerHTML = ''
  host(() => adoption({ taskAgents: [{ module: 'kehikot.a', name: 'A' }, { module: 'kehikot.b', name: 'B' }] }))
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" kehikkoId={3} onClose={() => {}} />)
  await act(async () => button('I’ll choose a space myself')!.click())
  expect(document.querySelector('[data-adopt-choose]')).toBeNull()
  expect(document.querySelector('[data-adopt-picker]')).not.toBeNull()
})

test('the agent did not start: why, in its words, and the picker; never “did not answer”', async () => {
  if (!inChild) return
  host(() => adoption({ agent: { module: 'kehikot.b', name: 'B' } }), { then: { state: 'failed', why: 'B didn’t start the task: its program is not signed in.' } })
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" onClose={() => {}} pollMs={60_000} taskPollMs={5} />)
  await act(async () => new Promise((done) => setTimeout(done, 40)))
  expect(document.querySelector('[data-adopt-task="failed"]')!.textContent).toBe('B didn’t start the task: its program is not signed in. Choose the space yourself.')
  expect(document.querySelector('[data-adopt-picker]')).not.toBeNull()
})

test('the host’s server could not be reached: said as that, with its reason', async () => {
  if (!inChild) return
  host(() => adoption({ agent: { module: 'kehikot.b', name: 'B' } }), { fail: true })
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" onClose={() => {}} pollMs={60_000} taskPollMs={5} />)
  const said = document.querySelector('[data-adopt-task="failed"]')!.textContent!
  expect(said).toContain('could not be reached (Load failed)')
  expect(said).not.toContain('did not answer.')
})

test('only confident conversations are listed; the twenty that only worked in the repository fold under one line', async () => {
  if (!inChild) return
  const conversation = (session: string, match: string, reason: string) => ({ module: 'kehikot.b', program: 'B CLI', session, title: session, folder: '', lastActive: 1, match, reason, placed: null, comes: false })
  host(() =>
    adoption({
      taskAgents: [],
      conversations: [conversation('made-it', 'created', 'created !7'), ...Array.from({ length: 20 }, (_, i) => conversation(`other-${i}`, 'folder', 'worked in this repository'))],
    }),
  )
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" onClose={() => {}} />)
  const list = document.querySelector('[data-adopt-conversations]')!
  expect([...list.querySelectorAll('li')].map((one) => one.getAttribute('data-adopt-match'))).toEqual(['created'])
  const more = list.querySelector<HTMLButtonElement>('[data-adopt-more]')!
  expect(more.textContent).toContain('20 other conversations worked in this repository')
  expect(more.getAttribute('aria-expanded')).toBe('false')
  await act(async () => more.click())
  expect(list.querySelectorAll('[data-adopt-folded] li')).toHaveLength(20)
})
