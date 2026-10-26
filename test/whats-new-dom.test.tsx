import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import type { InstalledModule, Position, WhatsNewEdit, WhatsNewRecord } from '../src/host/whatsNew.ts'

/*
 * "What's new" after an update, rendered: the bar's notice (there at once
 * when anything is news, never on the first run, never the dialog by itself,
 * not waiting for GitHub, not taking focus from a module, gone once pressed,
 * none with the setting off, and its narrow forms), what the dialog lists —
 * "Preparing…" rows that fill in — what opening it, "Got it" and "Don't show
 * this after updates" record, Settings' switch, the notes and the offline
 * sentence, and the layout that folds under 640 pixels.
 *
 * In a process of its own for the reason `updates-panel.test.tsx` gives:
 * Radix decides at load whether it has a DOM. The host behind it is a fake
 * kept with the same rules the server uses (`src/host/whatsNew.ts`).
 */

const inChild = process.env.WHATS_NEW_DOM === '1'
const TESTS = 19

if (!inChild) {
  test('"What\'s new", rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, WHATS_NEW_DOM: '1' },
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
let Rules: typeof import('../src/host/whatsNew.ts')
let Settings: typeof import('../src/canvas/Settings.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (url: string, init?: RequestInit) => answer(String(url), init)) as typeof fetch
  window.open = ((url: string) => {
    opened.push(url)
    return null
  }) as typeof window.open
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  WhatsNew = await import('../src/canvas/WhatsNew.tsx')
  Rules = await import('../src/host/whatsNew.ts')
  Settings = await import('../src/canvas/Settings.tsx')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const opened: string[] = []
let unmount: (() => void) | null = null
afterEach(() => {
  if (!inChild) return
  act(() => unmount?.())
  unmount = null
  document.body.innerHTML = ''
  opened.length = 0
  offline = false
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/* ---- the fake host ---- */

interface Copy {
  id: string
  name: string
  position: Position
  local: string[]
}

let host: { record: WhatsNewRecord | null; copies: Copy[]; updating: string[]; posts: WhatsNewEdit[] }
let offline = false

const at = (release: string | null, commit: string | null = null): Position => ({ release, commit })
const copy = (id: string, name: string, release: string, local: string[] = [release]): Copy => ({ id, name, position: at(release), local })

function start(record: WhatsNewRecord | null, copies: Copy[]) {
  host = { record, copies, updating: [], posts: [] }
}

function installed(): InstalledModule[] {
  return host.copies.map((one) => {
    const range = Rules.rangeFor(host.record?.modules[one.id], one.position, one.local)
    return {
      id: one.id,
      name: one.name,
      repo: `Jalez/kehikko-${one.name.toLowerCase()}`,
      follows: one.position.release ? 'release' : 'main',
      position: one.position,
      range,
      works: Object.fromEntries(range.map((tag) => [tag, 'Works with Kehikot 0.1.39 and later'])),
    }
  })
}

const here = () => Object.fromEntries(host.copies.map((one) => [one.id, one.position]))

function edit(change: WhatsNewEdit): WhatsNewRecord {
  const base = host.record ?? Rules.baselined(null, null, here())
  if ('baseline' in change) host.record = Rules.baselined(host.record, change.baseline.app, here())
  else if ('acknowledge' in change) host.record = Rules.acknowledged(base, change.acknowledge)
  else if ('read' in change) host.record = Rules.afterRead(base, change.read.module, change.read.from, change.read.to)
  else host.record = { ...base, show: change.show }
  return host.record
}

const notesOf = (repo: string, tag: string) => ({
  repo,
  tag,
  name: tag,
  body: `### What's new\n- **Faster** ${tag}\n- <img src=x onerror="window.hacked=1">\n\n<sub>Built from abc1234</sub>`,
  url: `https://github.com/${repo}/releases/tag/${tag}`,
  publishedAt: '2026-10-19T11:35:41Z',
  prerelease: false,
})

function answer(url: string, init?: RequestInit): Response {
  if (url.startsWith('/host/whats-new')) {
    if (init?.method === 'POST') {
      const change = JSON.parse(String(init.body)) as WhatsNewEdit
      host.posts.push(change)
      return json({ record: edit(change) })
    }
    if (url.includes('only=record')) return json({ record: host.record })
    return json({ record: host.record, modules: installed(), updating: host.updating })
  }
  if (url.startsWith('/host/releases')) {
    if (offline) return json({ error: 'GitHub could not be reached — this computer may be offline.' }, 502)
    return json({ releases: ['v0.1.44', 'v0.1.43', 'v0.1.42', 'v0.1.41'].map((tag) => ({ ...notesOf('Jalez/kehikko-desktop', tag), body: undefined })) })
  }
  if (url.startsWith('/host/release-notes')) {
    const query = new URL(url, 'http://x').searchParams
    if (offline) return json({ error: 'GitHub could not be reached — this computer may be offline.', url: 'https://github.com/x' }, 502)
    return json(notesOf(query.get('repo')!, query.get('tag')!))
  }
  return json({}, 404)
}

/* ---- rendering ---- */

const tick = (ms = 10) => act(async () => await new Promise((resolve) => setTimeout(resolve, ms)))

/** Wait, in small steps, until `check` holds or `ms` have passed. */
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await tick(15)
}

let openings = 0
let watch: MutationObserver | null = null

async function render(node: React.ReactNode) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const made = createRoot(root)
  openings = 0
  watch?.disconnect()
  watch = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches('[data-whats-new]') || node.querySelector('[data-whats-new]'))) openings++
      }
  })
  watch.observe(document.body, { childList: true, subtree: true })
  await act(async () => made.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => {
    watch?.disconnect()
    made.unmount()
  }
  await tick()
  return root
}

