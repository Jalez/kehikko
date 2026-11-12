import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/*
 * Every host window is drawn on one layout (`src/components/ui/modal.tsx`): a header row
 * with the title and the close button, a body that is the only thing that scrolls, and an
 * optional footer. A test DOM has no layout, so what is checked is the structure and the
 * classes that make it: the close is in the header and not in the body, nothing outside
 * the body scrolls, the window is capped to the viewport and fits a narrow one, and Escape
 * closes it.
 *
 * In a process of its own, for the reason `header-menus.test.tsx` gives: Radix decides at
 * load whether it has a DOM.
 */

const inChild = process.env.MODAL_LAYOUT_DOM === '1'
const CANVAS = join(import.meta.dir, '..', 'src', 'canvas')

test('no window draws the bare dialog: every one is on the shared layout', () => {
  const bare = readdirSync(CANVAS)
    .filter((name) => name.endsWith('.tsx'))
    .filter((name) => /<DialogContent\b|<DialogHeader\b/.test(readFileSync(join(CANVAS, name), 'utf8')))
  expect(bare).toEqual([])
})

const CASES = [
  'Settings',
  'What’s new',
  'Tools',
  'Skills',
  'Storage',
  'kehikko skills',
  'How to use',
  'Feedback',
  'Prompts',
  'Add a project',
  'Address offer',
  'Layout picker',
  'Save layout',
  'Picking a project',
  'Module settings',
  'Release notes',
  'Several release notes',
  'Moved notes',
  'Introduction',
  'A module’s introduction',
] as const

