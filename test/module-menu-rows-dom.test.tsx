import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { firstSentence, SENTENCE_MAX, worksWithOf, worksWithSaid } from '../src/host/moduleMenu.ts'
import { slidesOfModule } from '../src/host/moduleIntro.ts'
import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * The modules menu's rows: folded by default to one line (the icon, the NAME, at most one short status,
 * and the "?"), badges on a line of their own, and opened on a click or Right to one sentence, the one
 * thing to do and, at the foot, Remove beside Uninstall. What a module works with and the long words
 * about it are not in the menu at all: they are in the "What <name> is" dialog.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix decides at load whether
 * it has a DOM.
 */

const inChild = process.env.MODULE_MENU_ROWS_DOM === '1'
const TESTS = 11

const LONG = 'Your standing lists for every change, kept per epic. Agents answer each line as they work, and you see what is owed.'

type FramedModule = NonNullable<Presence['module']>
function framed(id: string, name: string, over: Partial<FramedModule> = {}): Presence {
  return {
    id,
    at: 'http://127.0.0.1:1',
    condition: 'ready',
    reached: true,
    line: '',
    name,
    summary: LONG,
    tags: ['planning'],
    module: {
      id,
      name,
      version: '1.4.0',
      summary: LONG,
      entry: '/',
      icon: null,
      health: null,
      mcp: null,
      modes: [{ id: 'one', label: 'One', scope: 'epic' }],
      extensions: { emits: [], consumes: [] },
      reacts: [],
      declares: { protocol: '>=2', uses: [], storage: false },
      ...over,
    },
  } as Presence
}

const ALPHA = framed('me.alpha', 'Alpha', {
  extensions: { emits: ['me.lines@1'], consumes: [] },
  reacts: ['selection'],
  declares: { protocol: '>=2', uses: ['events:emit'], storage: false },
})
const BETA = framed('me.beta', 'Beta', { extensions: { emits: [], consumes: ['me.lines@1'] } })
const LONG_NAME = 'A module whose name is long enough to need two lines in the narrowest menu'
const RETIRED: Presence = { ...framed('me.long', LONG_NAME), retired: { says: 'Its job is done elsewhere.' }, lifecycle: 'asleep' }

describe('the pure parts', () => {
  test('a row says one sentence of the summary, clipped', () => {
    expect(firstSentence(LONG)).toBe('Your standing lists for every change, kept per epic.')
    expect(firstSentence('  no stop at all  ')).toBe('no stop at all')
    expect(firstSentence(null)).toBe('')
    const long = firstSentence(`${'word '.repeat(60)}end.`)
    expect(long.length).toBeLessThanOrEqual(SENTENCE_MAX + 1)
    expect(long.endsWith('…')).toBe(true)
  })

  test('what a module works with: its relationships as sentences, then whom it consumes from and provides to', () => {
    expect(worksWithSaid(['It follows the selection.'], { consumes: [{ name: 'B' }], providesTo: [{ name: 'C' }, { name: 'D' }] })).toEqual([
      'It follows the selection.',
      'Consumes: B',
      'Provides to: C, D',
    ])
    const alpha = worksWithOf('me.alpha', [ALPHA, BETA], [], null)
    expect(alpha.at(-1)).toBe('Provides to: Beta')
    expect(worksWithOf('me.beta', [ALPHA, BETA], [], null).at(-1)).toBe('Consumes: Alpha')
    expect(worksWithOf('me.nobody', [ALPHA, BETA], [], null)).toEqual([])
  })

  test('the dialog’s parts come in one order, each only when the module has it', () => {
    const ids = (about: Parameters<typeof slidesOfModule>[1]) => slidesOfModule('Alpha', about).map((one) => one.id)
    expect(ids({})).toEqual(['what'])
    expect(ids({ summary: LONG, help: { summary: 'How.', sections: [{ title: 'Use', points: ['Press.'] }] }, works: ['Consumes: Beta'], version: ['Version 1'] })).toEqual([
      'what',
      'help',
      'help-1',
      'works',
      'version',
    ])
    expect(slidesOfModule('Alpha', { summary: LONG })[0]).toMatchObject({ title: 'What Alpha is', body: LONG })
  })
})