const dialog = () => document.querySelector('[data-whats-new]')
const notice = () => document.querySelector<HTMLElement>('[data-testid="whats-new-notice"]')
const items = () => [...document.querySelectorAll('[data-whats-new] [data-item]')].map((one) => one.getAttribute('data-item'))

function Host(props: Partial<import('../src/canvas/WhatsNew.tsx').WhatsNewDeps> = {}) {
  return (
    <>
      <WhatsNew.WhatsNewNotice />
      <WhatsNew.WhatsNewHost app="0.1.43" pollMs={40} {...props} />
    </>
  )
}

async function click(element: Element) {
  await act(async () => {
    ;(element as HTMLElement).focus?.()
    ;(element as HTMLElement).click()
  })
  await tick()
}

/** The notice is there; press it, and the dialog is open. */
async function openFromNotice() {
  await until(() => notice() !== null)
  expect(notice()).not.toBeNull()
  await click(notice()!)
  await until(() => dialog() !== null)
  expect(dialog()).not.toBeNull()
}

describe.skipIf(!inChild)('the notice in the bar', () => {
  test('not on the very first run: what is here is recorded instead', async () => {
    start(null, [copy('kehikot.journeys', 'Journeys', 'v1.6.0')])
    await render(<Host />)
    await tick(200)
    expect(notice()).toBeNull()
    expect(dialog()).toBeNull()
    expect(host.posts).toEqual([{ baseline: { app: '0.1.43' } }])
    expect(host.record).toEqual({ app: '0.1.43', modules: { 'kehikot.journeys': at('v1.6.0') }, show: true, told: ['auto-updates'] })
  })

  test('nothing new: no notice', async () => {
    start({ app: '0.1.43', modules: { 'kehikot.journeys': at('v1.6.0') }, show: true }, [copy('kehikot.journeys', 'Journeys', 'v1.6.0')])
    await render(<Host />)
    await tick(200)
    expect(notice()).toBeNull()
    expect(dialog()).toBeNull()
  })

  test('after an app update it is there at once, before GitHub answers, and the dialog never opens by itself', async () => {
    start({ app: '0.1.41', modules: {}, show: true }, [])
    let asked = 0
    const never = () => {
      asked++
      return new Promise<never>(() => {})
    }
    await render(<Host releases={never} />)
    await until(() => notice() !== null, 200)
    expect(notice()!.textContent).toContain('What’s new in 0.1.43')
    expect(notice()!.getAttribute('aria-label')).toBe('What’s new: Kehikot 0.1.43 — press to read')
    /* The release list is asked after, in the background: the notice did not wait for it. */
    expect(asked).toBe(1)
    await tick(300)
    expect(dialog()).toBeNull()
    expect(openings).toBe(0)
    /* Pressed, with GitHub still silent: Kehikot's row has the running release. */
    await openFromNotice()
    expect(items()).toEqual(['kehikot'])
    expect(document.querySelector('[data-testid="whats-new-range"]')!.textContent).toBe('0.1.41 → 0.1.43')
  })

  test('there while focus is in a module page or a field, and typing goes on undisturbed', async () => {
    start({ app: '0.1.41', modules: {}, show: true }, [])
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()
    await render(<Host />)
    await until(() => notice() !== null, 200)
    expect(notice()).not.toBeNull()
    expect(document.activeElement).toBe(field)
    frame.focus()
    await tick(100)
    expect(notice()).not.toBeNull()
    expect(document.activeElement).not.toBe(notice())
    expect(dialog()).toBeNull()
  })

  test('only modules moved: it counts them', async () => {
    start({ app: '0.1.43', modules: { 'kehikot.a': at('v1.0.0'), 'kehikot.b': at('v1.0.0') }, show: true }, [
      copy('kehikot.a', 'A', 'v1.1.0', ['v1.0.0', 'v1.1.0']),
      copy('kehikot.b', 'B', 'v1.1.0', ['v1.0.0', 'v1.1.0']),
    ])
    await render(<Host />)
    await until(() => notice() !== null)
    expect(notice()!.querySelector('[data-notice-text]')!.textContent).toBe('What’s new · 2 modules')
    expect(notice()!.getAttribute('aria-label')).toBe('What’s new: 2 modules — press to read')
  })

  test('a dot and words; in a narrow bar "What\'s new", then its icon, always with the whole label', async () => {
    start({ app: '0.1.41', modules: {}, show: true }, [])
    await render(<Host />)
    await until(() => notice() !== null)
    const one = notice()!
    expect(one.querySelector('[data-notice-dot]')!.getAttribute('aria-hidden')).toBe('true')
    const text = one.querySelector('[data-notice-text]')!
    const short = one.querySelector('[data-notice-short]')!
    const icon = one.querySelector('svg')!
    expect(text.textContent).toBe('What’s new in 0.1.43')
    expect(text.className).toContain('max-[1100px]:hidden')
    expect(short.textContent).toBe('What’s new')
    expect(short.className).toContain('hidden')
    expect(short.className).toContain('max-[1100px]:inline')
    expect(short.className).toContain('max-[900px]:hidden')
    expect(icon.getAttribute('class')).toContain('max-[900px]:block')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    /* One row: the bar's own height, never wrapping. */
    expect(one.className).toContain('h-6')
    expect(one.className).toContain('shrink-0')
    expect(one.className).toContain('max-[900px]:size-6')
    expect(one.getAttribute('aria-label')).toBe('What’s new: Kehikot 0.1.43 — press to read')
  })

  test('pressed: the dialog, with the range and every release; acknowledged as it opens, and the notice goes', async () => {
    start({ app: '0.1.41', modules: {}, show: true }, [])
    await render(<Host />)
    await openFromNotice()
    expect(dialog()!.textContent).toContain('What’s new in Kehikot')
    expect(document.querySelector('[data-testid="whats-new-range"]')!.textContent).toBe('0.1.41 → 0.1.43')
    expect(items()).toEqual(['kehikot'])
    await until(() => host.posts.some((one) => 'acknowledge' in one))
    expect(host.record).toMatchObject({ app: '0.1.43' })
    expect(notice()).toBeNull()
    await until(() => document.querySelectorAll('[data-testid="release-notes-release"]').length === 2)
    const releases = [...document.querySelectorAll('[data-testid="release-notes-release"]')]
    expect(releases.map((one) => one.getAttribute('data-tag'))).toEqual(['v0.1.43', 'v0.1.42'])
    expect(releases[0]!.querySelector('h3')!.textContent).toContain('Kehikot 0.1.43')
    expect(releases[0]!.querySelector('h3')!.textContent).toMatch(/2026/)
    await click(document.querySelector('[data-testid="whats-new-got-it"]')!)
    await until(() => dialog() === null)
    await tick(100)
    expect(notice()).toBeNull()
    expect(openings).toBe(1)
  })

  test('module updates are listed beside Kehikot, with their versions, a count, the notes and which Kehikot they work with', async () => {
    start({ app: '0.1.41', modules: { 'kehikot.journeys': at('v1.5.0'), 'kehikot.notes': at('v2.0.0') }, show: true }, [
      copy('kehikot.journeys', 'Journeys', 'v1.6.0', ['v1.5.0', 'v1.5.1', 'v1.6.0']),
      copy('kehikot.notes', 'Notes', 'v2.0.0'),
    ])
    await render(<Host />)
    await openFromNotice()
    expect(items()).toEqual(['kehikot', 'kehikot.journeys'])
    const tab = document.querySelector('[data-item="kehikot.journeys"]')!
    expect(tab.textContent).toContain('1.5.0 → 1.6.0')
    expect(tab.querySelector('[data-count]')!.textContent).toContain('2')
    await act(async () => {
      tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    await until(() => document.querySelector('[data-pane="kehikot.journeys"] [data-testid="release-notes-works"]') !== null)
    const pane = document.querySelector('[data-pane="kehikot.journeys"]')!
    expect(pane.textContent).toContain('2 releases')
    expect(pane.querySelector('[data-testid="release-notes-works"]')!.textContent).toBe('Works with Kehikot 0.1.39 and later')
    /* Markdown only: the bold is an element, the tag is text, nothing ran. */
    await until(() => pane.querySelector('strong') !== null)
    expect(pane.querySelector('strong')!.textContent).toBe('Faster')
    expect(pane.querySelector('img')).toBeNull()
    expect(pane.textContent).toContain('<img src=x onerror=')
    expect((window as { hacked?: unknown }).hacked).toBeUndefined()
    await click(pane.querySelector('[data-testid="whats-new-github"]')!)
    expect(opened).toEqual(['https://github.com/Jalez/kehikko-journeys/releases'])
  })

  test('Kehikot is drawn with its own mark, each module with its own icon, and nothing with sparkles', async () => {
    const Icons = await import('../src/canvas/ModuleIcon.tsx')
    Icons.setRegisteredIcons([{ id: 'kehikot.journeys', icon: 'lucide:route' }, { id: 'kehikot.notes', icon: null }])
    start({ app: '0.1.41', modules: { 'kehikot.journeys': at('v1.5.0'), 'kehikot.notes': at('v1.0.0') }, show: true }, [
      copy('kehikot.journeys', 'Journeys', 'v1.6.0', ['v1.5.0', 'v1.6.0']),
      copy('kehikot.notes', 'Notes', 'v2.0.0', ['v1.0.0', 'v2.0.0']),
    ])
    await render(<Host />)
    await openFromNotice()
    expect(dialog()!.querySelector('h2 .kehikko-mark, [data-slot="dialog-title"] .kehikko-mark')).not.toBeNull()
    expect(document.querySelector('[data-item="kehikot"] .kehikko-mark')).not.toBeNull()
    expect(document.querySelector('[data-item="kehikot.journeys"] [data-module-icon]')!.getAttribute('data-module-icon')).toBe('lucide:route')
    /* Neither its own nor the list's: the neutral frame and its initial. */
    const notes = document.querySelector('[data-item="kehikot.notes"] [data-module-icon]')!
    expect(notes.getAttribute('data-module-icon')).toBe('fallback')
    expect(notes.textContent).toBe('N')
    expect(dialog()!.querySelector('.lucide-sparkles')).toBeNull()
    Icons.setRegisteredIcons([])
  })

  test('"Got it" acknowledges everything shown, and it does not come back', async () => {
    start({ app: '0.1.41', modules: { 'kehikot.journeys': at('v1.5.0') }, show: true }, [copy('kehikot.journeys', 'Journeys', 'v1.6.0')])
    await render(<Host />)
    await openFromNotice()
    await click(document.querySelector('[data-testid="whats-new-got-it"]')!)
    await until(() => host.posts.some((one) => 'acknowledge' in one))
    expect(host.record).toMatchObject({ app: '0.1.43', modules: { 'kehikot.journeys': at('v1.6.0') }, show: true })
    act(() => unmount?.())
    document.body.innerHTML = ''
    await render(<Host />)
    await tick(300)
    expect(notice()).toBeNull()
    expect(dialog()).toBeNull()
  })

  test('"Don\'t show this after updates": no notice either, what moved is acknowledged, and Settings\' switch brings it back', async () => {
    start({ app: '0.1.41', modules: {}, show: true }, [])
    await render(<Host />)
    await openFromNotice()
    await click(document.querySelector('[data-testid="whats-new-dont-show"]')!)
    await click(document.querySelector('[data-testid="whats-new-got-it"]')!)
    await until(() => host.record?.show === false)
    expect(host.record).toMatchObject({ app: '0.1.43', show: false })
    act(() => unmount?.())
    document.body.innerHTML = ''

    /* Another update: no notice, and acknowledged as it is. */
    host.record = { ...host.record!, app: '0.1.42' }
    await render(<Host />)
    await until(() => host.record?.app === '0.1.43')
    await tick(200)
    expect(notice()).toBeNull()
    expect(dialog()).toBeNull()
    expect(host.record.app).toBe('0.1.43')
    act(() => unmount?.())
    document.body.innerHTML = ''

    /* Settings → About: the switch says it is off, and turns it on. */
    await render(<Settings.SettingsDialog open onOpenChange={() => {}} load={() => new Promise(() => {})} section="about" />)
    await until(() => document.querySelector('button[role="switch"]')?.getAttribute('aria-checked') === 'false')
    const toggle = document.querySelector('button[role="switch"]')!
    expect(toggle.closest('[data-whats-new-setting]')!.textContent).toContain('Show What’s new after updates')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    await until(() => host.record?.show === true)
    expect(host.record!.show).toBe(true)
    act(() => unmount?.())
    document.body.innerHTML = ''

    host.record = { ...host.record!, app: '0.1.42' }
    await render(<Host />)
    await until(() => notice() !== null)
    expect(notice()).not.toBeNull()
  })
})

describe.skipIf(!inChild)('updates from the Updates menu', () => {
  test('"Update all" over five modules finishing at staggered times: the notice counts them, and one press shows all five', async () => {
    const names = ['Journeys', 'Notes', 'Board', 'Paper', 'Claude']
    start(
      { app: '0.1.43', modules: Object.fromEntries(names.map((name) => [`kehikot.${name.toLowerCase()}`, at('v1.0.0')])), show: true },
      names.map((name) => copy(`kehikot.${name.toLowerCase()}`, name, 'v1.0.0', ['v1.0.0', 'v1.1.0'])),
    )
    await render(<Host />)
    await tick(150)
    expect(notice()).toBeNull()

    /* "Update all" runs: one after another, each landing a while after the last. */
    for (const [i, one] of host.copies.entries()) {
      host.updating = [one.id]
      await tick(30 + i * 25)
      one.position = at('v1.1.0')
      host.updating = []
      Rules.pokeWhatsNew({ updated: one.id })
      await until(() => notice()?.querySelector('[data-notice-text]')?.textContent === `What’s new · ${i + 1} module${i ? 's' : ''}`)
      expect(notice()!.querySelector('[data-notice-text]')!.textContent).toBe(`What’s new · ${i + 1} module${i ? 's' : ''}`)
      expect(dialog()).toBeNull()
    }
    await openFromNotice()
    await tick(200)
    expect(openings).toBe(1)
    expect(items()).toEqual(names.map((name) => `kehikot.${name.toLowerCase()}`))
    expect(document.querySelector('[data-testid="whats-new-range"]')!.textContent).toBe('5 modules updated')
  })

  test('a module still updating is a "Preparing…" row that fills in; one whose update failed is left out', async () => {
    start(
      { app: '0.1.43', modules: { 'kehikot.a': at('v1.0.0'), 'kehikot.b': at('v1.0.0'), 'kehikot.c': at('v1.0.0'), 'kehikot.d': at('v1.0.0') }, show: true },
      [
        copy('kehikot.a', 'A', 'v1.1.0', ['v1.0.0', 'v1.1.0']),
        copy('kehikot.b', 'B', 'v1.1.0', ['v1.0.0', 'v1.1.0']),
        copy('kehikot.c', 'C', 'v1.0.0', ['v1.0.0', 'v1.1.0']),
        copy('kehikot.d', 'D', 'v1.0.0', ['v1.0.0', 'v1.1.0']),
      ],
    )
    /* B's update failed after its copy had moved; C's and D's are still running. */
    host.updating = ['kehikot.c', 'kehikot.d']
    await render(<Host />)
    Rules.pokeWhatsNew({ failed: 'kehikot.b' })
    await until(() => notice()?.querySelector('[data-notice-text]')?.textContent === 'What’s new · 3 modules')
    expect(notice()!.querySelector('[data-notice-text]')!.textContent).toBe('What’s new · 3 modules')
    expect(notice()!.getAttribute('aria-label')).toBe('What’s new: 3 modules, 2 still preparing — press to read')
    await openFromNotice()
    expect(items()).toEqual(['kehikot.a', 'kehikot.c', 'kehikot.d'])
    expect(document.querySelector('[data-item="kehikot.c"] [data-preparing]')!.textContent).toBe('Preparing…')
    expect(document.querySelector('[data-testid="whats-new-range"]')!.textContent).toBe('1 module updated · 2 preparing')
    /* Opening acknowledged A, and not what is still preparing. */
    await until(() => host.posts.some((one) => 'acknowledge' in one))
    expect(host.record!.modules['kehikot.a']).toEqual(at('v1.1.0'))
    expect(host.record!.modules['kehikot.c']).toEqual(at('v1.0.0'))
    /* C finishes and the Updates menu says so: its row fills in, no second dialog. */
    host.copies[2]!.position = at('v1.1.0')
    host.updating = ['kehikot.d']
    Rules.pokeWhatsNew({ updated: 'kehikot.c' })
    await until(() => document.querySelector('[data-item="kehikot.c"] [data-preparing]') === null)
    expect(document.querySelector('[data-item="kehikot.c"]')!.textContent).toContain('1.0.0 → 1.1.0')
    /* D finishes with nobody saying so: asked again while it was preparing, it fills in too. */
    host.copies[3]!.position = at('v1.1.0')
    host.updating = []
    await until(() => document.querySelector('[data-item="kehikot.d"] [data-preparing]') === null)
    expect(document.querySelector('[data-item="kehikot.d"]')!.textContent).toContain('1.0.0 → 1.1.0')
    expect(items()).toEqual(['kehikot.a', 'kehikot.c', 'kehikot.d'])
    expect(document.querySelector('[data-testid="whats-new-range"]')!.textContent).toBe('3 modules updated')
    expect(openings).toBe(1)
    await click(document.querySelector('[data-testid="whats-new-got-it"]')!)
    await until(() => host.record!.modules['kehikot.d']?.release === 'v1.1.0')
    expect(host.record!.modules).toMatchObject({ 'kehikot.c': at('v1.1.0'), 'kehikot.d': at('v1.1.0') })
    await tick(150)
    expect(notice()).toBeNull()
  })

  test('notes read in the Updates menu are not told again', async () => {
    start({ app: '0.1.43', modules: { 'kehikot.a': at('v1.0.0'), 'kehikot.b': at('v1.0.0') }, show: true }, [
      copy('kehikot.a', 'A', 'v1.0.0', ['v1.0.0', 'v1.1.0']),
      copy('kehikot.b', 'B', 'v1.0.0', ['v1.0.0', 'v1.1.0']),
    ])
    await render(<Host />)
    await tick(100)
    Rules.readInUpdates('kehikot.a', 'v1.0.0', 'v1.1.0')
    await tick(30)
    for (const one of host.copies) {
      one.position = at('v1.1.0')
      Rules.pokeWhatsNew({ updated: one.id })
    }
    await openFromNotice()
    await tick(100)
    expect(items()).toEqual(['kehikot.b'])
  })
})

describe.skipIf(!inChild)('the dialog', () => {
  test('offline, the pane says so and the rest still shows', async () => {
    offline = true
    start({ app: '0.1.41', modules: { 'kehikot.journeys': at('v1.5.0') }, show: true }, [copy('kehikot.journeys', 'Journeys', 'v1.6.0', ['v1.5.0', 'v1.6.0'])])
    await render(<Host />)
    await openFromNotice()
    await until(() => document.querySelector('[data-testid="release-notes-offline"]') !== null)
    expect(items()).toEqual(['kehikot', 'kehikot.journeys'])
    expect(document.querySelector('[data-testid="whats-new-range"]')!.textContent).toBe('0.1.41 → 0.1.43 · 1 module updated')
    expect(document.querySelector('[data-testid="release-notes-offline"]')!.textContent).toBe(
      'The release notes could not be read just now — this computer may be offline. They come back here once GitHub can be reached.',
    )
    expect(document.querySelectorAll('[data-testid="release-notes-trouble"]')).toHaveLength(0)
  })

  test('a module following main says so, with no notes to read', async () => {
    start({ app: '0.1.43', modules: { 'kehikot.board': at(null, 'aaa1111') }, show: true }, [
      { id: 'kehikot.board', name: 'Board', position: at(null, 'bbb2222'), local: [] },
    ])
    await render(<Host />)
    await openFromNotice()
    const pane = document.querySelector('[data-pane="kehikot.board"]')!
    expect(pane.querySelector('[data-testid="whats-new-main"]')!.textContent).toContain('following main · no release notes')
    expect(pane.textContent).toContain('It moved from aaa1111 to bbb2222.')
  })

  test('on demand, from Settings → About or the Updates menu: everything installed, even with nothing new', async () => {
    start({ app: '0.1.43', modules: { 'kehikot.journeys': at('v1.6.0') }, show: true }, [copy('kehikot.journeys', 'Journeys', 'v1.6.0')])
    await render(<Host />)
    await tick(200)
    expect(dialog()).toBeNull()
    act(() => Rules.openWhatsNew())
    await until(() => dialog() !== null)
    expect(items()).toEqual(['kehikot', 'kehikot.journeys'])
    expect(document.querySelector('[data-testid="whats-new-range"]')!.textContent).toBe('0.1.43')
  })

  test('keyboard: the list is a tab list the arrows walk, Escape closes and acknowledges', async () => {
    start({ app: '0.1.41', modules: { 'kehikot.journeys': at('v1.5.0') }, show: true }, [copy('kehikot.journeys', 'Journeys', 'v1.6.0')])
    await render(<Host />)
    await openFromNotice()
    await until(() => document.activeElement?.getAttribute('data-testid') === 'whats-new-got-it')
    expect(document.activeElement?.textContent).toBe('Got it')
    const list = document.querySelector('[data-whats-new] [role="tablist"]')!
    expect(list.getAttribute('aria-label')).toBe('What changed')
    expect(list.getAttribute('aria-orientation')).toBe('vertical')
    /* A long list of updated modules scrolls inside the side column instead of running past the dialog. */
    expect(list.className).toContain('sm:overflow-y-auto')
    expect(list.className).toContain('sm:min-h-0')
    expect(list.closest('aside')!.className).toContain('sm:min-h-0')
    const first = list.querySelector('[role="tab"]') as HTMLElement
    first.focus()
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await tick()
    expect(document.activeElement?.getAttribute('data-item')).toBe('kehikot.journeys')
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await until(() => dialog() === null)
    await until(() => host.posts.some((one) => 'acknowledge' in one))
    expect(host.record).toMatchObject({ app: '0.1.43', modules: { 'kehikot.journeys': at('v1.6.0') } })
  })

  test('narrow: the list is a strip on top that scrolls sideways, and a column beside the notes from 640 pixels', async () => {
    start({ app: '0.1.41', modules: {}, show: true }, [])
    await render(<Host />)
    await openFromNotice()
    const tabs = dialog()!.querySelector('[data-slot="tabs"]')!
    const list = dialog()!.querySelector('[role="tablist"]')!
    const aside = dialog()!.querySelector('aside')!
    /* Tailwind's `sm:` is 640px: under it a column of strip-over-notes, over it side by side. */
    expect(tabs.className).toContain('flex-col')
    expect(tabs.className).toContain('sm:flex-row')
    expect(list.className).toContain('overflow-x-auto')
    expect(list.className).toContain('sm:flex-col')
    expect(aside.className).toContain('border-b')
    expect(aside.className).toContain('sm:w-60')
    expect(dialog()!.className).toContain('max-w-[calc(100%-2rem)]')
  })
})