if (!inChild) {
  test('every window, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MODAL_LAYOUT_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${CASES.length * 2 + 2} pass`))
    expect(out).toMatch(/\b0 fail/)
  }, 120_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
type Render = (closed: () => void) => import('react').ReactNode
let windows: Record<(typeof CASES)[number], Render>
const realFetch = globalThis.fetch

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  /* Nothing here answers: every window is drawn while it is still asking. */
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  const Settings = await import('../src/canvas/Settings.tsx')
  const { WhatsNewDialog } = await import('../src/canvas/WhatsNew.tsx')
  const { ToolsDialog } = await import('../src/canvas/Tools.tsx')
  const { SkillsDialog } = await import('../src/canvas/Skills.tsx')
  const { Storage } = await import('../src/canvas/Storage.tsx')
  const { KehikkoSkillsDialog } = await import('../src/canvas/KehikkoSkills.tsx')
  const { ModuleHelpDialog } = await import('../src/canvas/ModuleHelp.tsx')
  const { FeedbackDialog } = await import('../src/canvas/Feedback.tsx')
  const { Prompts } = await import('../src/canvas/Prompts.tsx')
  const { Browser } = await import('../src/canvas/Projects.tsx')
  const { AddressOffer } = await import('../src/canvas/AddressOffer.tsx')
  const { LayoutPicker, SaveLayoutDialog } = await import('../src/canvas/Layouts.tsx')
  const { Picking } = await import('../src/canvas/Picking.tsx')
  const { ModuleSettingsDialog } = await import('../src/canvas/ModuleSettings.tsx')
  const Notes = await import('../src/canvas/ReleaseNotes.tsx')
  const { IntroDialog } = await import('../src/canvas/Intro.tsx')
  const { ModuleIntroDialog } = await import('../src/canvas/ModuleIntro.tsx')
  const { introFor } = await import('../src/host/moduleIntro.ts')

  const never = <T,>() => new Promise<T>(() => {})
  /* A window kept open by its own state, so Escape can be seen to close it. */
  function Held({ draw, closed }: { draw(open: boolean, close: () => void): import('react').ReactNode; closed(): void }) {
    const [open, setOpen] = React.useState(true)
    return (
      <>
        {draw(open, () => {
          setOpen(false)
          closed()
        })}
      </>
    )
  }
  const held = (draw: (open: boolean, close: () => void) => import('react').ReactNode): Render => (closed) => <Held draw={draw} closed={closed} />
  const onChange = (close: () => void) => (next: boolean) => (next ? undefined : close())

  windows = {
    Settings: held((open, close) => <Settings.SettingsDialog open={open} onOpenChange={onChange(close)} load={never} section="about" />),
    'What’s new': held((open, close) => (
      <WhatsNewDialog
        open={open}
        show
        onClose={close}
        load={never}
        items={[
          {
            id: 'kehikot',
            kind: 'note',
            name: 'Kehikot',
            repo: null,
            from: null,
            to: '0.1.0',
            tags: [],
            follows: 'note',
            works: {},
            ack: { note: 'x' },
            news: true,
            preparing: false,
          },
        ]}
      />
    )),
    Tools: held((open, close) => <ToolsDialog open={open} onOpenChange={onChange(close)} module="kehikot.any" name="Any" onChanged={() => {}} />),
    Skills: held((open, close) => <SkillsDialog open={open} onOpenChange={onChange(close)} module="kehikot.any" name="Any" />),
    Storage: held((open, close) => <Storage open={open} onOpenChange={onChange(close)} load={never} />),
    'kehikko skills': held((open, close) => (
      <KehikkoSkillsDialog open={open} onOpenChange={onChange(close)} kehikko={{ id: 1, name: 'Writing' }} load={never} save={never} remove={never} />
    )),
    'How to use': held((open, close) => (
      <ModuleHelpDialog open={open} onOpenChange={onChange(close)} name="Any" help={{ summary: 'One list.', sections: [{ title: 'What', points: ['A point.'] }] }} />
    )),
    Feedback: held((open, close) => (
      <FeedbackDialog
        module="kehikot.any"
        name="Any"
        kehikko={null}
        epic={null}
        feedback={{
          listing: null,
          line: null,
          loading: false,
          slow: false,
          cancel() {},
          stopped: false,
          retry() {},
          opened() {},
          writing: open,
          write: (on: boolean) => (on ? undefined : close()),
          sent() {},
        }}
      />
    )),
    Prompts: held((open, close) => {
      const container = { i: 'kehikot.any', x: 0, y: 0, w: 4, h: 4, prompt: '', promptFor: null } as never
      return <Prompts open={open} onOpenChange={onChange(close)} container={container} presences={[]} placements={[container]} onWrite={() => {}} />
    }),
    'Add a project': held((open, close) => <Browser open={open} onOpenChange={onChange(close)} start={null} onPick={() => {}} />),
    'Address offer': held((open, close) => (
      <AddressOffer
        offer={open ? { kehikko: 1, url: 'https://example.com/', by: 'kehikot.any', at: 'kehikot.any' } : null}
        askerName="Any"
        addable={[{ id: 'kehikot.pages', name: 'Pages' }]}
        onOpenOutside={() => {}}
        onAdd={() => {}}
        onDismiss={close}
      />
    )),
    'Layout picker': held((open, close) => (
      <LayoutPicker open={open} onOpenChange={onChange(close)} mode="new" project={null} registered={new Map()} onUse={async () => null} load={never} loadOfficial={never} />
    )),
    'Save layout': held((open, close) => (
      <SaveLayoutDialog open={open} onOpenChange={onChange(close)} kehikko={{ id: 1, name: 'Writing', placements: [{ i: 'kehikot.any', x: 0, y: 0, w: 4, h: 4, wish: 4 }] }} save={never} />
    )),
    'Picking a project': held((open, close) => (
      <Picking projects={[{ id: 1, name: 'thesis', path: '/p/thesis' } as never]} asking={open ? 'Any' : null} onPick={() => {}} onCancel={close} />
    )),
    'Module settings': held((open, close) => (
      <ModuleSettingsDialog open={open} onOpenChange={onChange(close)} module="kehikot.any" name="Any" project={null} api={{ list: never, read: never, set: never, file: never }} />
    )),
    'Release notes': held((open, close) => (
      <Notes.ReleaseNotesDialog open={open} onOpenChange={onChange(close)} repo="owner/any" tag="v1.0.0" name="Any" version="1.0.0" load={never} />
    )),
    'Several release notes': held((open, close) => (
      <Notes.ModuleNotesDialog open={open} onOpenChange={onChange(close)} repo="owner/any" name="Any" tags={['v1.1.0', 'v1.0.0']} load={never} />
    )),
    'Moved notes': held((open, close) => (
      <Notes.MovedNotesDialog open={open} onOpenChange={onChange(close)} repo="owner/any" name="Any" from="v1.0.0" to="v1.1.0" load={never} list={never} />
    )),
    Introduction: held((open, close) => <IntroDialog open={open} onOpenChange={onChange(close)} onTour={() => {}} onExplore={() => {}} />),
    'A module’s introduction': held((open, close) => (
      <ModuleIntroDialog
        open={open}
        onOpenChange={onChange(close)}
        id="kehikot.any"
        name="Any"
        intro={introFor({ intro: { slides: [{ title: 'One list', body: 'Everything still to do.' }, { title: 'Then', body: 'More.' }] } })}
      />
    )),
  }
})

afterAll(async () => {
  if (!inChild) return
  globalThis.fetch = realFetch
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
  /* Let a window that reads something first draw what it read. */
  await act(async () => new Promise((done) => setTimeout(done, 10)))
  unmount = () => root.unmount()
}

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/)
/** Scrolls up and down, at some width: `overflow-auto`, `overflow-y-auto`, or `sm:overflow-y-scroll`. */
const scrolls = (el: Element) =>
  el.hasAttribute('data-modal-scroll') ||
  el.getAttribute('data-slot') === 'scroll-area-viewport' ||
  classes(el).some((one) => /^(\w+:)?overflow(-y)?-(auto|scroll)$/.test(one))

