import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The bar's small Inbox count, rendered (`src/canvas/InboxCount.tsx`): the Inbox module's icon with
 * the number in the attention colour, or with "Show notification colour and number" off the plain
 * icon alone — the count said in its accessible name either way; a press goes to the Inbox placed on
 * this kehikko, or opens the popover with the offer to place it, the top items as text and the
 * checkbox.
 *
 * In a process of its own, as `whats-new-dom.test.tsx` explains.
 */

const inChild = process.env.INBOX_COUNT_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('the bar’s Inbox count, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, INBOX_COUNT_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 120_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Count: typeof import('../src/canvas/InboxCount.tsx')
let Bar: typeof import('../src/host/inboxBar.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Count = await import('../src/canvas/InboxCount.tsx')
  Bar = await import('../src/host/inboxBar.ts')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})
afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

describe.if(inChild)('the bar’s Inbox count', () => {
  let unmount: (() => void) | null = null
  afterEach(() => {
    act(() => unmount?.())
    unmount = null
    document.body.innerHTML = ''
  })

  type View = import('../src/canvas/InboxCount.tsx').InboxCountView
  const nothing = () => {}
  const base = (more: Partial<View> = {}): View => ({
    look: Bar.countLook(2, true),
    module: { id: 'kehikot.shows', name: 'Shows', icon: 'lucide:inbox' },
    placedHere: false,
    onFocusInbox: nothing,
    open: false,
    onOpenChange: nothing,
    offer: null,
    items: [],
    colour: true,
    onColour: nothing,
    ...more,
  })
  async function render(view: View) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<TooltipProvider><Count.InboxCount view={view} /></TooltipProvider>))
    unmount = () => root.unmount()
    return document.querySelector<HTMLElement>('[data-inbox-count]')!
  }

  test('colour and number on: the module’s icon, the number, the attention colour, the count in words', async () => {
    const button = await render(base())
    expect(button.querySelector('[data-module-icon="lucide:inbox"]')).not.toBeNull()
    expect(button.querySelector('[data-inbox-number]')?.textContent).toBe('2')
    expect(button.className).toContain('text-amber-600')
    expect(button.hasAttribute('data-attention')).toBe(true)
    expect(button.getAttribute('aria-label')).toContain('2 need you')
  })

  test('off: the plain icon, no number, no colour, and still the count in words', async () => {
    const button = await render(base({ look: Bar.countLook(2, false), colour: false }))
    expect(button.querySelector('[data-module-icon="lucide:inbox"]')).not.toBeNull()
    expect(button.querySelector('[data-inbox-number]')).toBeNull()
    expect(button.className).not.toContain('text-amber-600')
    expect(button.hasAttribute('data-attention')).toBe(false)
    expect(button.getAttribute('aria-label')).toContain('2 need you')
  })

  test('with the Inbox placed here a press goes to it and opens nothing', async () => {
    let focused = 0
    const opened: boolean[] = []
    const button = await render(base({ placedHere: true, onFocusInbox: () => (focused += 1), onOpenChange: (open) => opened.push(open) }))
    await act(async () => button.click())
    expect(focused).toBe(1)
    expect(opened.every((one) => !one)).toBe(true)
    expect(document.querySelector('[data-inbox-popover]')).toBeNull()
  })

  test('without it the popover offers to add it, lists the top items as text, and holds the checkbox in both states', async () => {
    let added = 0
    const colours: boolean[] = []
    for (const colour of [true, false]) {
      await render(
        base({
          open: true,
          colour,
          look: Bar.countLook(2, colour),
          offer: { label: Bar.addWords('Shows'), run: () => (added += 1) },
          items: [{ key: 'a', text: 'Asker says · needs you: <b>Merge?</b>' }],
          onColour: (on) => colours.push(on),
        }),
      )
      const popover = document.querySelector<HTMLElement>('[data-inbox-popover]')!
      expect(popover).not.toBeNull()
      expect(popover.querySelector('[data-inbox-add]')?.textContent).toContain('Add Shows to this kehikko')
      const top = popover.querySelector('[data-inbox-top]')!
      expect(top.textContent).toContain('<b>Merge?</b>')
      expect(top.querySelector('b')).toBeNull()
      const box = popover.querySelector<HTMLElement>('[data-inbox-colour]')!
      expect(box.getAttribute('aria-checked')).toBe(colour ? 'true' : 'false')
      expect(popover.textContent).toContain('Show notification colour and number')
      await act(async () => box.click())
      await act(async () => popover.querySelector<HTMLElement>('[data-inbox-add]')!.click())
      act(() => unmount?.())
      unmount = null
      document.body.innerHTML = ''
    }
    expect(colours).toEqual([false, true])
    expect(added).toBe(2)
  })
})
