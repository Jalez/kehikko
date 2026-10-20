import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'

/*
 * An Inbox item pressed in the panel goes to where it happened: the panel's
 * row, `useGoToPlace` and `planGo`, wired as `App.tsx` wires them, with the
 * epic held where the epic picker's state is.
 *
 * In a process of its own for the reason `parts-pressed.test.tsx` gives:
 * Radix decides at module load whether it has a DOM.
 */

const inChild = process.env.GO_TO_PLACE_DOM === '1'

if (!inChild) {
  test('an Inbox item, pressed, in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, GO_TO_PLACE_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(/\b2 pass/)
  }, 60_000)
}

type Entry = import('../src/host/inbox.ts').Entry
type InboxView = import('../src/canvas/Inbox.tsx').InboxView

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let InboxPanel: typeof import('../src/canvas/Inbox.tsx').InboxPanel
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let useGoToPlace: typeof import('../src/canvas/useGoToPlace.ts').useGoToPlace
let WentTo: typeof import('../src/canvas/WentTo.tsx').WentTo
let tally: typeof import('../src/host/inbox.ts').tally

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ InboxPanel } = await import('../src/canvas/Inbox.tsx'))
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  ;({ useGoToPlace } = await import('../src/canvas/useGoToPlace.ts'))
  ;({ WentTo } = await import('../src/canvas/WentTo.tsx'))
  ;({ tally } = await import('../src/host/inbox.ts'))
})

afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const entry = (id: string, more: Partial<Entry> = {}): Entry => ({
  module: 'kehikot.claude',
  name: 'Claude',
  id,
  state: 'attention',
  label: id,
  priority: 'normal',
  refs: [],
  entered: Date.now() - 60_000,
  opened: Date.now() - 60_000,
  closed: null,
  how: null,
  seen: null,
  dismissed: null,
  origin: 'activity',
  ...more,
})

/** The panel with one item, pressed. What the page would have done is recorded. */
async function press(item: Entry) {
  const lit: string[] = []
  const epics: string[] = []
  const KEHIKOT = [{ key: 'k1', name: 'Design', modules: ['kehikot.claude'] }]
  function Wired() {
    const [epic, setEpic] = React.useState('thesis')
    React.useEffect(() => {
      epics.push(epic)
    }, [epic])
    const placeGo = useGoToPlace({
      here: { project: 1, epic, parts: [], kehikko: 'k1' },
      targetOf: (project) => ({ project, kehikot: KEHIKOT, epics: ['thesis', 'kiosk'] }),
      switchProject: () => {},
      openKehikko: () => {},
      goto: (call) => {
        setEpic(call.epic)
        return { outcome: 'moved', why: '' }
      },
      highlight: (module) => lit.push(module),
    })
    const at = { epic, kehikko: 'k1' }
    const view: InboxView = {
      entries: [item],
      earlierCount: 0,
      at,
      scope: 'everywhere',
      onScope: () => {},
      names: { epic: () => null, part: () => null, kehikko: () => null },
      tally: tally([item], at),
      next: null,
      open: true,
      onOpenChange: () => {},
      onGo: (one) => placeGo.go(one, 1),
      onNext: () => {},
      onSee: () => {},
      onDismiss: () => {},
      onForget: () => {},
      onSeeAll: () => {},
      loadLog: async () => ({ rows: [], more: false, total: 0 }),
      rev: 1,
      shortcut: 'Alt+Shift+N',
      now: () => Date.now(),
    }
    return (
      <TooltipProvider>
        <InboxPanel view={view} />
        <WentTo note={placeGo.note} onClose={placeGo.clearNote} />
      </TooltipProvider>
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<Wired />))
  const button = [...host.querySelectorAll('button')].find((one) => one.textContent?.includes(item.label))
  if (!button) throw new Error(`no row for ${item.label}`)
  await act(async () => button.click())
  const status = host.querySelector('[data-went-to]')?.textContent ?? null
  await act(async () => root.unmount())
  host.remove()
  return { lit, epics, status }
}

if (inChild) {
  test('an item of another epic, pressed, changes the epic and lights its container', async () => {
    const got = await press(entry('reel', { label: 'Kiosk reel', place: { epic: 'kiosk', kehikko: 'k1' } }))
    expect(got.epics).toEqual(['thesis', 'kiosk'])
    expect(got.lit).toEqual(['kehikot.claude'])
    expect(got.status).toBeNull()
  })

  test('an item with no place lights the module as before, and says it named no place', async () => {
    const got = await press(entry('loose', { label: 'A loose session' }))
    expect(got.epics).toEqual(['thesis'])
    expect(got.lit).toEqual(['kehikot.claude'])
    expect(got.status).toContain('did not say where it came from')
  })
}
