import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * An install or update as the page shows it (`StepProgress.tsx`): the step and
 * its time, a bar that fills or slides, the step a failure stopped at and why,
 * the stall notice with Cancel, several at once as a list — and the
 * container's cover saying the step instead of only "Updating".
 *
 * In a process of its own, for the reason `updates-panel.test.tsx` gives.
 */

const inChild = process.env.STEP_PROGRESS_DOM === '1'
const TESTS = 6

if (!inChild) {
  test('install and update progress, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, STEP_PROGRESS_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

type JobSaid = import('../src/host/jobSteps.ts').JobSaid

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let View: typeof import('../src/canvas/StepProgress.tsx')
let Cover: typeof import('../src/canvas/Conditions.tsx')
let Steps: typeof import('../src/host/jobSteps.ts')
let posted: Array<{ url: string; body: string }> = []
let jobsNow: Record<string, JobSaid> = {}

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') posted.push({ url, body: String(init.body) })
    if (url === '/host/steps/cancel') return new Response(JSON.stringify({ cancelled: true }))
    return new Response(JSON.stringify({ jobs: jobsNow, active: false }))
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  View = await import('../src/canvas/StepProgress.tsx')
  Cover = await import('../src/canvas/Conditions.tsx')
  Steps = await import('../src/host/jobSteps.ts')
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
  posted = []
  jobsNow = {}
  document.body.innerHTML = ''
})

async function render(node: import('react').ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  unmount = () => root.unmount()
  return host
}

const job = (over: Partial<JobSaid> = {}): JobSaid => ({
  id: 'kehikot.notes',
  name: 'Notes',
  kind: 'update',
  step: 'installing',
  detail: null,
  fraction: null,
  stepMs: 12_400,
  totalMs: 15_000,
  steps: [],
  stalled: false,
  cancellable: true,
  ...over,
})

describe('one job', () => {
  test.if(inChild)('says the step and its time, with a sliding bar where the step cannot say how far', async () => {
    const host = await render(React.createElement(View.StepProgress, { job: job() }))
    expect(host.querySelector('[data-testid="step-line"]')!.textContent).toBe('Installing dependencies… 0:12')
    const bar = host.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('data-state')).toBe('indeterminate')
    expect(bar.hasAttribute('aria-valuenow')).toBe(false)
  })

  test.if(inChild)('a fraction fills the bar', async () => {
    const host = await render(React.createElement(View.StepProgress, { job: job({ step: 'cloning', fraction: 0.42, stepMs: 3_000 }) }))
    expect(host.querySelector('[data-testid="step-line"]')!.textContent).toBe('Downloading… 0:03')
    expect(host.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('42')
  })

  test.if(inChild)('a failure says which step it stopped at and the reason, with no bar', async () => {
    const why = 'Notes was updated, but its dependencies could not be installed: the lockfile had changes.'
    const host = await render(React.createElement(View.StepProgress, { job: job({ step: 'failed', failed: { step: 'installing', why }, cancellable: false }) }))
    expect(host.querySelector('[data-testid="step-line"]')!.textContent).toBe('Stopped while installing dependencies')
    expect(host.querySelector('[data-testid="step-failed"]')!.textContent).toBe(why)
    expect(host.querySelector('[role="progressbar"]')).toBeNull()
  })

  test.if(inChild)('stalled for a minute: it says so, and Cancel asks the host to stop that one job', async () => {
    const host = await render(React.createElement(View.StepProgress, { job: job({ stalled: true, stepMs: 75_000 }) }))
    const stalled = host.querySelector('[data-testid="step-stalled"]')!
    expect(stalled.textContent).toContain('Nothing has changed for over a minute while installing dependencies')
    const cancel = [...stalled.querySelectorAll('button')].find((one) => one.textContent === 'Cancel')!
    await act(async () => cancel.click())
    expect(posted).toEqual([{ url: '/host/steps/cancel', body: JSON.stringify({ id: 'kehikot.notes' }) }])
  })
})

describe('several, and the cover', () => {
  test.if(inChild)('several modules show as a list, each with its state, running ones first', async () => {
    const host = await render(
      React.createElement(View.StepList, {
        jobs: [
          job({ id: 'a', name: 'Alpha', step: 'done', totalMs: 31_000, cancellable: false }),
          job({ id: 'b', name: 'Beta', step: 'queued', detail: '1 ahead', stepMs: 2_000 }),
          job({ id: 'c', name: 'Gamma', step: 'building', stepMs: 4_000 }),
        ],
      }),
    )
    const lines = [...host.querySelectorAll('[data-testid="step-line"]')].map((one) => one.textContent)
    expect(lines).toEqual(['Beta: Waiting for its turn (1 ahead)… 0:02', 'Gamma: Building the page… 0:04', 'Alpha: Done in 0:31'])
  })

  test.if(inChild)('a container being updated shows the step, the time and a bar on its cover', async () => {
    jobsNow = { 'kehikot.notes': job({ step: 'waiting', stepMs: 5_000 }) }
    Steps.setStepsForTest(jobsNow)
    const host = await render(React.createElement(Cover.ModuleCover, { state: 'updating', at: 'http://127.0.0.1:7940', id: 'kehikot.notes', name: 'Notes' }))
    const cover = host.querySelector('[data-testid="module-cover"]')!
    expect(cover.querySelector('[data-testid="step-line"]')!.textContent).toBe('Waiting for it to answer… 0:05')
    expect(cover.querySelector('[role="progressbar"]')).not.toBeNull()
  })
})
