import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import type { Presence } from '../src/host/registry.ts'
import type { RestartState } from '../src/host/restartModule.ts'
import { noticeOf, showing } from '../src/host/standing.ts'

/*
 * "Restart module" on a module's Run menu, rendered: the row and its icon, a
 * press that is the host's and never the module's, the row disabled with its
 * reason for a module this host did not start, the restarting and failed
 * states, the cover and the notice with Retry, and the menu at 380, 280 and 200
 * pixels. That the header stays one row without overlap is measured in a
 * browser (`dev/header-fit.drive.mjs`, run on bee).
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */
const inChild = process.env.RESTART_MODULE_DOM === '1'
const TESTS = 10

if (!inChild) {
  test('restart module, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, RESTART_MODULE_DOM: '1' },
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
let Box: typeof import('../src/canvas/Container.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let width = 380

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => width })
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Box = await import('../src/canvas/Container.tsx')
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
})

const presence = {
  id: 'kehikot.scratch',
  at: 'http://127.0.0.1:7990',
  condition: 'ready',
  reached: true,
  name: 'Scratch',
  line: '',
  dir: '/somewhere/scratch',
  agent: { kind: 'untold' },
} as unknown as Presence

interface Mounted {
  restarted: { n: number }
  pressed: string[]
}

async function mount(
  over: {
    presence?: Partial<Presence>
    restart?: RestartState
    asked?: boolean
    at?: number
    shown?: ReturnType<typeof showing>
    header?: import('kehikot-module-protocol').HeaderItem[]
  } = {},
): Promise<Mounted> {
  width = over.at ?? 380
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const nothing = () => {}
  const out: Mounted = { restarted: { n: 0 }, pressed: [] }
  await act(async () => {
    root.render(
      <TooltipProvider>
        <Box.Container
          presence={{ ...presence, ...over.presence }}
          showing={over.shown ?? { kind: 'page' }}
          fault={null}
          body={nothing}
          grow={false}
          onGrow={nothing}
          pinned={false}
          onPin={nothing}
          collapsed={false}
          onCollapse={nothing}
          header={over.header}
          onPress={async (press) => {
            out.pressed.push(press.item)
            return { ok: true, why: '' }
          }}
          filters={[]}
          chosen={{}}
          onChoose={nothing}
          onEverything={nothing}
          clear={null}
          onClear={nothing}
          refresh={undefined}
          refreshEvery={null}
          onRefresh={nothing}
          onRefreshEvery={nothing}
          selected={false}
          onSelect={nothing}
          onPrompts={nothing}
          onTools={nothing}
          onStarted={nothing}
          onRemove={nothing}
          kehikko="thesis"
          epic={null}
          restart={over.restart}
          onRestart={over.asked === false ? undefined : () => void (out.restarted.n += 1)}
        />
      </TooltipProvider>,
    )
  })
  unmount = () => root.unmount()
  return out
}

const trigger = (menu: string) => document.querySelector<HTMLElement>(`header [data-menu="${menu}"]`)
const rowOf = () => document.querySelector<HTMLElement>('[data-item="kehikot.host.restart-module"]')
async function open(menu: string) {
  await act(async () => {
    trigger(menu)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
  })
  expect(document.querySelector(`[data-menu-content="${menu}"]`), `the ${menu} menu did not open`).not.toBeNull()
}
const menus = () => [...document.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))

describe('the row in the Run menu', () => {
  if (!inChild) return

  test('every module’s Run menu has "Restart module" with its icon, and a module that declared nothing gets the Run menu for it', async () => {
    await mount()
    expect(menus()).toEqual(['run', 'frame'])
    await open('run')
    expect(rowOf()!.textContent).toContain('Restart module')
    expect(rowOf()!.querySelector('[data-icon="rotate-ccw"]')).not.toBeNull()
    expect(rowOf()!.getAttribute('data-disabled')).toBeNull()
  })

  test('it follows what the module declared in the same menu, and the module’s own runs are untouched', async () => {
    const { headerItemsSchema } = await import('kehikot-module-protocol')
    await mount({ header: headerItemsSchema.parse([{ kind: 'run', id: 'compile', label: 'Compile' }]) })
    await open('run')
    const ids = [...document.querySelectorAll('[data-menu-content="run"] [data-item]')].map((el) => el.getAttribute('data-item'))
    expect(ids).toEqual(['compile', 'kehikot.host.restart-module'])
  })

  test('a press is the host’s: onRestart once, and nothing sent to the module', async () => {
    const out = await mount()
    await open('run')
    await act(async () => rowOf()!.click())
    await act(async () => {})
    expect(out.restarted.n).toBe(1)
    expect(out.pressed).toEqual([])
  })

  test('a module the host did not start has the row disabled, with the reason as text', async () => {
    const out = await mount({ presence: { dir: undefined } })
    await open('run')
    const row = rowOf()!
    expect(row.hasAttribute('data-disabled')).toBe(true)
    expect(row.getAttribute('title')).toBe("Kehikot didn't start this module, so it can't restart it.")
    expect(row.querySelector('[data-reason]')!.textContent).toBe("Kehikot didn't start this module, so it can't restart it.")
    await act(async () => row.click())
    expect(out.restarted.n).toBe(0)
  })

  test('while restarting the row is busy with a spinner and cannot be pressed again; after a failure it says so', async () => {
    const out = await mount({ restart: { kind: 'restarting' } })
    await open('run')
    expect(rowOf()!.getAttribute('data-state-run')).toBe('busy')
    expect(rowOf()!.hasAttribute('data-disabled')).toBe(true)
    expect(rowOf()!.querySelector('[aria-label="running"]')).not.toBeNull()
    await act(async () => rowOf()!.click())
    expect(out.restarted.n).toBe(0)
    act(() => unmount?.())
    document.body.innerHTML = ''
    await mount({ restart: { kind: 'failed', why: 'it did not answer', detail: [] } })
    await open('run')
    expect(rowOf()!.getAttribute('data-state-run')).toBe('failed')
    expect(rowOf()!.hasAttribute('data-disabled')).toBe(false)
  })

  test('a container that does not offer a restart draws none, and a module that declared nothing keeps its header', async () => {
    await mount({ asked: false })
    expect(menus()).toEqual(['frame'])
  })
})

