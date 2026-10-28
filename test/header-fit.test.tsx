import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { BADGE_TEXT_BELOW, ICON_BELOW, NAME_ROOM, SCOPE_TEXT_BELOW, STEPS, VERSION_BELOW, crowded, fitFor, stepDown } from '../src/host/headerFit.ts'
import { scopeOfContainer } from '../src/host/scope.ts'
import type { Presence } from '../src/host/registry.ts'

/*
 * The order the left side of a container's header gives way in, at each width
 * class: the scope's name becomes its icon (protocol 2.29.0, the first to go),
 * then the branch mark's words become its icon, then the version's text goes,
 * then the module's icon, and the name is cut with an ellipsis throughout. The
 * width is the header's own `offsetWidth`, mocked the way `header-menus.test.tsx`
 * mocks it. That nothing overlaps at those widths is measured in a browser
 * (`dev/header-fit.drive.mjs`, `test/header-fit-browser.test.ts`).
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */
const inChild = process.env.HEADER_FIT_DOM === '1'
const TESTS = 9

if (!inChild) {
  test('the header fit, rendered in a process of their own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, HEADER_FIT_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

const WIDE = { scopeText: true, icon: true, version: true, badgeText: true, quiet: true }
const NONE = { scopeText: false, icon: false, version: false, badgeText: false, quiet: false }

describe('fitFor and stepDown', () => {
  test('what a width allows, and the order of the steps down', () => {
    expect([SCOPE_TEXT_BELOW, BADGE_TEXT_BELOW, VERSION_BELOW, ICON_BELOW, NAME_ROOM, STEPS]).toEqual([440, 400, 300, 240, 72, 5])
    expect(fitFor(null)).toEqual(WIDE)
    expect(fitFor(780)).toEqual(WIDE)
    expect(fitFor(440)).toEqual(WIDE)
    expect(fitFor(400)).toEqual({ ...WIDE, scopeText: false })
    expect(fitFor(380)).toEqual({ ...WIDE, scopeText: false, badgeText: false })
    expect(fitFor(300)).toEqual({ ...WIDE, scopeText: false, badgeText: false })
    expect(fitFor(280)).toEqual({ ...NONE, icon: true, quiet: true })
    expect(fitFor(240)).toEqual({ ...NONE, icon: true, quiet: true })
    expect(fitFor(220)).toEqual(NONE)
    expect(fitFor(200)).toEqual(NONE)
    expect([0, 1, 2, 3, 4, 5].map((n) => stepDown(WIDE, n))).toEqual([
      WIDE,
      { ...WIDE, scopeText: false },
      { ...WIDE, scopeText: false, badgeText: false },
      { ...WIDE, scopeText: false, badgeText: false, version: false },
      NONE,
      NONE,
    ])
  })
  test('crowded: cut and under 72 pixels', () => {
    expect([crowded(100, 230), crowded(71, 230), crowded(71, 71), crowded(40, 41)]).toEqual([false, true, false, false])
  })
})

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Box: typeof import('../src/canvas/Container.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let width = 380
/** What the name would have, in pixels, with nothing else in the row; the drawn words and icon take theirs from it. */
let room = 300

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => width })
  const taken = (el: HTMLElement) => {
    const grip = el.closest('header')!
    const there = (selector: string) => (grip.querySelector(selector) ? 1 : 0)
    return 40 * there('[data-testid="header-scope"] span') + 40 * there('[data-testid="version-label"]') + 40 * there('[data-testid="branch-label"]') + 16 * there('[data-module-icon]')
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.dataset?.testid === 'header-name' ? 230 : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.dataset?.testid === 'header-name' ? Math.min(230, room - taken(this)) : 0
    },
  })
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

const NAME = 'A module with a very long name indeed'
const SCOPE = scopeOfContainer({ modes: [{ id: 'long', scope: 'project', scopeSays: 'the files of this project' }] }, null)
const presence = {
  id: 'kehikot.long',
  at: 'http://127.0.0.1:7870',
  condition: 'ready',
  reached: true,
  name: NAME,
  line: '',
  agent: { kind: 'untold' },
  source: { dir: '/x', registered: true, branch: 'a-very-long-branch-name', upstream: 'origin/main', behind: 0, ahead: 0, dirty: false },
} as unknown as Presence

async function header(at: number, over: { pinned?: string | null; source?: Presence['source'] } = {}) {
  width = at
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const nothing = () => {}
  await act(async () => {
    root.render(
      <TooltipProvider>
        <Box.Container
          presence={{ ...presence, ...(over.source !== undefined ? { source: over.source } : {}) }}
          showing={{ kind: 'page' }}
          fault={null}
          body={nothing}
          grow={false}
          onGrow={nothing}
          pinned={false}
          onPin={nothing}
          collapsed={false}
          onCollapse={nothing}
          header={[]}
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
          canvas={1}
          version={over.pinned ?? null}
          current="0.1.0-a-very-long-version"
          onVersion={nothing}
          onSettings={nothing}
          scope={SCOPE}
        />
      </TooltipProvider>,
    )
  })
  unmount = () => root.unmount()
  const q = (selector: string) => host.querySelector<HTMLElement>(selector)
  return {
    name: q('[data-testid="header-name"]')!,
    version: q('[data-testid="version-control"]'),
    versionText: q('[data-testid="version-label"]'),
    badge: q('[data-testid="branch-mark"]'),
    badgeText: q('[data-testid="branch-label"]'),
    icon: q('header [data-module-icon]'),
    scope: q('[data-testid="header-scope"]'),
  }
}

