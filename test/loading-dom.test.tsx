import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test'

/*
 * The app's loading effect: the feedback list while it is read (spinner,
 * `role="status"`, label, skeleton rows), the slow-answer line after 8 s with
 * its way out, and a sample of the other waits that used to be words alone.
 *
 * In a process of its own, as `whats-new-dom.test.tsx` explains.
 */

const inChild = process.env.LOADING_DOM === '1'
const TESTS = 6

if (!inChild) {
  test('waiting looks alive, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, LOADING_DOM: '1' },
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
let Feedback: typeof import('../src/canvas/Feedback.tsx')
let Loading: typeof import('../src/components/ui/loading.tsx')
let Menu: typeof import('../src/components/ui/dropdown-menu.tsx')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Feedback = await import('../src/canvas/Feedback.tsx')
  Loading = await import('../src/components/ui/loading.tsx')
  Menu = await import('../src/components/ui/dropdown-menu.tsx')
})

afterAll(async () => {
  if (!inChild) return
  jest.useRealTimers()
  await GlobalRegistrator.unregister()
})

let unmount: (() => void) | null = null
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
})

async function render(node: React.ReactElement) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const made = createRoot(root)
  await act(async () => made.render(node))
  unmount = () => made.unmount()
}

function waiting(extra: Partial<import('../src/canvas/Feedback.tsx').FeedbackState> = {}) {
  return {
    listing: null,
    line: null,
    loading: true,
    slow: false,
    stopped: false,
    cancel() {},
    retry() {},
    opened() {},
    writing: false,
    write() {},
    sent() {},
    ...extra,
  } as import('../src/canvas/Feedback.tsx').FeedbackState
}

const rows = (feedback: import('../src/canvas/Feedback.tsx').FeedbackState) =>
  render(
    <Menu.DropdownMenu open modal={false}>
      <Menu.DropdownMenuTrigger>x</Menu.DropdownMenuTrigger>
      <Menu.DropdownMenuContent>
        <Feedback.FeedbackRows feedback={feedback} />
      </Menu.DropdownMenuContent>
    </Menu.DropdownMenu>,
  )

describe.skipIf(!inChild)('waiting looks alive', () => {
  test('the feedback list shows the spinner, a status role, the label and skeleton rows', async () => {
    await rows(waiting())
    const status = document.querySelector('[data-testid="feedback-loading"] [role="status"]')
    expect(status).not.toBeNull()
    expect(status?.getAttribute('aria-live')).toBe('polite')
    expect(status?.textContent).toContain('Reading feedback from GitHub…')
    expect(status?.querySelector('svg.animate-spin, svg[class*="animate-spin"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-skeleton]').length).toBeGreaterThanOrEqual(3)
    expect(document.querySelector('[data-testid="feedback-slow"]')).toBeNull()
  })

  test('the spinner turns only where motion is safe', async () => {
    await rows(waiting())
    const cls = document.querySelector('[role="status"] svg')?.getAttribute('class') ?? ''
    expect(cls).toContain('motion-safe:animate-spin')
    expect(cls.split(/\s+/)).not.toContain('animate-spin')
  })

  test('past the slow mark the quiet line and Cancel appear', async () => {
    await rows(waiting({ slow: true }))
    expect(document.querySelector('[data-testid="feedback-slow"]')?.textContent).toBe('Still reading — GitHub is slow to answer')
    expect(document.body.textContent).toContain('Cancel')
  })

  test('useSlow turns true after 8 s of waiting and false when the wait ends', async () => {
    jest.useFakeTimers()
    try {
      const seen: boolean[] = []
      function Probe({ on }: { on: boolean }) {
        const slow = Loading.useSlow(on)
        seen.push(slow)
        return <span data-slow={String(slow)} />
      }
      await render(<Probe on />)
      const slow = () => document.querySelector('[data-slow]')?.getAttribute('data-slow')
      expect(slow()).toBe('false')
      await act(async () => jest.advanceTimersByTime(7900))
      expect(slow()).toBe('false')
      await act(async () => jest.advanceTimersByTime(200))
      expect(slow()).toBe('true')
      await act(async () => unmount?.())
      await render(<Probe on={false} />)
      expect(slow()).toBe('false')
    } finally {
      jest.useRealTimers()
    }
  })

  test('a stopped read offers Try again', async () => {
    await rows(waiting({ loading: false, stopped: true, line: 'Stopped waiting for GitHub.' }))
    expect(document.body.textContent).toContain('Stopped waiting for GitHub.')
    expect(document.body.textContent).toContain('Try again')
    expect(document.querySelector('[data-testid="feedback-loading"]')).toBeNull()
  })

  test('swept waits use the same loader: the Skills window and the What\'s new list row', async () => {
    const { SkillsDialog } = await import('../src/canvas/Skills.tsx')
    const { TooltipProvider } = await import('../src/components/ui/tooltip.tsx')
    const { WhatsNewDialog } = await import('../src/canvas/WhatsNew.tsx')
    const real = globalThis.fetch
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
    try {
      await render(<TooltipProvider><SkillsDialog open onOpenChange={() => {}} module="kehikot.factory" name="Factory" /></TooltipProvider>)
      const status = document.querySelector('[role="status"]')
      expect(status?.textContent).toContain('Asking Factory what it offers…')
      expect(status?.querySelector('svg')).not.toBeNull()
    } finally {
      globalThis.fetch = real
    }
    act(() => unmount?.())
    document.body.innerHTML = ''
    const item = {
      id: 'kehikot.factory', kind: 'module', name: 'Factory', repo: 'Jalez/kehikko-factory', from: '0.5.0', to: '0.6.0',
      tags: [], follows: 'release', works: {}, ack: {}, news: true, preparing: true,
    } as unknown as import('../src/host/whatsNew.ts').NewsItem
    await render(<TooltipProvider><WhatsNewDialog open items={[item]} show onClose={() => {}} /></TooltipProvider>)
    const row = document.querySelector('[data-preparing]')
    expect(row?.textContent).toContain('Preparing…')
    expect(row?.querySelector('svg')?.getAttribute('class')).toContain('motion-safe:animate-spin')
  })
})