describe('the restarting state and the failure', () => {
  if (!inChild) return

  test('showing: a restart in hand is the "restarting" cover; its failure is a notice with the reason and Retry while the module is silent', () => {
    const ready = { condition: 'ready', line: '' } as const
    const silent = { condition: 'silent', line: 'Nothing is answering.' } as const
    expect(showing(ready, undefined, true, { kind: 'restarting' })).toEqual({ kind: 'cover', state: 'restarting' })
    const failed: RestartState = { kind: 'failed', why: 'It did not answer.', detail: ['boom'] }
    const notice = showing(silent, undefined, true, failed)
    expect(notice).toEqual({ kind: 'notice', condition: 'silent', asleep: false, line: 'It did not answer.', restartFailed: ['boom'] })
    expect(noticeOf(notice as Extract<typeof notice, { kind: 'notice' }>, {})).toEqual({ line: 'It did not answer.', detail: ['boom'], offer: 'retry-restart' })
    /* It came back by itself: the page, not a stale failure. */
    expect(showing({ ...ready }, { condition: 'ready', line: null }, true, failed)).toEqual({ kind: 'page' })
    /* The host's own restart of it wins over a failure. */
    expect(showing({ ...silent, lifecycle: 'restarting' }, undefined, true, failed)).toEqual({ kind: 'cover', state: 'restarting' })
  })

  test('the container shows "Restarting…" over the page area', async () => {
    await mount({ shown: showing({ condition: 'ready', line: '' }, undefined, true, { kind: 'restarting' }) })
    expect(document.body.textContent).toContain('Restarting…')
  })

  test('the reason is text, with the last lines it printed, and Retry presses the restart again', async () => {
    const failed: RestartState = { kind: 'failed', why: 'Scratch was started again and has not answered after 30 seconds.', detail: ['EADDRINUSE <b>x</b>'] }
    const shown = showing({ condition: 'silent', line: 'Nothing is answering.' }, undefined, true, failed)
    const out = await mount({ shown, restart: failed })
    expect(document.body.textContent).toContain('has not answered after 30 seconds')
    expect(document.body.textContent).toContain('EADDRINUSE <b>x</b>')
    expect(document.querySelector('pre b')).toBeNull()
    const retry = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Retry')!
    expect(retry).toBeDefined()
    await act(async () => retry.click())
    expect(out.restarted.n).toBe(1)
  })
})

describe('the Run menu at the narrow widths', () => {
  if (!inChild) return

  test('380 draws Run in words, 280 as an icon, 200 under the one "⋯" menu; the row is there in each', async () => {
    await mount({ at: 380 })
    expect(trigger('run')!.textContent).toBe('Run')
    await open('run')
    expect(rowOf()).not.toBeNull()
    act(() => unmount?.())
    document.body.innerHTML = ''

    await mount({ at: 280 })
    expect(trigger('run')!.textContent).toBe('')
    expect(trigger('run')!.getAttribute('aria-label')).toContain('run')
    await open('run')
    expect(rowOf()).not.toBeNull()
    act(() => unmount?.())
    document.body.innerHTML = ''

    await mount({ at: 200 })
    expect(menus()).toEqual(['more', 'frame'])
    await open('more')
    expect(document.querySelector('[data-menu-content="more"] [data-section="run"]')).not.toBeNull()
    expect(rowOf()).not.toBeNull()
  })
})
