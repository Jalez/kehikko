import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import { manifestSchema } from 'kehikot-module-protocol'

import { helpFor, helpTitle } from '../src/host/moduleHelp.ts'
import type { Presence, RegistryView } from '../src/host/registry.ts'

/*
 * A module's "How to use" (protocol 2.52.0): offered only for a module whose manifest says how, drawn
 * by the host as a dialog of headings and bullet lists, every string as text. The Container menu's row at
 * every width and fold is in `header-offer-dom.test.tsx`.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix decides at load whether
 * it has a DOM.
 */

const inChild = process.env.MODULE_HELP_DOM === '1'
const TESTS = 5

const HELP = {
  summary: 'Shows one list for the picked thing.',
  sections: [
    { title: 'What it shows', points: ['The list for the picked container.', '<b>not bold</b> and [not](https://a.link)'] },
    { title: 'Who changes it', points: ['You do.'] },
  ],
}

describe('which modules have one', () => {
  test('a manifest with help has one; without, malformed, or empty, none', () => {
    expect(helpFor({ help: HELP })).toEqual(HELP)
    expect(helpFor({})).toBeNull()
    expect(helpFor(null)).toBeNull()
    expect(helpFor({ help: { sections: [] } })).toBeNull()
    expect(helpFor({ help: 'Read the docs.' })).toBeNull()
  })

  test('the title is one fixed phrase around the module’s registered name', () => {
    expect(helpTitle('Anything')).toBe('How to use Anything')
  })
})

if (!inChild) {
  test('the help dialog and the modules list, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MODULE_HELP_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS + 2} pass`))
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Help: typeof import('../src/canvas/ModuleHelp.tsx')
let Lists: typeof import('../src/canvas/Modules.tsx')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  Help = await import('../src/canvas/ModuleHelp.tsx')
  Lists = await import('../src/canvas/Modules.tsx')
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

async function render(node: import('react').ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  unmount = () => root.unmount()
}

function Opened({ onClosed }: { onClosed(): void }) {
  const [open, setOpen] = React.useState(true)
  return (
    <>
      <button data-before="">before</button>
      <Help.ModuleHelpDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) onClosed()
        }}
        name="Lists"
        help={helpFor({ help: HELP })!}
      />
    </>
  )
}

describe('the dialog', () => {
  if (!inChild) return

  test('"About <name>" for a module with no how-to: its summary, what it tells agents, the list’s words and tags, and the missing how-to', async () => {
    const was = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      if (String(url).startsWith('/host/official')) {
        return new Response(
          JSON.stringify({ modules: [{ id: 'kehikot.lists', name: 'Lists', repo: 'o/lists', summary: 'Lists, kept per epic.', tags: ['planning'], installed: true }] }),
        )
      }
      return new Response(JSON.stringify({ modules: [], adoptable: [] }))
    }) as typeof fetch
    try {
      await render(<Help.ModuleAboutDialog open onOpenChange={() => {}} id="kehikot.lists" name="Lists" summary="Shows lists." says="Use it to keep a list." />)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
      expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent).toBe('About Lists')
      expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe('Shows lists.')
      expect([...dialog.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['What it does', 'Filed under', 'How to use'])
      expect(dialog.textContent).toContain('Use it to keep a list.')
      expect(dialog.textContent).toContain('Lists, kept per epic.')
      expect(dialog.textContent).toContain('planning')
      expect(dialog.textContent).toContain("This module hasn't written a how-to yet.")
    } finally {
      globalThis.fetch = was
    }
  })

  test('is a labelled dialog: the title, the summary, a heading per section and a bullet per point', async () => {
    await render(<Opened onClosed={() => {}} />)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.hasAttribute('data-module-help')).toBe(true)
    const labelledBy = dialog.getAttribute('aria-labelledby')!
    expect(document.getElementById(labelledBy)!.textContent).toBe('How to use Lists')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe(HELP.summary)
    expect([...dialog.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['What it shows', 'Who changes it'])
    const lists = [...dialog.querySelectorAll('ul')]
    expect(lists.map((ul) => [...ul.querySelectorAll('li')].map((li) => li.textContent))).toEqual(HELP.sections.map((s) => s.points))
    /* Fits a narrow window: never wider or taller than it, scrolling inside. */
    expect(dialog.className).toContain('w-[calc(100vw-2rem)]')
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
  })

  test('a module’s words are text: no element, no link, nothing opened', async () => {
    await render(<Opened onClosed={() => {}} />)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelector('b')).toBeNull()
    expect(dialog.querySelector('a')).toBeNull()
    expect(dialog.textContent).toContain('<b>not bold</b> and [not](https://a.link)')
  })

  test('Escape closes it', async () => {
    let closed = false
    await render(<Opened onClosed={() => (closed = true)} />)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closed).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('the modules list', () => {
  if (!inChild) return

  test('a "?" on every row (protocol 2.57.0: it opens the introduction, or How to use, or the summary); it opens that module’s', async () => {
    const presence = (id: string, name: string, module: object): Presence =>
      ({ id, name, at: 'http://127.0.0.1:7870', condition: 'ready', reached: true, line: '', module: manifestSchema.parse({ kind: 'kehikot.module', protocol: 2, entry: '/', partless: 'x', id, name, modes: [{ id: 'main', label: 'Main' }], ...module }) }) as unknown as Presence
    const registry: RegistryView = {
      presences: [presence('kehikot.lists', 'Lists', { help: HELP }), presence('kehikot.plain', 'Plain', {})],
      sweep: { dir: '/tmp/modules', rejected: [] },
      protocol: 2,
    }
    const asked: string[] = []
    await render(
      <Lists.ModuleList registry={registry} onCanvas={new Set()} onPlace={() => {}} onUnplace={() => {}} onIntro={(id) => asked.push(id)} />,
    )
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-module-help-button]')]
    expect(buttons.map((one) => one.getAttribute('aria-label'))).toEqual(['What Lists is', 'What Plain is'])
    await act(async () => buttons[0]!.click())
    expect(asked).toEqual(['kehikot.lists'])
  })
})
