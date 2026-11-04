import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'

import type { RemoveAnswer, ScanState } from '../src/host/worktrees.ts'

/*
 * The cleanup dialog's content (`src/canvas/Worktrees.tsx`): grouped by
 * project, every finished worktree checked, the press says how many and how
 * much, one confirmation, and the report of what was removed and skipped.
 *
 * In a process of its own, as `whats-new-dom.test.tsx` explains.
 */

const inChild = process.env.WORKTREES_DOM === '1'
const TESTS = 1

if (!inChild) {
  test('the worktree cleanup list and its confirmation, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, WORKTREES_DOM: '1' },
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
let WorktreesBody: typeof import('../src/canvas/Worktrees.tsx').WorktreesBody

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ WorktreesBody } = await import('../src/canvas/Worktrees.tsx'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const NOW = Date.UTC(2026, 10, 4, 12)
const GB = 1_000_000_000

const state: ScanState = {
  scanning: false,
  error: null,
  auto: false,
  scan: {
    at: NOW,
    took: 4000,
    projects: [
      {
        id: 1,
        name: 'thesis',
        path: '/p/thesis',
        notes: [],
        rows: [
          { path: '/w/a', repo: '/p/thesis', branch: 'fix-a', done: 'PR #12 merged', kept: null, bytes: 2 * GB, changedAt: NOW - 3 * 86_400_000 },
          { path: '/w/b', repo: '/p/thesis', branch: 'fix-b', done: 'contained in main', kept: null, bytes: 1 * GB, changedAt: NOW - 5 * 86_400_000 },
          { path: '/w/c', repo: '/p/thesis', branch: 'fix-c', done: 'PR #9 closed', kept: '1 tracked file has changes', bytes: null, changedAt: NOW },
        ],
      },
      {
        id: 2,
        name: 'app',
        path: '/p/app',
        notes: ['1 other worktree is still in progress and not listed.'],
        rows: [{ path: '/w/d', repo: '/p/app', branch: 'feat-d', done: 'MR !4 merged', kept: null, bytes: 500_000_000, changedAt: NOW - 2 * 86_400_000 }],
      },
    ],
  },
}

if (inChild) {
  test('every finished worktree checked, one unchecked, one confirmation, the report', async () => {
    const asked: string[][] = []
    const api = {
      state: async () => state,
      scan: async () => state,
      remove: async (paths: string[]): Promise<RemoveAnswer> => {
        asked.push(paths)
        return {
          ok: true,
          removed: [{ path: '/w/a', branch: 'fix-a', bytes: 2 * GB, branchDeleted: true }],
          skipped: [{ path: '/w/d', why: 'something in it changed in the last 24 hours' }],
        }
      },
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(React.createElement(WorktreesBody, { api, pollMs: 1, now: () => NOW }))
    })
    await act(async () => {})

    /* Grouped by project, with why and how much. */
    const sections = [...host.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))
    expect(sections).toEqual(['thesis', 'app'])
    expect(host.textContent).toContain('PR #12 merged · 2 GB · last changed 3 days ago')
    expect(host.textContent).toContain('MR !4 merged')
    expect(host.textContent).toContain('1 finished but left alone')
    expect(host.textContent).toContain('left alone: 1 tracked file has changes.')

    const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    /* Only the offered ones have a box, and every one starts checked. */
    expect(boxes).toHaveLength(3)
    expect(boxes.every((b) => b.checked)).toBe(true)
    const press = () => [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Remove'))!
    expect(press().textContent).toBe('Remove 3 worktrees (3.5 GB)')

    await act(async () => {
      boxes[1]!.click()
    })
    expect(press().textContent).toBe('Remove 2 worktrees (2.5 GB)')

    /* One confirmation before anything is removed. */
    await act(async () => {
      press().click()
    })
    expect(asked).toEqual([])
    const confirm = host.querySelector('[data-worktrees-confirm]')!
    expect(confirm.textContent).toContain('Remove 2 worktrees (2.5 GB)?')
    const go = [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Remove')!
    await act(async () => {
      go.click()
    })
    await act(async () => {})
    expect(asked).toEqual([['/w/a', '/w/d']])

    const report = host.querySelector('[data-worktrees-report]')!
    expect(report.textContent).toContain('Removed 1 worktree, freeing 2 GB. Skipped 1.')
    expect(report.textContent).toContain('Removed fix-a (2 GB), and its local branch.')
    expect(report.textContent).toContain('Skipped /w/d: something in it changed in the last 24 hours.')
    await act(async () => root.unmount())
  })
}
