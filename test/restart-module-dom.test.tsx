import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import type { Presence } from '../src/host/registry.ts'
import type { RestartState } from '../src/host/restartModule.ts'
import { noticeOf, showing } from '../src/host/standing.ts'

/*
 * "Restart module" in every container's Container menu, rendered: the row on
 * every kind of module whatever it declared, a press that is the host's and
 * never the module's, the row disabled with its reason for a module this host
 * did not start, the restarting and failed states, the cover and the notice
 * with Retry, the silent page's Restart module and Reload page, and the menu
 * at 380, 280 and 200 pixels. That the header stays one row without overlap is measured in a
 * browser (`dev/header-fit.drive.mjs`, run on bee).
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */
const inChild = process.env.RESTART_MODULE_DOM === '1'
const TESTS = 12

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
  run: 1_700_000_000_000,
  agent: { kind: 'untold' },
} as unknown as Presence

interface Mounted {
  restarted: { n: number }
  reloaded: { n: number }
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
    blocked?: string
  } = {},
): Promise<Mounted> {
  width = over.at ?? 380
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const nothing = () => {}
  const out: Mounted = { restarted: { n: 0 }, reloaded: { n: 0 }, pressed: [] }
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
          restartBlocked={over.blocked}
          onReload={() => void (out.reloaded.n += 1)}
        />
      </TooltipProvider>,
    )
  })
  unmount = () => root.unmount()
  return out
}

const trigger = (menu: string) => document.querySelector<HTMLElement>(`header [data-menu="${menu}"]`)
const rowOf = () => document.querySelector<HTMLElement>('[data-frame="restart"]')
async function open(menu: string) {
  await act(async () => {
    trigger(menu)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
  })
  expect(document.querySelector(`[data-menu-content="${menu}"]`), `the ${menu} menu did not open`).not.toBeNull()
}
const menus = () => [...document.querySelectorAll('header [data-menu]')].map((el) => el.getAttribute('data-menu'))
const again = () => {
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
}

