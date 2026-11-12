import { describe, expect, test } from 'bun:test'
import type { SpaceNode } from 'kehikot-module-protocol'

const TREE: SpaceNode[] = [
  {
    id: 'auth',
    name: 'Auth',
    children: [
      { id: 'login', name: 'Login', children: [{ id: 'errors', name: 'Errors', children: [{ id: 'copy', name: 'Copy', children: [] }] }] },
      { id: 'signup', name: 'Sign-up', children: [] },
    ],
  },
  { id: 'billing', name: 'Billing', children: [{ id: 'invoices', name: 'Invoices', children: [] }] },
  { id: 'search', name: 'Search', children: [] },
]

/*
 * The list itself, opened, in a DOM of its own process (the pattern of `onboarding-dom.test.tsx`).
 */
const inChild = process.env.SPACE_PICKER_DOM === '1'
const DOM_TESTS = 4

if (!inChild) {
  test('the picker’s list, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, SPACE_PICKER_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${DOM_TESTS} pass`))
  }, 60_000)
} else {
  describe('the list, opened', async () => {
    const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
    GlobalRegistrator.register()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const React = await import('react')
    const { createRoot } = await import('react-dom/client')
    const act = React.act
    const { SpacePicker } = await import('../src/canvas/SpacePicker.tsx')
    const { TooltipProvider } = await import('../src/components/ui/tooltip.tsx')
    const { spaceHere } = await import('../src/host/spaces.ts')

    function draw(here = spaceHere(TREE, { epic: 'auth', parts: ['login'] })) {
      const picks: Array<[string[], string[] | undefined]> = []
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      act(() =>
        root.render(
          <TooltipProvider>
            <SpacePicker tree={TREE} here={here} all={false} project={{ id: 1, name: 'Thesis' }} onPick={(ids, picked) => picks.push([ids, picked])} onPickAll={() => {}} onEdit={null} store={null} defaultOpen />
          </TooltipProvider>,
        ),
      )
      return { picks, done: () => act(() => root.unmount()) }
    }
    const rowKeys = () => [...document.querySelectorAll('[role="treeitem"]')].map((one) => one.getAttribute('data-space-row'))
    const press = (key: string) =>
      act(() => {
        document.querySelector('[role="tree"]')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })

    test('a tree, the current branch open and marked, the others closed', () => {
      const view = draw()
      expect(document.querySelector('[role="tree"]')).not.toBeNull()
      /* The current space is open too, so the spaces in it are in view. */
      expect(rowKeys()).toEqual(['auth', 'auth/login', 'auth/login/errors', 'auth/signup', 'billing', 'search'])
      expect(document.querySelector('[data-space-row="auth"]')!.getAttribute('aria-expanded')).toBe('true')
      expect(document.querySelector('[data-space-row="billing"]')!.getAttribute('aria-expanded')).toBe('false')
      expect(document.querySelector('[data-space-row="auth/login"]')!.getAttribute('aria-current')).toBe('location')
      view.done()
    })

    test('the keyboard opens a branch and picks in it', () => {
      const view = draw()
      press('ArrowDown')
      press('ArrowDown')
      press('ArrowDown')
      press('ArrowRight')
      expect(rowKeys()).toContain('billing/invoices')
      press('ArrowDown')
      press('Enter')
      expect(view.picks).toEqual([[['billing', 'invoices'], undefined]])
      view.done()
    })

    test('the filter opens the branches above a match, and a deep space is picked', () => {
      const view = draw()
      const input = document.querySelector('[data-space-filter]') as HTMLInputElement
      act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        set.call(input, 'copy')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(rowKeys()).toEqual(['auth', 'auth/login', 'auth/login/errors', 'auth/login/errors/copy'])
      act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
      expect(view.picks).toEqual([[['auth', 'login', 'errors', 'copy'], undefined]])
      view.done()
    })

    test('siblings under the current space carry checkboxes, for picking several', () => {
      const view = draw(spaceHere(TREE, { epic: 'auth', parts: [] }))
      expect(document.querySelectorAll('[data-space-check]').length).toBe(2)
      act(() => (document.querySelector('[data-space-row="auth/signup"] [data-space-check]') as HTMLElement).click())
      expect(view.picks).toEqual([[['auth'], ['signup']]])
      view.done()
    })
  })
}
