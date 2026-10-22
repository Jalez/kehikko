import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The release-notes button and dialog, in a DOM: a press shows the notes
 * without choosing the row, the dialog reads and fails inside itself, "Open on
 * GitHub" opens the release page outside, and Escape puts focus back on the
 * button. In a process of its own for the reason `updates-panel.test.tsx`
 * gives: Radix decides at load whether it has a DOM.
 */

const inChild = process.env.RELEASE_NOTES_DOM === '1'

if (!inChild) {
  test('the release-notes dialog, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, RELEASE_NOTES_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(/\b9 pass/)
  }, 60_000)
}

let answer: (url: string) => Response | Promise<Response>
const opened: string[] = []

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let VersionPicker: typeof import('../src/canvas/Versions.tsx').VersionPicker
let AppVersion: typeof import('../src/canvas/AppVersion.tsx').AppVersion

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (url: string) => answer(String(url))) as typeof fetch
  window.open = ((url: string) => {
    opened.push(url)
    return null
  }) as typeof window.open
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  ;({ VersionPicker } = await import('../src/canvas/Versions.tsx'))
  ;({ AppVersion } = await import('../src/canvas/AppVersion.tsx'))
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
  opened.length = 0
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const listing = {
  module: 'kehikot.notes',
  name: 'Notes',
  latest: { version: '2.1.0', commit: 'abc1234', dataVersion: 2, release: 'v2.1.0' },
  repo: 'Jalez/kehikko-notes',
  pinned: null,
  recorded: 2,
  versions: [
    { tag: 'v2.1.0', compatible: true, incompatible: null, dataVersion: 2, blocked: null, prepared: true, running: true, release: true },
    { tag: 'v2.0.0', compatible: true, incompatible: null, dataVersion: 2, blocked: null, prepared: false, running: false, release: true },
  ],
  hint: null,
  error: null,
}

const notes = (tag: string) => ({
  repo: 'Jalez/kehikko-notes',
  tag,
  name: `Notes ${tag}`,
  body: `### What's new\n- **Faster** search\n\n<script>window.hacked = true</script>`,
  url: `https://github.com/Jalez/kehikko-notes/releases/tag/${tag}`,
  publishedAt: '2026-10-19T11:35:41Z',
  prerelease: false,
})

const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 10)))

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
  await settle()
  return host
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    ;(element as HTMLElement).focus?.()
    ;(element as HTMLElement).click()
  })
  await settle()
}

