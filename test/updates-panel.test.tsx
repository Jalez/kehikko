import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The updates panel, rendered: one panel under the button whose content
 * changes in place — checking, then the results — and never a second one.
 *
 * ## Why this file runs itself in a process of its own
 *
 * Radix decides at module load whether it has a DOM
 * (`@radix-ui/react-use-layout-effect` picks a no-op when `document` is
 * missing), and `bun test` loads every file into one process. Once another
 * file has imported Radix without a DOM, a popover can never open here. So in
 * the shared run this file only spawns `bun test` on itself with
 * `UPDATES_PANEL_DOM=1`, in a fresh process where happy-dom is registered
 * before anything imports React or Radix, and passes when that run passes.
 */

const inChild = process.env.UPDATES_PANEL_DOM === '1'

if (!inChild) {
  test('the updates panel, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, UPDATES_PANEL_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(/\b14 pass/)
  }, 60_000)
}

type Json = Record<string, unknown>
let answer: (url: string, init?: RequestInit) => Promise<Json | Response>
let release: (() => void) | null = null

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Updates: typeof import('../src/canvas/Updates.tsx').Updates
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = await answer(String(url), init)
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Updates } = await import('../src/canvas/Updates.tsx'))
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
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

/* A stand-in for the desktop app's updater (kehikko-desktop#8): the three
   commands through `__TAURI_INTERNALS__`, and `push` plays the shell calling
   `window.kehikotAppUpdate`. */
type AppStatus = {
  enabled: boolean
  current: string
  state: string
  version: string | null
  progress: number | null
  error: string | null
  checkedAt: number | null
}
function standIn(first: Partial<AppStatus>) {
  let now: AppStatus = { enabled: true, current: '0.1.1', state: 'uptodate', version: null, progress: null, error: null, checkedAt: 1, ...first }
  const calls: string[] = []
  ;(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd)
      if (cmd === 'check_for_update') now = { ...now, state: now.state === 'ready' ? 'ready' : 'checking' }
      return cmd === 'apply_update' ? null : now
    },
  }
  return {
    calls,
    async push(next: Partial<AppStatus>) {
      now = { ...now, ...next }
      await act(async () => (globalThis as { kehikotAppUpdate?: (s: unknown) => void }).kehikotAppUpdate?.(now))
    },
  }
}

const indicatorText = () => document.querySelector('[data-testid="updates-indicator"]')?.textContent ?? ''

const checkout = (id: string, behind: number, more: Json = {}) => ({
  id,
  name: id,
  dir: `/${id}`,
  branch: 'main',
  commit: 'abc1234',
  dirty: false,
  upstream: 'origin/main',
  behind,
  ahead: 0,
  incoming: Array.from({ length: behind }, (_, i) => ({ hash: `h${i}`, subject: `commit ${i}` })),
  fetchFailed: null,
  blocked: behind ? null : 'already up to date',
  ...more,
})

const check = (checkouts: Json[], restartable = false) => ({
  checked: new Date().toISOString(),
  checkouts,
  restartable,
})

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <TooltipProvider>
        <Updates markMs={0} />
      </TooltipProvider>,
    )
  })
  unmount = () => root.unmount()
  return host
}

async function press(host: HTMLElement) {
  const button = host.querySelector('button[aria-label]') as HTMLButtonElement
  await act(async () => {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    button.click()
  })
}

const panels = () => document.querySelectorAll('[data-slot="popover-content"]')
const text = () => panels()[0]?.textContent ?? ''
const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 10)))