describe('the header at each width', () => {
  if (!inChild) return

  const flat = (h: Awaited<ReturnType<typeof header>>) => ({
    scopeText: h.scope?.querySelector('span') !== null && h.scope !== null,
    icon: h.icon !== null,
    version: h.versionText !== null,
    badgeText: h.badgeText !== null,
    badge: h.badge !== null,
  })
  const again = () => {
    act(() => unmount?.())
    document.body.innerHTML = ''
  }

  test('with room to spare nothing is dropped; 380 allows no words in the badge, 280 no version, 220 no icon', async () => {
    room = 1000
    const sees: Record<number, ReturnType<typeof flat>> = {}
    for (const at of [780, 400, 380, 280, 220, 200]) {
      sees[at] = flat(await header(at))
      again()
    }
    expect(sees[780]).toEqual({ scopeText: true, icon: true, version: true, badgeText: true, badge: true })
    expect(sees[400]).toEqual({ scopeText: false, icon: true, version: true, badgeText: true, badge: true })
    expect(sees[380]).toEqual({ scopeText: false, icon: true, version: true, badgeText: false, badge: true })
    expect(sees[280]).toEqual({ scopeText: false, icon: true, version: false, badgeText: false, badge: true })
    expect(sees[220]).toEqual({ scopeText: false, icon: false, version: false, badgeText: false, badge: true })
    expect(sees[200]).toEqual(sees[220])
  })

  test('when the name is crowded the steps come in order: badge words, version, icon', async () => {
    const seen: ReturnType<typeof flat>[] = []
    /* The name has 72 pixels once each of these is gone: 40, 40, 16 pixels, in that order. */
    for (const have of [300, 200, 150, 110, 80, 60]) {
      room = have
      seen.push(flat(await header(780)))
      again()
    }
    expect(seen).toEqual([
      { scopeText: true, icon: true, version: true, badgeText: true, badge: true },
      { scopeText: false, icon: true, version: true, badgeText: true, badge: true },
      { scopeText: false, icon: true, version: true, badgeText: false, badge: true },
      { scopeText: false, icon: true, version: false, badgeText: false, badge: true },
      { scopeText: false, icon: false, version: false, badgeText: false, badge: true },
      { scopeText: false, icon: false, version: false, badgeText: false, badge: true },
    ])
  })

  test('380: the badge is its icon, the version and the name are drawn; the name is whole in its title', async () => {
    room = 1000
    const h = await header(380)
    expect(h.name.textContent).toBe(NAME)
    expect(h.name.getAttribute('title')).toBe(NAME)
    expect(h.name.className).toMatch(/min-w-0 .*truncate/)
    expect(h.versionText?.textContent).toBe('0.1.0-a-very-long-version')
    expect(h.badgeText).toBeNull()
    expect(h.badge!.querySelector('svg')).not.toBeNull()
    expect(h.badge!.getAttribute('aria-label')).toContain('a-very-long-branch-name')
  })

  test('280 and 220: the version is in the name’s title and the button’s name; a branch that is not marked is not drawn at 220', async () => {
    room = 1000
    const quiet = { dir: '/x', registered: true, branch: 'main', upstream: 'origin/main', behind: 0, ahead: 0, dirty: false }
    for (const at of [280, 220]) {
      const h = await header(at, { source: quiet })
      expect(h.versionText).toBeNull()
      expect(h.version!.classList.contains('hidden')).toBe(true)
      expect(h.version!.getAttribute('aria-label')).toContain('0.1.0-a-very-long-version')
      expect(h.name.getAttribute('title')).toBe(`${NAME} · 0.1.0-a-very-long-version`)
      expect(h.badge !== null).toBe(at === 280)
      again()
    }
  })

  test('the scope is a label with its name, and its icon alone at 400 and under, with the scope still in its name and tooltip', async () => {
    room = 1000
    const wide = await header(780)
    expect(wide.scope?.textContent).toBe('Project')
    expect(wide.scope?.getAttribute('data-scope')).toBe('project')
    expect(wide.scope?.getAttribute('aria-label')).toBe('Scope: Project (default). The files of this project.')
    expect(wide.scope?.querySelector('svg')).not.toBeNull()
    again()
    for (const at of [400, 280, 200]) {
      const narrow = await header(at)
      expect(narrow.scope?.textContent).toBe('')
      expect(narrow.scope?.querySelector('svg')).not.toBeNull()
      expect(narrow.scope?.getAttribute('aria-label')).toBe('Scope: Project (default). The files of this project.')
      again()
    }
  })

  test('the Frame menu has the scope at every width, default or changed', async () => {
    room = 1000
    const h = await header(200)
    const trigger = document.querySelector<HTMLElement>('[data-menu="frame"]')!
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const row = document.querySelector<HTMLElement>('[data-frame="scope"]')
    expect(row?.textContent).toContain('Scope: Project')
    expect(row?.textContent).toContain('default')
    expect(row?.getAttribute('title')).toBe('Scope: Project (default). The files of this project.')
    void h
  })

  test('200: a pinned version keeps its amber tag icon, a marked branch its amber icon', async () => {
    room = 1000
    const h = await header(200, { pinned: 'v1.2.3-a-very-long-tag' })
    expect(h.versionText).toBeNull()
    expect(h.version!.classList.contains('hidden')).toBe(false)
    expect(h.version!.querySelector('svg')).not.toBeNull()
    expect(h.version!.getAttribute('data-pinned')).toBe('true')
    expect(h.badge!.getAttribute('data-off-main')).toBe('true')
    expect(h.badge!.querySelector('svg')).not.toBeNull()
    expect(h.badgeText).toBeNull()
    expect(h.icon).toBeNull()
  })
})
