import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import type { NewsItem } from '../src/host/whatsNew.ts'

/*
 * "What's new" says each thing once: a release is drawn once (no header card
 * over a list that repeats it), the works-with sentence is the dialog's label
 * and not also a paragraph of the notes, and the release workflow's
 * "Built from" line is not body text. Every other paragraph stays.
 *
 * In a process of its own, as `whats-new-dom.test.tsx` explains.
 */

const inChild = process.env.WHATS_NEW_ONCE_DOM === '1'
const TESTS = 4

if (!inChild) {
  test('"What\'s new" shows each thing once, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, WHATS_NEW_ONCE_DOM: '1' },
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
let WhatsNew: typeof import('../src/canvas/WhatsNew.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  WhatsNew = await import('../src/canvas/WhatsNew.tsx')
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

const WORKS = 'Works with Kehikot 0.1.65 and later'

const body = (tag: string, extra = '') =>
  `### What's new\n- **Reviews read the epic from Kehikot ${tag}.** When a review weighs a change.\n\n${extra}Works with Kehikot 0.1.65 and later.\n\n<sub>Built from 198ca3f</sub>`

const load = (async (repo: string, tag: string) => ({
  repo,
  tag,
  name: tag,
  body: body(tag, 'A second paragraph that stays.\n\n'),
  url: `https://github.com/${repo}/releases/tag/${tag}`,
  publishedAt: '2026-10-26T10:00:00Z',
  prerelease: false,
})) as unknown as typeof import('../src/host/releaseNotes.ts').fetchNotes

function item(tags: string[], extra: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'kehikot.factory',
    kind: 'module',
    name: 'Factory',
    repo: 'Jalez/kehikko-factory',
    from: '0.5.0',
    to: '0.6.0',
    tags,
    follows: 'release',
    works: Object.fromEntries(tags.map((tag) => [tag, WORKS])),
    ack: {},
    news: true,
    preparing: false,
    ...extra,
  } as NewsItem
}

async function show(one: NewsItem) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const made = createRoot(root)
  await act(async () => made.render(<TooltipProvider><WhatsNew.WhatsNewDialog open items={[one]} show onClose={() => {}} load={load} /></TooltipProvider>))
  unmount = () => made.unmount()
  for (let i = 0; i < 40 && document.querySelector('[data-pane] [data-testid="release-notes-release"] p')?.textContent?.startsWith('Reading') !== false; i++) {
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 15)))
  }
  await act(async () => await new Promise((resolve) => setTimeout(resolve, 30)))
  return document.querySelector(`[data-pane="${one.id}"]`) as HTMLElement
}

const count = (text: string, of: string) => text.split(of).length - 1

describe.skipIf(!inChild)('each thing once', () => {
  test('a single release shows its notes once and the works-with text once', async () => {
    const pane = await show(item(['v0.6.0']))
    expect(pane.querySelectorAll('[data-testid="release-notes-release"]').length).toBe(1)
    expect(count(pane.textContent!, 'Reviews read the epic from Kehikot')).toBe(1)
    expect(count(pane.textContent!, WORKS)).toBe(1)
    expect(pane.querySelector('[data-testid="release-notes-works"]')!.textContent).toBe(WORKS)
    /* The header names it once; no second "Factory 0.6.0" heading under it. */
    expect(count(pane.textContent!, 'Factory')).toBe(1)
    expect(pane.textContent).toContain('0.5.0 → 0.6.0')
  })

  test('a module with several releases shows each release once', async () => {
    const pane = await show(item(['v0.6.0', 'v0.5.1']))
    const sections = [...pane.querySelectorAll('[data-testid="release-notes-release"]')]
    expect(sections.map((one) => one.getAttribute('data-tag'))).toEqual(['v0.6.0', 'v0.5.1'])
    expect(count(pane.textContent!, 'Reviews read the epic from Kehikot v0.6.0')).toBe(1)
    expect(count(pane.textContent!, 'Reviews read the epic from Kehikot v0.5.1')).toBe(1)
    expect(count(pane.textContent!, 'Factory 0.6.0')).toBe(1)
    expect(count(pane.textContent!, 'Factory 0.5.1')).toBe(1)
    expect(pane.textContent).toContain('2 releases')
    expect(pane.querySelectorAll('[data-testid="release-notes-works"]').length).toBe(2)
    expect(count(pane.textContent!, WORKS)).toBe(2)
  })

  test('the body keeps every other paragraph, and a sentence inside other text is untouched', async () => {
    const pane = await show(item(['v0.6.0']))
    expect(pane.textContent).toContain('A second paragraph that stays.')
    expect(pane.textContent).toContain('When a review weighs a change.')
    const { Markdown } = await import('../src/canvas/ReleaseNotes.tsx')
    const root = document.createElement('div')
    document.body.appendChild(root)
    const made = createRoot(root)
    await act(async () => made.render(<Markdown source={'It said Works with Kehikot 0.1.65 and later. in passing.\n\nNeeds a Kehikot newer than 0.1.41 (protocol 2.11 or later).\n\nKept.'} withoutWorksWith />))
    expect(root.textContent).toContain('It said Works with Kehikot 0.1.65 and later. in passing.')
    expect(root.textContent).not.toContain('Needs a Kehikot newer')
    expect(root.textContent).toContain('Kept.')
    act(() => made.unmount())
  })

  test('the "Built from" line is not shown as body text', async () => {
    const pane = await show(item(['v0.6.0']))
    expect(pane.textContent).not.toContain('Built from')
    const { Markdown } = await import('../src/canvas/ReleaseNotes.tsx')
    const root = document.createElement('div')
    document.body.appendChild(root)
    const made = createRoot(root)
    await act(async () => made.render(<Markdown source={'Text.\n\n<sub>Built from 198ca3f</sub>\n\nMore.'} withoutWorksWith />))
    expect(root.textContent).not.toContain('Built from')
    expect(root.textContent).toContain('More.')
    act(() => made.unmount())
  })

})