describe('every window', () => {
  if (!inChild) return

  for (const name of CASES) {
    test(`${name}: the close is in the header row, the body is what scrolls, it fits a short and narrow window`, async () => {
      await render(windows[name](() => {}))
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
      expect(dialog).not.toBeNull()
      const header = dialog!.querySelector('[data-modal-header]')!
      const body = dialog!.querySelector('[data-modal-body]')!
      const footer = dialog!.querySelector('[data-modal-footer]')
      expect(header).not.toBeNull()
      expect(body).not.toBeNull()

      /* The close: one, a button, in the header, never in what scrolls. */
      const closes = dialog!.querySelectorAll('[data-modal-close]')
      expect(closes).toHaveLength(1)
      const close = closes[0]!
      expect(close.tagName).toBe('BUTTON')
      expect(header.contains(close)).toBe(true)
      expect(body.contains(close)).toBe(false)
      expect(body.contains(header)).toBe(false)
      expect(classes(close)).not.toContain('full path')
      /* First in tab order: nothing focusable comes before it. */
      const tabbable = [...dialog!.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      expect(tabbable[0]).toBe(close as HTMLElement)

      /* The header comes first; a footer, when there is one, last, and neither inside the body. */
      expect(header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      if (footer) {
        expect(body.contains(footer)).toBe(false)
        expect(body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      }

      /* The title the dialog is labelled by is in the header; the introduction's is each
         slide's own, under its picture, and its header row says where in the slides you are. */
      const title = document.getElementById(dialog!.getAttribute('aria-labelledby') ?? '')
      /* A module's introduction is named by `aria-label`, "Introduction to …", instead. */
      if (!dialog!.hasAttribute('aria-label')) expect(title).not.toBeNull()
      if (title) expect(header.contains(title)).toBe(!name.includes('ntroduction'))

      /* Only the body scrolls: not the window, not the header, not the footer. */
      expect(scrolls(dialog!)).toBe(false)
      expect(classes(dialog!)).toContain('overflow-hidden')
      expect([header, ...header.querySelectorAll('*')].some(scrolls)).toBe(false)
      if (footer) expect([footer, ...footer.querySelectorAll('*')].some(scrolls)).toBe(false)
      for (const one of dialog!.querySelectorAll('*')) if (scrolls(one)) expect(body === one || body.contains(one)).toBe(true)
      /* Either the body scrolls, or it holds the regions that do (a list beside a pane). */
      expect(classes(body)).toContain('min-h-0')
      expect(classes(body)).toContain('flex-1')
      const own = scrolls(body)
      expect(own || [...body.querySelectorAll('*')].some(scrolls)).toBe(true)
      if (!own) expect(classes(body)).toContain('overflow-hidden')

      /* A short window: never taller than the viewport, header and footer never squeezed. */
      expect(classes(dialog!).some((one) => /^max-h-\[.*100dvh/.test(one))).toBe(true)
      expect(classes(dialog!)).toContain('flex-col')
      expect(classes(header)).toContain('shrink-0')
      if (footer) expect(classes(footer)).toContain('shrink-0')
      /* A narrow window: never wider than it. */
      expect(classes(dialog!).some((one) => one === 'max-w-[calc(100%-2rem)]' || one === 'w-[calc(100vw-2rem)]')).toBe(true)
      expect(classes(dialog!).some((one) => /^(max-)?w-(\d|\[\d)/.test(one))).toBe(false)
    })

    test(`${name}: Escape closes it`, async () => {
      let closed = 0
      await render(windows[name](() => (closed += 1)))
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
      await act(async () => {
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(closed).toBe(1)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
  }
})

describe('the layout picker with many layouts', () => {
  if (!inChild) return

  test('the list scrolls in the body; the footer holds Create and Cancel and is never inside it', async () => {
    const { LayoutPicker } = await import('../src/canvas/Layouts.tsx')
    const many = Array.from({ length: 40 }, (_, n) => ({
      id: `layout-${n}`,
      from: 'mine' as const,
      name: `Layout ${n}`,
      summary: 'A layout.',
      containers: [{ module: 'kehikot.any', x: 0, y: 0, w: 4, h: 4 }],
    }))
    const load = async () => ({ builtIn: [], project: [], mine: many, trouble: [] })
    await render(
      <LayoutPicker open onOpenChange={() => {}} mode="new" project={null} registered={new Map()} onUse={async () => null} load={load} loadOfficial={() => new Promise(() => {})} />,
    )
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const body = dialog.querySelector('[data-modal-body]')!
    const footer = dialog.querySelector('[data-modal-footer]')!
    expect(body.querySelectorAll('[data-layout-scroll] section').length).toBeGreaterThan(0)
    expect(body.querySelectorAll('[data-layout-card], button').length).toBeGreaterThan(40)
    expect(classes(body)).toContain('overflow-y-auto')
    expect(classes(body)).toContain('min-h-0')
    expect(classes(footer)).toContain('shrink-0')
    expect(body.contains(footer)).toBe(false)
    expect(footer.querySelector('[data-layout-create]')).not.toBeNull()
    expect(footer.textContent).toContain('Cancel')
    expect([footer, ...footer.querySelectorAll('*')].some(scrolls)).toBe(false)
  })
})