describe.skipIf(!inChild)('the updates panel', () => {
  test('checking turns into the results in the same panel, listing only what needs attention', async () => {
    answer = (url) =>
      url.startsWith('/host/updates')
        ? new Promise((resolve) => {
            release = () =>
              resolve(check([checkout('host', 0), checkout('notes', 2), checkout('paper', 0), checkout('learning', 0)]))
          })
        : Promise.resolve({})
    const host = await mount()
    await press(host)

    expect(panels()).toHaveLength(1)
    expect(document.querySelector('[role="dialog"][data-slot="dialog-content"]')).toBeNull()
    const panel = panels()[0]
    expect(document.querySelector('[data-testid="updates-working"]')).not.toBeNull()
    expect(text()).toContain('Asking GitHub')
    expect(text()).toContain('Cancel')

    await act(async () => release?.())
    await settle()

    expect(panels()).toHaveLength(1)
    expect(panels()[0]).toBe(panel)
    expect(document.querySelector('[data-testid="updates-working"]')).toBeNull()
    const rows = document.querySelectorAll('[data-testid="updates-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('notes')
    expect(rows[0]?.textContent).toContain('2 new commits')
    expect(text()).toContain('3 others up to date')
    expect(text()).not.toContain('Everything is up to date')

    const show = [...document.querySelectorAll('button')].find((b) => b.textContent === 'show')!
    await act(async () => show.click())
    expect(document.querySelector('[data-testid="updates-level"]')?.textContent).toContain('learning')
  })

  test('nothing needing attention is one calm sentence and Check now', async () => {
    answer = async (url) => (url.startsWith('/host/updates') ? check([checkout('host', 0), checkout('notes', 0)]) : {})
    const host = await mount()
    await press(host)
    await settle()

    expect(document.querySelector('[data-testid="updates-calm"]')).not.toBeNull()
    expect(text()).toContain('Everything is up to date')
    expect(text()).toContain('Last checked just now')
    expect(text()).toContain("Check now")
    expect(document.querySelectorAll('[data-testid="updates-row"]')).toHaveLength(0)
    expect(text()).not.toContain('others up to date')
  })

  for (const restartable of [true, false]) {
    test(`Restart the host after a host update ${restartable ? 'is' : 'is not'} offered when the app ${restartable ? 'can' : 'cannot'} restart`, async () => {
      answer = async (url, init) => {
        if (init?.method === 'POST') {
          return { done: { checkout: checkout('host', 0), changed: ['server/x.ts'], installed: false, installFailed: null, restart: 'host', module: null } }
        }
        return url.startsWith('/host/updates') ? check([checkout('host', 1), checkout('notes', 0)], restartable) : {}
      }
      const host = await mount()
      await press(host)
      await settle()
      const update = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Update')!
      await act(async () => update.click())
      await settle()

      expect(panels()).toHaveLength(1)
      const row = document.querySelector('[data-testid="updates-row"]')
      expect(row?.textContent).toContain('Updated')
      const restart = [...panels()[0]!.querySelectorAll('button')].some((b) => b.textContent === 'Restart the host')
      expect(restart).toBe(restartable)
    })
  }

  test('no engine, and an engine that is not enabled, leave no app row and a quiet icon', async () => {
    for (const engine of [null, { enabled: false, state: 'idle' }]) {
      if (engine) standIn(engine)
      answer = async (url) => (url.startsWith('/host/updates') ? check([checkout('notes', 0)]) : {})
      const host = await mount()
      await settle()
      expect(indicatorText()).toBe('')
      await press(host)
      await settle()
      expect(document.querySelector('[data-testid="updates-app"]')).toBeNull()
      expect(text()).toContain('Everything is up to date')
      act(() => unmount?.())
      unmount = null
      document.body.innerHTML = ''
    }
  })

  test('the app row comes first and follows the push through every state', async () => {
    const engine = standIn({ state: 'uptodate' })
    answer = async (url) => (url.startsWith('/host/updates') ? check([checkout('notes', 0)]) : {})
    const host = await mount()
    await settle()
    expect(engine.calls).toContain('update_status')
    expect(indicatorText()).toBe('')
    await press(host)
    await settle()
    const app = () => document.querySelector('[data-testid="updates-app"]') as HTMLElement | null
    expect(app()?.textContent).toContain('Kehikot app')
    expect(app()?.textContent).toContain('0.1.1')
    expect(app()?.dataset.state).toBe('uptodate')
    const calm = document.querySelector('[data-testid="updates-calm"]')!
    expect(app()!.compareDocumentPosition(calm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await engine.push({ state: 'downloading', version: '0.1.2', progress: 0.45 })
    expect(app()?.dataset.state).toBe('updating')
    expect(app()?.textContent).toContain('Downloading 0.1.2 · 45%')
    expect(indicatorText()).toBe('Downloading Kehikot 0.1.2 · 45%')
    expect(text()).toContain('Every module is up to date')

    await engine.push({ state: 'ready', progress: null })
    expect(app()?.dataset.state).toBe('ready')
    expect(indicatorText()).toBe('Restart to update')
    const restart = [...app()!.querySelectorAll('button')].find((b) => b.textContent === 'Restart to update')!
    await act(async () => restart.click())
    expect(engine.calls).toContain('apply_update')
    expect(app()?.textContent).toContain('Installing 0.1.2')

    await engine.push({ state: 'failed', error: 'the signature did not verify' })
    expect(app()?.textContent).toContain('Failed: the signature did not verify')
    expect(indicatorText()).toBe('Update failed')
  })

  test('Check now checks the app and every module at once', async () => {
    const engine = standIn({ state: 'uptodate' })
    const asked: string[] = []
    answer = async (url) => {
      if (url.startsWith('/host/updates')) asked.push(url)
      return url.startsWith('/host/updates') ? check([checkout('notes', 0)]) : {}
    }
    const host = await mount()
    await press(host)
    await settle()
    asked.length = 0
    const now = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Check now')!
    await act(async () => now.click())
    await settle()
    expect(engine.calls).toContain('check_for_update')
    expect(asked).toEqual(['/host/updates?fetch=1'])
  })

  test('module updates are counted in the one indicator, with blocked ones left out', async () => {
    answer = async (url) =>
      url.startsWith('/host/updates')
        ? check([
            checkout('a', 1),
            checkout('b', 2),
            checkout('c', 3),
            checkout('d', 1, { blocked: 'there are uncommitted changes' }),
          ])
        : {}
    const host = await mount()
    await press(host)
    await settle()
    expect(indicatorText()).toBe('3 updates')
    const blocked = [...document.querySelectorAll('[data-testid="updates-row"]')].find((r) => r.textContent?.includes('uncommitted'))
    expect((blocked as HTMLElement | undefined)?.dataset.state).toBe('blocked')
  })

  /*
   * Updating a module restarts it as part of the update. The server says how
   * far it has got, line by line, and what it came to; no row and no header
   * ever asks for a restart of a module.
   */
  const updatedLine = (module: Json | null, more: Json = {}) => ({
    done: { checkout: checkout('a', 0), changed: ['doors.ts'], installed: false, installFailed: null, lockfileReset: false, restart: null, module, ...more },
  })

  /** The server's stream, with a gate before each line so a test can look at every step. */
  function streamed(lines: Json[]) {
    const gates: (() => void)[] = []
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const line of lines) {
          await new Promise<void>((open) => gates.push(open))
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        }
        controller.close()
      },
    })
    return {
      response: new Response(body, { status: 200 }),
      async next() {
        await act(async () => {
          gates.shift()?.()
          await new Promise((resolve) => setTimeout(resolve, 10))
        })
      },
    }
  }

  async function updating(lines: Json[], more: { stale?: Json; progress?: Json } = {}) {
    const posts: { url: string; body: Json }[] = []
    const stream = streamed(lines)
    let behind = 1
    answer = async (url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: init.body ? (JSON.parse(String(init.body)) as Json) : {} })
        if (url === '/host/updates') {
          behind = 0
          return stream.response
        }
        return { ok: true, presence: { condition: 'ready' } }
      }
      return url.startsWith('/host/updates') ? { ...check([checkout('a', behind), checkout('b', 0)]), ...more } : {}
    }
    const host = await mount()
    await press(host)
    await settle()
    const update = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Update') as HTMLButtonElement
    await act(async () => update.click())
    await settle()
    return { host, posts, stream }
  }

  const running = () => document.querySelector('[data-testid="updates-running"]')?.textContent ?? ''
  const buttons = () => [...document.querySelectorAll('button')].map((b) => b.textContent)

  test('an update that needs a restart does it itself: the row says each step and ends on running the new code', async () => {
    const { posts, stream } = await updating([{ phase: 'updating' }, { phase: 'installing' }, { phase: 'restarting' }, updatedLine({ ran: 'restarted' })])
    await stream.next()
    expect(running()).toContain('Updating…')
    expect(running()).toContain('Cancel')
    await stream.next()
    expect(running()).toContain('Installing what changed…')
    /* The checkout has moved: nothing is cancelled from here on. */
    expect(running()).not.toContain('Cancel')
    await stream.next()
    expect(running()).toContain('Restarting…')
    expect(indicatorText()).toBe('Restarting a')
    await stream.next()
    await settle()
    expect(text()).toContain('Updated — running the new code. It was restarted.')
    /* No second press: nothing was asked of `/host/start`, and nothing offers to. */
    expect(posts.map((one) => one.url)).toEqual(['/host/updates'])
    expect(buttons().some((label) => /restart/i.test(label ?? ''))).toBe(false)
    expect(text()).not.toContain('Restart it')
    expect(indicatorText()).toBe('')
  })

  test('a page-only update, and one for a module nothing has open, say so and ask for nothing', async () => {
    const first = await updating([updatedLine({ ran: 'page' }, { changed: ['src/app.tsx'] })])
    await first.stream.next()
    await settle()
    expect(text()).toContain('Updated — running the new code. Only its page changed')
    expect(indicatorText()).toBe('')
    act(() => unmount?.())
    unmount = null
    document.body.innerHTML = ''

    const second = await updating([updatedLine({ ran: 'idle' })])
    await second.stream.next()
    await settle()
    expect(text()).toContain('It is not running; it starts on the new code when a kehikko that has it is opened.')
    expect(buttons().some((label) => /restart/i.test(label ?? ''))).toBe(false)
  })

  test('a module that did not come back says what it printed, and Try again starts it', async () => {
    const { posts, stream } = await updating([
      { phase: 'restarting' },
      updatedLine({ ran: 'failed', why: 'a was started and stopped again without answering.', detail: ['error: cannot find module ./gone.ts'] }),
    ])
    await stream.next()
    await stream.next()
    await settle()
    const failed = document.querySelector('[data-testid="updates-failed"]')
    expect(failed?.textContent).toContain('Updated, but it did not start on the new code.')
    expect(failed?.textContent).toContain('error: cannot find module ./gone.ts')
    expect(indicatorText()).toBe('')
    const again = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Try again') as HTMLButtonElement
    await act(async () => again.click())
    await settle()
    expect(posts.filter((one) => one.url === '/host/start').map((one) => one.body)).toEqual([{ module: 'a' }])
    expect(text()).toContain('Updated — running the new code.')
  })

  test('what the server still knows is shown by a page that did nothing: an update running, a module left on old code', async () => {
    answer = async (url) =>
      url.startsWith('/host/updates')
        ? { ...check([checkout('a', 0), checkout('b', 0), checkout('c', 0)]), progress: { a: 'restarting' }, stale: { b: 'its registration says to keep it.' } }
        : {}
    const host = await mount()
    await press(host)
    await settle()
    const rows = [...document.querySelectorAll('[data-testid="updates-row"]')] as HTMLElement[]
    expect(rows.map((row) => row.dataset.state).sort()).toEqual(['failed', 'updating'])
    expect(text()).toContain('Restarting…')
    expect(text()).toContain('Updated, but it is still running the old code: its registration says to keep it.')
    expect(indicatorText()).toBe('Restarting a')
    expect(text()).not.toContain('Restart to update')
  })

  async function hostUpdated(restartable: boolean) {
    const posts: string[] = []
    let behind = 1
    answer = async (url, init) => {
      if (init?.method === 'POST') {
        posts.push(url)
        if (url === '/host/updates') {
          behind = 0
          return { done: { checkout: checkout('host', 0), changed: ['server/x.ts'], installed: false, installFailed: null, restart: 'host', module: null } }
        }
        return { ok: true }
      }
      return url.startsWith('/host/updates') ? check([checkout('host', behind), checkout('b', 0)], restartable) : {}
    }
    const host = await mount()
    await press(host)
    await settle()
    const update = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Update') as HTMLButtonElement
    await act(async () => update.click())
    await settle()
    /* The host's own checkout, in the host's own words — never the app's. */
    expect(indicatorText()).toBe('Restart the host')
    return { host, posts }
  }

  test('an updated host is restarted through the app when the app can do it', async () => {
    const { host, posts } = await hostUpdated(true)
    await press(host)
    await settle()
    expect(posts).toContain('/host/restart')
    expect(text()).toContain('Restarting Kehikot')
  })

  test('with nothing the press can restart, it opens the panel on what to do instead of closing it', async () => {
    const { host, posts } = await hostUpdated(false)
    await press(host)
    await settle()
    expect(posts.includes('/host/restart')).toBe(false)
    expect(panels()).toHaveLength(1)
    expect(text()).toContain('quit and reopen Kehikot')
  })
})
