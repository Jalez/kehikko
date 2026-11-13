import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

/*
 * The adoption dialog with the kehikko's agent (protocol 2.91.0), rendered: its primary (or only)
 * agent's container is put on the kehikko and opened, a new session is started there in one call, and
 * the dialog closes saying the agent is on it; with several and none primary the cubes come first, say
 * that the one chosen becomes the kehikko's primary agent, make it so, then start it; with none, the
 * picker; an agent's proposal waits for the person's one press. In a process of its own for the
 * reason `header-menus.test.tsx` gives.
 */

const inChild = process.env.ADOPT_DIALOG_DOM === '1'
const TESTS = 8

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
const STARTED = { state: 'started', module: 'kehikot.b', name: 'B', session: 't1' }

function host(answers: () => Record<string, unknown>, task: { result?: unknown; fail?: boolean; status?: number; body?: unknown } = {}) {
  const seen: { path: string; query: string; body: unknown }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const at = new URL(url, 'http://127.0.0.1')
    seen.push({ path: at.pathname, query: at.search, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (at.pathname === '/host/inbox/adoption') return Response.json({ ok: true, adoption: answers() })
    if (at.pathname === '/host/inbox/task') {
      if (task.fail) throw new TypeError('Load failed')
      if (task.status) return Response.json(task.body ?? null, { status: task.status })
      /* One call: the session, or why not. */
      return Response.json({ ok: true, result: task.result ?? STARTED })
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

test('the kehikko’s primary agent: its container shown, a new session started in one call, and the dialog closes saying so', async () => {
  if (!inChild) return
  const seen = host(() => adoption({ agent: { module: 'kehikot.b', name: 'B' } }))
  const order: string[] = []
  const closed: (string | null)[] = []
  const started: [string, string][] = []
  await render(
    <Adopt.AdoptDialog
      project={1}
      item={{ module: 'kehikko.tracker', id: 'x' }}
      kehikko="k1"
      kehikkoId={3}
      showAgent={(module) => order.push(`show ${module}`)}
      onStarted={(module, said) => started.push([module, said])}
      onClose={(said) => closed.push(said)}
    />,
  )
  await act(async () => new Promise((done) => setTimeout(done, 30)))
  expect(seen[0]!.query).toContain('kehikko=k1')
  const tasks = seen.filter((one) => one.path === '/host/inbox/task')
  expect(tasks).toHaveLength(1)
  expect(tasks[0]!.body).toMatchObject({ project: 1, module: 'kehikko.tracker', id: 'x', kehikko: 'k1', agent: 'kehikot.b' })
  /* Its container first, then the session; no finder route, no polling. */
  expect(order).toEqual(['show kehikot.b'])
  expect(seen.map((one) => one.path)).toEqual(['/host/inbox/adoption', '/host/inbox/task'])
  expect(started).toEqual([['kehikot.b', 'B is on it in its container.']])
  expect(closed).toEqual(['B is on it in its container.'])
})

test('opened again with the agent’s proposal: nothing is started, the person confirms with one press', async () => {
  if (!inChild) return
  const seen = host(() => adoption({ agent: { module: 'kehikot.b', name: 'B' }, proposal: { epic: 'auth', parts: [], conversations: [], why: 'Same repository.' } }))
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" kehikkoId={3} onClose={() => {}} />)
  expect(seen.some((one) => one.path === '/host/inbox/task')).toBe(false)
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
  const tasks = seen.filter((one) => one.path === '/host/inbox/task')
  expect(tasks).toHaveLength(1)
  expect(tasks[0]!.body).toMatchObject({ agent: 'kehikot.b' })
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
  const closed: (string | null)[] = []
  host(() => adoption({ agent: { module: 'kehikot.b', name: 'B' } }), { result: { state: 'failed', why: 'B didn’t start a session: its program is not signed in.' } })
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" onClose={(said) => closed.push(said)} />)
  await act(async () => new Promise((done) => setTimeout(done, 40)))
  expect(document.querySelector('[data-adopt-task="failed"]')!.textContent).toBe('B didn’t start a session: its program is not signed in. Choose the space yourself.')
  expect(document.querySelector('[data-adopt-picker]')).not.toBeNull()
  expect(closed).toEqual([])
})

test('the host failed: its reason, not “HTTP 500”', async () => {
  if (!inChild) return
  host(() => adoption({ agent: { module: 'kehikot.b', name: 'B' } }), {
    status: 500,
    body: { ok: false, error: 'Kehikot failed while answering POST /host/inbox/task: Body already used', why: 'Kehikot failed while answering POST /host/inbox/task: Body already used' },
  })
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" onClose={() => {}} />)
  await act(async () => new Promise((done) => setTimeout(done, 40)))
  const said = document.querySelector('[data-adopt-task="failed"]')!.textContent!
  expect(said).toBe('Kehikot failed while answering POST /host/inbox/task: Body already used. Nothing was changed. Choose the space yourself.')
  expect(said).not.toContain('HTTP 500')
})

test('the host’s server could not be reached: said as that, with its reason', async () => {
  if (!inChild) return
  host(() => adoption({ agent: { module: 'kehikot.b', name: 'B' } }), { fail: true })
  await render(<Adopt.AdoptDialog project={1} item={{ module: 'kehikko.tracker', id: 'x' }} kehikko="k1" onClose={() => {}} />)
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
