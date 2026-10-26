import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { BADGE_TEXT_BELOW, ICON_BELOW, VERSION_BELOW, fitFor } from '../src/host/headerFit.ts'
import type { Presence } from '../src/host/registry.ts'

/*
 * The order the left side of a container's header gives way in, at each width
 * class: the branch mark's words become its icon, then the version's text goes,
 * then the module's icon, and the name is cut with an ellipsis throughout. The
 * width is the header's own `offsetWidth`, mocked the way `header-menus.test.tsx`
 * mocks it. That nothing overlaps at those widths is measured in a browser
 * (`dev/header-fit.drive.mjs`, `test/header-fit-browser.test.ts`).
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives.
 */
const inChild = process.env.HEADER_FIT_DOM === '1'
const TESTS = 4

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

describe('fitFor', () => {
  test('words give way in order as the header narrows, and an unmeasured one is drawn whole', () => {
    expect([BADGE_TEXT_BELOW, VERSION_BELOW, ICON_BELOW]).toEqual([400, 300, 240])
    const at = (width: number | null) => fitFor(width)
    expect(at(null)).toEqual({ icon: true, version: true, badgeText: true })
    expect(at(780)).toEqual({ icon: true, version: true, badgeText: true })
    expect(at(380)).toEqual({ icon: true, version: true, badgeText: false })
    expect(at(300)).toEqual({ icon: true, version: true, badgeText: false })
    expect(at(280)).toEqual({ icon: true, version: false, badgeText: false })
    expect(at(240)).toEqual({ icon: true, version: false, badgeText: false })
    expect(at(220)).toEqual({ icon: false, version: false, badgeText: false })
    expect(at(200)).toEqual({ icon: false, version: false, badgeText: false })
  })
})

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

const NAME = 'A module with a very long name indeed'
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
    icon: q('header svg[data-module-icon], header [data-testid="module-icon"]'),
  }
}

describe('the header at each width', () => {
  if (!inChild) return

  test('380: the badge is its icon, the version and the name are drawn; the name is whole in its title', async () => {
    const h = await header(380)
    expect(h.name.textContent).toBe(NAME)
    expect(h.name.getAttribute('title')).toBe(NAME)
    expect(h.versionText?.textContent).toBe('0.1.0-a-very-long-version')
    expect(h.badge).not.toBeNull()
    expect(h.badgeText).toBeNull()
    expect(h.badge!.querySelector('svg')).not.toBeNull()
    expect(h.badge!.getAttribute('aria-label')).toContain('a-very-long-branch-name')
  })

  test('280 and 220: the version’s text is gone and is in the name’s title and the button’s name; the badge stays an icon', async () => {
    for (const at of [280, 220]) {
      const h = await header(at)
      expect(h.versionText).toBeNull()
      expect(h.version!.classList.contains('hidden')).toBe(true)
      expect(h.version!.getAttribute('aria-label')).toContain('0.1.0-a-very-long-version')
      expect(h.name.getAttribute('title')).toBe(`${NAME} · 0.1.0-a-very-long-version`)
      expect(h.badgeText).toBeNull()
      expect(h.badge!.querySelector('svg')).not.toBeNull()
      act(() => unmount?.())
      document.body.innerHTML = ''
    }
  })

  test('200: the name is all that has words; a pinned version keeps its amber tag icon, a marked branch its amber icon', async () => {
    const h = await header(200, { pinned: 'v1.2.3-a-very-long-tag' })
    expect(h.name.className).toContain('truncate')
    expect(h.name.className).toContain('min-w-0')
    expect(h.versionText).toBeNull()
    expect(h.version!.classList.contains('hidden')).toBe(false)
    expect(h.version!.querySelector('svg')).not.toBeNull()
    expect(h.version!.getAttribute('data-pinned')).toBe('true')
    expect(h.badge!.getAttribute('data-off-main')).toBe('true')
    expect(h.badge!.querySelector('svg')).not.toBeNull()
    expect(h.badgeText).toBeNull()
  })
})