if (!inChild) {
  test('the rows, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MODULE_MENU_ROWS_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS + 3} pass`))
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Lists: typeof import('../src/canvas/Modules.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let realFetch: typeof fetch

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Lists = await import('../src/canvas/Modules.tsx')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
})

afterAll(async () => {
  if (!inChild) return
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
afterEach(() => {
  if (!inChild) return
  registry = { ...registry, presences: [ALPHA, BETA, RETIRED] }
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
})

let registry: RegistryView = { presences: [ALPHA, BETA, RETIRED], sweep: { dir: '/registry', rejected: [] }, protocol: 2 }
const setRegistry = (presences: Presence[]) => void (registry = { ...registry, presences })
const placed: string[] = []
const unplaced: string[] = []

async function render(onCanvas = new Set<string>()) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Lists.ModuleList
          registry={registry}
          onCanvas={onCanvas}
          onPlace={(id) => placed.push(id)}
          onUnplace={(id) => unplaced.push(id)}
          onIntro={() => {}}
        />
      </TooltipProvider>,
    ),
  )
  unmount = () => root.unmount()
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-module-row="${id}"]`)!
const toggle = (id: string) => row(id).querySelector<HTMLButtonElement>('[data-module-row-toggle]')!
const key = (el: Element, name: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })))

describe('a row', () => {
  if (!inChild) return

  test('is folded by default: the icon, the name, at most one status and the "?" — nothing else', async () => {
    await render(new Set(['me.alpha']))
    for (const id of ['me.alpha', 'me.beta', 'me.long']) {
      expect(toggle(id).getAttribute('aria-expanded')).toBe('false')
      expect(row(id).querySelector('[data-module-row-body]')).toBeNull()
      expect(row(id).querySelector('[data-module-help-button]')).not.toBeNull()
      expect(row(id).querySelectorAll('[data-row-status]').length).toBeLessThanOrEqual(1)
      expect(row(id).querySelector('[data-module-icon]')).not.toBeNull()
    }
    expect(toggle('me.beta').querySelector('[data-module-name]')!.textContent).toBe('Beta')
    expect(row('me.alpha').querySelector('[data-row-status]')!.textContent).toBe('On this kehikko')
    /* No sentence, no button, no Uninstall while folded. */
    expect(document.body.textContent).not.toContain('Your standing lists')
    expect(document.body.textContent).not.toContain('Uninstall')
    expect(document.body.textContent).not.toContain('Add to this kehikko')
  })

  test('its badges are on the same line as the name when they fit, wrapped under it only when they do not', async () => {
    await render()
    const line = row('me.long').querySelector('[data-module-line]')!
    const badges = line.querySelector('[data-module-badges]')!
    expect(badges.textContent).toContain('Deprecated')
    /* Beside the name, in the one wrapping line (not on a row of their own), and outside the toggle. */
    expect(line.contains(toggle('me.long'))).toBe(true)
    expect(toggle('me.long').parentElement).toBe(badges.parentElement)
    expect(toggle('me.long').contains(badges)).toBe(false)
    expect(toggle('me.long').textContent).not.toContain('Deprecated')
    /* What does the wrapping: the line wraps, the badges are not cut or shrunk, the name wraps its own words. */
    expect(line.className).toContain('flex-wrap')
    expect(badges.className).toContain('shrink-0')
    expect(badges.className).not.toContain('truncate')
    expect(toggle('me.long').className).toContain('max-w-full')
    const name = toggle('me.long').querySelector('[data-module-name]')!
    expect(name.className).toContain('[overflow-wrap:anywhere]')
    expect(name.className).not.toContain('truncate')
    /* Its short badges share the line too: the scope chip and the Deprecated one are in one group. */
    expect(badges.children.length).toBeGreaterThanOrEqual(1)
  })

  test('the dot says in words what it means, and its shape is not colour alone', async () => {
    setRegistry([ALPHA, { ...RETIRED, condition: 'silent', reached: false }])
    await render()
    const dot = (id: string) => row(id).querySelector<HTMLElement>('[data-run-state]')!
    expect(dot('me.alpha').getAttribute('aria-label')).toBe('Running')
    expect(dot('me.alpha').getAttribute('title')).toBe('Running')
    expect(dot('me.alpha').className).toContain('emerald')
    expect(dot('me.long').getAttribute('aria-label')).toBe('Asleep: starts when a kehikko uses it')
    expect(dot('me.long').dataset.shape).toBe('ring')
    expect(dot('me.long').className).not.toContain('emerald')
  })

  test('Stop on a running module the host started: it posts to the stop route, once, with the module', async () => {
    setRegistry([{ ...ALPHA, run: 1, dir: '/m/alpha' }])
    const posted: string[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push(`${url} ${init.body}`)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    await render()
    await act(async () => toggle('me.alpha').click())
    const stop = row('me.alpha').querySelector<HTMLButtonElement>('[data-row-run="stop"]')!
    expect(stop.textContent).toBe('Stop')
    expect(stop.disabled).toBe(false)
    await act(async () => stop.click())
    expect(posted).toEqual(['/host/stop-module {"module":"me.alpha"}'])
  })

  test('a module started outside Kehikot has Stop disabled, with the reason, and nothing is posted', async () => {
    setRegistry([{ ...ALPHA, dir: '/m/alpha' }])
    const posted: string[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push(String(url))
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    await render()
    await act(async () => toggle('me.alpha').click())
    const holder = row('me.alpha').querySelector<HTMLElement>('[data-row-run="stop"]')!
    expect(holder.getAttribute('aria-disabled')).toBe('true')
    expect(holder.querySelector('button')!.disabled).toBe(true)
    expect(holder.textContent).toContain('Started outside Kehikot: stop it where it runs')
    expect(holder.getAttribute('aria-label')).toContain('Started outside Kehikot: stop it where it runs')
    await act(async () => holder.querySelector('button')!.click())
    expect(posted).toEqual([])
  })

  test('a stopped module shows Start, which posts to the start route', async () => {
    setRegistry([{ ...BETA, condition: 'silent', reached: false, stopped: true, dir: '/m/beta', module: undefined, line: '' } as Presence])
    const posted: string[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posted.push(`${url} ${init.body}`)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    await render()
    expect(row('me.beta').querySelector('[data-run-state]')!.getAttribute('aria-label')).toBe('Stopped: press Start to run it')
    await act(async () => toggle('me.beta').click())
    const start = row('me.beta').querySelector<HTMLButtonElement>('[data-row-run="start"]')!
    expect(start.textContent).toBe('Start')
    await act(async () => start.click())
    expect(posted).toEqual(['/host/start {"module":"me.beta"}'])
  })

  test('a long name is never truncated before the status: it wraps, and the status is what gives way', async () => {
    await render()
    const name = row('me.long').querySelector('[data-module-name]')!
    expect(name.textContent).toBe(LONG_NAME)
    expect(name.className).not.toContain('truncate')
    expect(name.className).toContain('[overflow-wrap:anywhere]')
    expect(name.className).toContain('flex-1')
    const status = row('me.long').querySelector('[data-row-status]')!
    expect(status.textContent).toBe('asleep')
    expect(status.className).toContain('truncate')
    expect(status.className).toContain('max-w-')
  })

  test('opened, it says one sentence, the one thing to do, and Remove beside Uninstall at the foot', async () => {
    await render(new Set(['me.alpha']))
    await act(async () => toggle('me.alpha').click())
    expect(toggle('me.alpha').getAttribute('aria-expanded')).toBe('true')
    const body = row('me.alpha').querySelector('[data-module-row-body]')!
    expect(body.querySelector('[data-row-sentence]')!.textContent).toBe('Your standing lists for every change, kept per epic.')
    const foot = body.querySelector('[data-row-foot]')!
    expect(body.lastElementChild).toBe(foot)
    expect([...foot.querySelectorAll('button')].map((one) => one.textContent)).toEqual(['Remove', 'Uninstall'])
    await act(async () => foot.querySelector<HTMLButtonElement>('button')!.click())
    expect(unplaced).toEqual(['me.alpha'])

    await act(async () => toggle('me.beta').click())
    const primary = row('me.beta').querySelector<HTMLButtonElement>('[data-row-primary]')!
    expect(primary.textContent).toBe('Add to this kehikko')
    await act(async () => primary.click())
    expect(placed).toEqual(['me.beta'])
    /* Not on this kehikko: nothing to remove from it, only Uninstall. */
    expect([...row('me.beta').querySelectorAll('[data-row-foot] button')].map((one) => one.textContent)).toEqual(['Uninstall'])
  })

  test('what it works with and the long words are not in the menu, even opened', async () => {
    await render()
    for (const id of ['me.alpha', 'me.beta', 'me.long']) await act(async () => toggle(id).click())
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('Consumes')
    expect(text).not.toContain('Provides to')
    expect(text).not.toContain('consumer')
    expect(text).not.toContain('provider')
    expect(text).not.toContain('follows the selection')
    expect(text).not.toContain('Agents answer each line')
  })

  test('the keyboard: Up and Down move between rows, Right opens and then goes to the action, Left closes', async () => {
    await render()
    const names = [...document.querySelectorAll<HTMLElement>('[data-module-row-toggle]')]
    names[0]!.focus()
    await key(names[0]!, 'ArrowDown')
    expect(document.activeElement).toBe(names[1]!)
    await key(names[1]!, 'ArrowUp')
    expect(document.activeElement).toBe(names[0]!)
    const id = names[0]!.closest<HTMLElement>('[data-module-row]')!.dataset.moduleRow!
    await key(names[0]!, 'ArrowRight')
    expect(toggle(id).getAttribute('aria-expanded')).toBe('true')
    await key(toggle(id), 'ArrowRight')
    expect(document.activeElement).toBe(row(id).querySelector('[data-row-primary]'))
    await key(document.activeElement!, 'ArrowLeft')
    expect(toggle(id).getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle(id))
    /* Down from the search box comes to the first row. */
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    search.focus()
    await key(search, 'ArrowDown')
    expect(document.activeElement).toBe(document.querySelector('[data-module-row-toggle]'))
  })

  test('which rows are open is kept while the menu is, and forgotten when it closes', async () => {
    await render()
    await act(async () => toggle('me.beta').click())
    await act(async () => toggle('me.alpha').click())
    expect([toggle('me.alpha'), toggle('me.beta')].map((one) => one.getAttribute('aria-expanded'))).toEqual(['true', 'true'])
    act(() => unmount?.())
    document.body.innerHTML = ''
    await render()
    expect(toggle('me.beta').getAttribute('aria-expanded')).toBe('false')
  })
})
