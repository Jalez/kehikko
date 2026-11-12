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
const DOM_TESTS = 7

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
    const store = await import('../src/host/pickerStore.ts')
    type Activity = import('../src/host/spaceRecency.ts').SpaceActivity
    const sent: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined
      sent.push({ url, body })
      if (url === '/host/settings') return Response.json({ ok: true, picker: { projects: 'recent', epics: 'az', kehikot: 'recent', ...body?.picker } })
      return Response.json({ ok: false })
    }) as never
    /* Thursday 12 November 2026, 15:00 local. */
    const NOW = new Date(2026, 10, 12, 15, 0).getTime()
    const HOUR = 3_600_000

    function draw(here = spaceHere(TREE, { epic: 'auth', parts: ['login'] }), activity: Activity[] = []) {
      const picks: Array<[string[], string[] | undefined]> = []
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      act(() =>
        root.render(
          <TooltipProvider>
            <SpacePicker tree={TREE} here={here} all={false} project={{ id: 1, name: 'Thesis' }} onPick={(ids, picked) => picks.push([ids, picked])} onPickAll={() => {}} onEdit={null} store={null} defaultOpen activity={activity} clock={() => NOW} />
          </TooltipProvider>,
        ),
      )
      return {
        picks,
        done: () => {
          act(() => root.unmount())
          host.remove()
        },
      }
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

    const flush = () => act(async () => {})
    const headingsNow = () => [...document.querySelectorAll('[data-space-heading]')].map((one) => one.textContent)
    const typeFilter = (text: string) =>
      act(() => {
        const input = document.querySelector('[data-space-filter]') as HTMLInputElement
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        set.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })

    test('a dot on each row with its state in words; a closed branch shows the worst inside it', () => {
      const view = draw(spaceHere(TREE, { epic: 'search', parts: [] }), [
        { state: 'attention', place: { epic: 'auth', space: ['auth', 'login', 'errors'] }, entered: NOW - HOUR, live: true },
        { state: 'working', place: { epic: 'billing', parts: ['invoices'] }, entered: NOW - HOUR, live: true },
        { state: 'done', place: { epic: 'search' }, entered: NOW - HOUR, live: false },
      ])
      const dot = (key: string) => document.querySelector(`[data-space-row="${key}"] [data-activity]`)
      /* Auth and Billing are closed: their subtrees' worst shows on them, said in words. */
      expect(dot('auth')!.getAttribute('data-activity')).toBe('attention')
      expect(dot('auth')!.getAttribute('aria-label')).toBe('inside Auth — needs your attention')
      expect(dot('billing')!.getAttribute('data-activity')).toBe('working')
      expect(dot('billing')!.getAttribute('role')).toBe('img')
      /* A put-away item marks nothing. */
      expect(dot('search')).toBeNull()
      /* Opened, the parent holds nothing of its own and the child shows its own. */
      act(() => (document.querySelector('[data-space-row="billing"] [data-space-chevron]') as HTMLElement).click())
      expect(dot('billing')).toBeNull()
      expect(dot('billing/invoices')!.getAttribute('aria-label')).toBe('Invoices — working')
      /* The closed control says something goes on in another space. */
      expect(document.querySelector('[aria-label="the space this project is on"] [data-activity]')!.getAttribute('data-activity')).toBe('attention')
      view.done()
    })

    test('the order switch: Alphabetical, then Recent activity with time headings, remembered and sent', async () => {
      store.resetPickerStore()
      store.adoptVisits({ projects: {}, epics: { '1/search': NOW - 10 * 60_000 }, kehikot: {}, spaces: {} })
      const activity: Activity[] = [{ state: 'done', place: { epic: 'billing' }, entered: NOW - 26 * HOUR, live: false }]
      let view = draw(spaceHere(TREE, { epic: 'search', parts: [] }), activity)
      const group = document.querySelector('[role="radiogroup"]')!
      expect(group.getAttribute('aria-label')).toBe('order of spaces')
      const radio = (word: string) => [...group.querySelectorAll<HTMLElement>('[role="radio"]')].find((one) => one.textContent === word)!
      expect(radio('Alphabetical').getAttribute('aria-checked')).toBe('true')
      expect(radio('Recent activity').getAttribute('aria-checked')).toBe('false')
      expect(rowKeys()).toEqual(['auth', 'billing', 'search'])
      expect(headingsNow()).toEqual([])

      act(() => radio('Recent activity').click())
      await flush()
      expect(sent.some((one) => one.url === '/host/settings' && JSON.stringify(one.body) === JSON.stringify({ picker: { epics: 'recent' } }))).toBe(true)
      expect(radio('Recent activity').getAttribute('aria-checked')).toBe('true')
      /* Search visited ten minutes ago; Billing had activity yesterday; Auth never. */
      expect(rowKeys()).toEqual(['search', 'billing', 'auth'])
      expect(headingsNow()).toEqual(['Last hour', 'Yesterday', 'Not visited yet'])
      /* Each row is described by the heading it sits under; the heading itself is not a tree item. */
      const billing = document.querySelector('[data-space-row="billing"]')!
      expect(document.getElementById(billing.getAttribute('aria-describedby')!)!.textContent).toBe('Yesterday')
      expect(document.querySelector('[data-space-heading]')!.getAttribute('aria-hidden')).toBe('true')
      expect(billing.querySelector('button[title]')!.getAttribute('title')).toBe('Activity 1 d ago')
      view.done()

      /* Remembered: drawn again, it is still Recent. */
      view = draw(spaceHere(TREE, { epic: 'search', parts: [] }), activity)
      expect(document.querySelector('[data-order="recent"]')!.getAttribute('aria-checked')).toBe('true')
      expect(rowKeys()).toEqual(['search', 'billing', 'auth'])
      view.done()
    })

    test('search finds at every depth, ordered by match, with no headings', async () => {
      await act(async () => {
        await store.setSort('epics', 'recent')
      })
      const view = draw(spaceHere(TREE, { epic: 'search', parts: [] }))
      expect(headingsNow().length).toBeGreaterThan(0)
      typeFilter('in')
      expect(headingsNow()).toEqual([])
      /* Billing holds "in" itself and comes before Auth, which only leads to Login; every branch above a match is open. */
      expect(rowKeys()).toEqual(['billing', 'billing/invoices', 'auth', 'auth/login'])
      typeFilter('inv')
      expect(rowKeys()).toEqual(['billing', 'billing/invoices'])
      expect(headingsNow()).toEqual([])
      typeFilter('')
      expect(headingsNow().length).toBeGreaterThan(0)
      store.resetPickerStore()
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