async function escape() {
  await act(async () => {
    const target = document.activeElement ?? document.body
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle()
}

const dialog = () => document.querySelector('[data-testid="release-notes"]')
const picker = () => document.querySelector('[data-slot="popover-content"]')

describe.skipIf(!inChild)('a module’s version picker', () => {
  test('the notes button shows that version’s notes without pinning it, and Escape gives focus back', async () => {
    const asked: string[] = []
    answer = (url) => {
      asked.push(url)
      if (url.startsWith('/host/versions')) return json(listing)
      if (url.startsWith('/host/release-notes')) return json(notes('v2.0.0'))
      return json({})
    }
    let picked = 0
    await render(
      <VersionPicker module="kehikot.notes" name="Notes" kehikko={1} pinned={null} current="2.1.0" onPicked={() => picked++} />,
    )
    await click(document.querySelector('[data-testid="version-control"]')!)
    expect(picker()).not.toBeNull()

    const button = document.querySelector('[aria-label="Show release notes for v2.0.0"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    await click(button)

    /* Nothing was chosen: no POST, nothing picked. */
    expect(asked.filter((u) => u === '/host/versions')).toEqual([])
    expect(picked).toBe(0)
    expect(asked).toContain('/host/release-notes?repo=Jalez%2Fkehikko-notes&tag=v2.0.0')

    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain("What's new in Notes v2.0.0")
    expect(dialog()!.textContent).toContain('Faster')
    /* The script in the notes is text. */
    expect(dialog()!.querySelector('script')).toBeNull()
    expect((window as { hacked?: boolean }).hacked).toBeUndefined()
    /* The picker stays open behind it. */
    expect(picker()).not.toBeNull()

    await escape()
    expect(dialog()).toBeNull()
    expect(picker()).not.toBeNull()
    expect(document.activeElement).toBe(button)
    /* Handed back quietly: its tooltip is not raised. */
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })

  test('an app release shows only its What’s new section, not the install steps or the footer', async () => {
    const body = [
      "### What's new",
      '- **Faster** search',
      '',
      '### Install',
      '**Download** `Kehikot_0.1.25.dmg` for Macs.',
      '',
      '<sub>Built from [Jalez/kehikko@abc1234](https://github.com/Jalez/kehikko/commit/abc1234)</sub>',
    ].join('\n')
    answer = (url) => (url.startsWith('/host/versions') ? json(listing) : json({ ...notes('v2.1.0'), body }))
    await render(<VersionPicker module="kehikot.notes" name="Notes" kehikko={1} pinned={null} current="2.1.0" onPicked={() => {}} />)
    await click(document.querySelector('[data-testid="version-control"]')!)
    await click(document.querySelectorAll('[aria-label="Show release notes for v2.1.0"]')[1]!)
    const text = document.querySelector('[data-testid="release-notes-body"]')!.textContent!
    expect(text).toContain('Faster')
    expect(text).not.toContain('Install')
    expect(text).not.toContain('Download')
    expect(text).not.toContain('Built from')
    /* The title already says it; the section's own heading is not repeated. */
    expect(text).not.toContain("What's new")
    expect(document.querySelector('[data-testid="release-notes-github"]')).not.toBeNull()
  })

  test('Open on GitHub opens the release page outside', async () => {
    answer = (url) => (url.startsWith('/host/versions') ? json(listing) : json(notes('v2.1.0')))
    await render(<VersionPicker module="kehikot.notes" name="Notes" kehikko={1} pinned={null} current="2.1.0" onPicked={() => {}} />)
    await click(document.querySelector('[data-testid="version-control"]')!)
    await click(document.querySelectorAll('[aria-label="Show release notes for v2.1.0"]')[1]!)
    const github = document.querySelector('[data-testid="release-notes-github"]')!
    expect(github.textContent).toContain('Open on GitHub')
    await click(github)
    expect(opened).toEqual(['https://github.com/Jalez/kehikko-notes/releases/tag/v2.1.0'])
  })

  test('notes that cannot be read say so in the dialog, and still open on GitHub', async () => {
    answer = (url) =>
      url.startsWith('/host/versions')
        ? json(listing)
        : json({ error: 'GitHub could not be reached — this computer may be offline.', url: 'https://github.com/Jalez/kehikko-notes/releases/tag/v2.0.0' }, 502)
    await render(<VersionPicker module="kehikot.notes" name="Notes" kehikko={1} pinned={null} current="2.1.0" onPicked={() => {}} />)
    await click(document.querySelector('[data-testid="version-control"]')!)
    await click(document.querySelector('[aria-label="Show release notes for v2.0.0"]')!)
    const trouble = document.querySelector('[data-testid="release-notes-trouble"]')
    expect(trouble?.textContent).toContain("Couldn't load the release notes — open on GitHub.")
    expect(trouble?.textContent).toContain('offline')
    await click(document.querySelector('[data-testid="release-notes-github"]')!)
    expect(opened).toEqual(['https://github.com/Jalez/kehikko-notes/releases/tag/v2.0.0'])
  })
})

describe.skipIf(!inChild)('the version beside Kehikot', () => {
  const releases = ['v0.1.25', 'v0.1.24', 'v0.1.23'].map((tag) => ({
    repo: 'Jalez/kehikko-desktop',
    tag,
    name: `Kehikot ${tag}`,
    url: `https://github.com/Jalez/kehikko-desktop/releases/tag/${tag}`,
    publishedAt: '2026-10-19T11:35:41Z',
    prerelease: false,
  }))

  test('inside the app: the app’s version, and a press lists the releases with the installed and the coming one marked', async () => {
    ;(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: async () => ({ enabled: true, current: '0.1.24', state: 'ready', version: '0.1.25', progress: null, error: null, checkedAt: 1 }),
    }
    const asked: string[] = []
    answer = (url) => {
      asked.push(url)
      if (url === '/host/health') return json({ ok: true, version: '0.1.0' })
      if (url.startsWith('/host/releases')) return json({ repo: 'Jalez/kehikko-desktop', releases })
      return json({ ...notes('v0.1.25'), repo: 'Jalez/kehikko-desktop', name: 'Kehikot v0.1.25' })
    }
    await render(<AppVersion />)
    const label = document.querySelector('[data-testid="app-version"]')!
    expect(label.textContent).toBe('0.1.24')
    expect(label.getAttribute('data-kind')).toBe('app')
    await click(label)
    expect(asked).toContain('/host/releases?repo=Jalez%2Fkehikko-desktop')
    const rows = [...document.querySelectorAll('[data-release]')]
    expect(rows.map((r) => [r.getAttribute('data-release'), r.getAttribute('data-mark')])).toEqual([
      ['v0.1.25', 'ready'],
      ['v0.1.24', 'installed'],
      ['v0.1.23', null],
    ])
    const button = document.querySelector('[aria-label="Show release notes for 0.1.25"]') as HTMLButtonElement
    await click(button)
    expect(dialog()!.textContent).toContain("What's new in Kehikot 0.1.25")
    expect(asked).toContain('/host/release-notes?repo=Jalez%2Fkehikko-desktop&tag=v0.1.25')
    await escape()
    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  test('in a browser: the host’s version, said as the host’s', async () => {
    answer = (url) => (url === '/host/health' ? json({ ok: true, version: '0.1.0' }) : json({ releases: [] }))
    await render(<AppVersion />)
    const label = document.querySelector('[data-testid="app-version"]')!
    expect(label.textContent).toBe('host 0.1.0')
    expect(label.getAttribute('data-kind')).toBe('host')
  })
  const sentence = "Couldn't read Kehikot's releases from GitHub (GitHub answered 404 (not found)); try again in a moment."
  const open = async () => {
    await render(<AppVersion />)
    await click(document.querySelector('[data-testid="app-version"]')!)
  }

  test('a list that could not be read says so with a Retry, never "No releases are published yet", and Retry reads it again', async () => {
    let fails = true
    answer = (url) => {
      if (url === '/host/health') return json({ ok: true, version: '0.1.0' })
      if (fails) return json({ error: sentence, url: 'https://github.com/Jalez/kehikko-desktop/releases' }, 502)
      return json({ repo: 'Jalez/kehikko-desktop', releases: [{ repo: 'Jalez/kehikko-desktop', tag: 'v0.1.2', name: null, url: 'https://github.com/x', publishedAt: null, prerelease: false }] })
    }
    await open()
    const trouble = document.querySelector('[data-testid="app-releases-trouble"]')!
    expect(trouble.textContent).toContain(sentence)
    expect(document.body.textContent).not.toContain('No releases are published yet')
    fails = false
    await click([...trouble.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!)
    expect(document.querySelector('[data-release="v0.1.2"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="app-releases-trouble"]')).toBeNull()
  })

  test('the last good list is shown with why it is old, and a Retry', async () => {
    answer = (url) =>
      url === '/host/health'
        ? json({ ok: true, version: '0.1.0' })
        : json({
            repo: 'Jalez/kehikko-desktop',
            old: sentence,
            releases: [{ repo: 'Jalez/kehikko-desktop', tag: 'v0.1.2', name: null, url: 'https://github.com/x', publishedAt: null, prerelease: false }],
          })
    await open()
    expect(document.querySelector('[data-testid="app-releases-old"]')!.textContent).toContain(sentence)
    expect(document.querySelector('[data-release="v0.1.2"]')).not.toBeNull()
  })

  test('only an empty 200 says none are published', async () => {
    answer = (url) => (url === '/host/health' ? json({ ok: true, version: '0.1.0' }) : json({ repo: 'Jalez/kehikko-desktop', releases: [] }))
    await open()
    expect(document.body.textContent).toContain('No releases are published yet.')
  })
})