describe('the row in the Container menu', () => {
  if (!inChild) return

  test('every container’s Container menu has "Restart module", and a module that declared nothing gets no Run menu for it', async () => {
    await mount()
    expect(menus()).toEqual(['help', 'frame'])
    await open('frame')
    expect(rowOf()!.textContent).toContain('Restart module')
    expect(rowOf()!.hasAttribute('data-disabled')).toBe(false)
  })

  test('the module’s own Run menu is what it declared, and nothing of the host’s is in it', async () => {
    const { headerItemsSchema } = await import('kehikot-module-protocol')
    await mount({ header: headerItemsSchema.parse([{ kind: 'run', id: 'compile', label: 'Compile' }]) })
    await open('run')
    const ids = [...document.querySelectorAll('[data-menu-content="run"] [data-item]')].map((el) => el.getAttribute('data-item'))
    expect(ids).toEqual(['compile'])
    expect(document.querySelector('[data-menu-content="run"] [data-frame="restart"]')).toBeNull()
  })

  test('a press is the host’s: onRestart once, and nothing sent to the module', async () => {
    const out = await mount()
    await open('frame')
    await act(async () => rowOf()!.click())
    await act(async () => {})
    expect(out.restarted.n).toBe(1)
    expect(out.pressed).toEqual([])
  })

  test('every kind of module has the row: pressable when this host started it or nothing runs, disabled with the reason otherwise', async () => {
    const { STARTED_OUTSIDE, PINNED_VERSION } = await import('../src/host/restartModule.ts')
    const kinds: { said: string; presence: Partial<Presence>; blocked?: string; why: string | null }[] = [
      { said: 'started by this host', presence: { run: 1 }, why: null },
      { said: 'not running, with a directory', presence: { run: undefined, reached: false, condition: 'silent' }, why: null },
      { said: 'a dev server this host did not start', presence: { run: undefined, reached: true }, why: STARTED_OUTSIDE },
      { said: 'registered by its address only', presence: { run: undefined, dir: undefined }, why: STARTED_OUTSIDE },
      { said: 'a pinned version', presence: { run: 1 }, blocked: PINNED_VERSION, why: PINNED_VERSION },
    ]
    for (const kind of kinds) {
      const out = await mount({ presence: kind.presence, blocked: kind.blocked })
      await open('frame')
      const row = rowOf()
      expect(row, kind.said).not.toBeNull()
      if (kind.why === null) {
        expect(row!.hasAttribute('data-disabled'), kind.said).toBe(false)
      } else {
        expect(row!.hasAttribute('data-disabled'), kind.said).toBe(true)
        expect(row!.getAttribute('title'), kind.said).toBe(kind.why)
        expect(row!.querySelector('[data-reason]')!.textContent, kind.said).toBe(kind.why)
        await act(async () => row!.click())
        expect(out.restarted.n, kind.said).toBe(0)
      }
      again()
    }
    expect(STARTED_OUTSIDE).toBe('Started outside Kehikot: restart it where it runs')
  })

  test('while restarting the row is busy with a spinner and cannot be pressed again; after a failure it says so', async () => {
    const out = await mount({ restart: { kind: 'restarting' } })
    await open('frame')
    expect(rowOf()!.getAttribute('data-state-run')).toBe('busy')
    expect(rowOf()!.hasAttribute('data-disabled')).toBe(true)
    expect(rowOf()!.querySelector('[aria-label="running"]')).not.toBeNull()
    await act(async () => rowOf()!.click())
    expect(out.restarted.n).toBe(0)
    again()
    await mount({ restart: { kind: 'failed', why: 'it did not answer', detail: [] } })
    await open('frame')
    expect(rowOf()!.getAttribute('data-state-run')).toBe('failed')
    expect(rowOf()!.hasAttribute('data-disabled')).toBe(false)
  })

  test('never hidden: a container handed no restart still draws the row, and a folded or silent one too', async () => {
    await mount({ asked: false })
    await open('frame')
    expect(rowOf()).not.toBeNull()
    again()
    await mount({ shown: { kind: 'notice', condition: 'silent', asleep: false, line: 'Nothing is answering.' }, presence: { run: undefined, reached: false, condition: 'silent' } })
    await open('frame')
    expect(rowOf()).not.toBeNull()
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

describe('a page that went silent or failed', () => {
  if (!inChild) return

  test('the notice offers Reload page and Restart module, not Start; each press is its own', async () => {
    const shown = showing({ condition: 'ready', line: '' }, { condition: 'silent', line: 'The page did not answer.', more: 'Error: boom' })
    expect(shown).toMatchObject({ kind: 'notice', page: true })
    expect(noticeOf(shown as Extract<typeof shown, { kind: 'notice' }>, {})).toMatchObject({ offer: 'restart', reload: true, more: 'Error: boom' })
    const out = await mount({ shown })
    const reload = document.querySelector<HTMLButtonElement>('[data-notice="reload"]')!
    const restart = document.querySelector<HTMLButtonElement>('[data-notice="restart"]')!
    expect(reload.textContent).toContain('Reload page')
    expect(restart.textContent).toContain('Restart module')
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Start')).toBe(false)
    await act(async () => reload.click())
    expect(out.reloaded.n).toBe(1)
    expect(out.restarted.n).toBe(0)
    await act(async () => restart.click())
    expect(out.restarted.n).toBe(1)
  })

  test('for a module this host did not start, Restart module is there, disabled, with the reason; Reload page still works', async () => {
    const { STARTED_OUTSIDE } = await import('../src/host/restartModule.ts')
    const shown = showing({ condition: 'ready', line: '' }, { condition: 'silent', line: 'The page did not answer.' })
    const out = await mount({ shown, presence: { run: undefined, reached: true } })
    const restart = document.querySelector<HTMLButtonElement>('[data-notice="restart"]')!
    expect(restart.disabled).toBe(true)
    expect(restart.getAttribute('title')).toBe(STARTED_OUTSIDE)
    expect(document.querySelector('[data-reason]')!.textContent).toBe(STARTED_OUTSIDE)
    await act(async () => restart.click())
    expect(out.restarted.n).toBe(0)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-notice="reload"]')!.click())
    expect(out.reloaded.n).toBe(1)
  })
})

describe('the Container menu at the narrow widths', () => {
  if (!inChild) return

  test('380 and 280 draw Container as its own trigger, 200 as the last section of the one "⋯"; the row is there in each', async () => {
    for (const at of [380, 280]) {
      await mount({ at })
      await open('frame')
      expect(rowOf(), `${at}`).not.toBeNull()
      again()
    }
    await mount({ at: 200 })
    expect(menus()).toEqual(['more'])
    await open('more')
    expect(document.querySelector('[data-menu-content="more"] [data-section="frame"] [data-frame="restart"], [data-menu-content="more"] [data-frame="restart"]')).not.toBeNull()
  })
})
