import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

/*
 * Kehikko settings and the primary-agent question, rendered: the cubes (one picked at a time, by
 * pointer and by keyboard), Confirm selection held until one is picked, Later, the window's tabs and
 * deep links, and the kehikko menu's gear on every row in place of the pencil. In a process of its
 * own for the reason `header-menus.test.tsx` gives (Radix decides at load whether it has a DOM).
 */

const inChild = process.env.KEHIKKO_SETTINGS_DOM === '1'
const TESTS = 8

if (!inChild) {
  test('kehikko settings, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, KEHIKKO_SETTINGS_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(new RegExp(`\\b${TESTS} pass`))
  }, 60_000)
}

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let UI: typeof import('../src/canvas/KehikkoSettings.tsx')
let Canvases: typeof import('../src/canvas/Canvases.tsx').Canvases
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let links: typeof import('../src/host/kehikkoSettings.ts')

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  UI = await import('../src/canvas/KehikkoSettings.tsx')
  ;({ Canvases } = await import('../src/canvas/Canvases.tsx'))
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  links = await import('../src/host/kehikkoSettings.ts')
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

async function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
  await act(async () => {})
  unmount = () => root.unmount()
}

const AGENTS = [
  { id: 'stand.alpha', name: 'Alpha', icon: null },
  { id: 'stand.beta', name: 'Beta', icon: null },
  { id: 'stand.gamma', name: 'Gamma', icon: null },
]
const cubes = () => [...document.querySelectorAll<HTMLButtonElement>('[data-agent-cube]')]
const checked = () => cubes().filter((one) => one.getAttribute('aria-checked') === 'true').map((one) => one.dataset.agentCube)
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label)!
const key = (el: HTMLElement, name: string) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })))

test('the question: cubes with icon and name, one picked at a time, Confirm held until then', async () => {
  if (!inChild) return
  const confirmed: string[] = []
  await mount(<UI.PrimaryAgentDialog open kehikkoName="Writing" agents={AGENTS} onConfirm={(id) => void confirmed.push(id)} onLater={() => {}} />)
  expect(document.querySelector('[role="radiogroup"]')).not.toBeNull()
  expect(document.querySelector('select')).toBeNull()
  expect(cubes().map((one) => one.querySelector('[data-agent-name]')?.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
  /* Each with its module's icon, as its tile has (a letter when the module names none). */
  expect(cubes().every((one) => one.firstElementChild !== one.querySelector('[data-agent-name]'))).toBe(true)
  expect(document.querySelector('[data-primary-implications]')!.textContent).toBe(links.PRIMARY_SAID.implications)
  const confirm = document.querySelector<HTMLButtonElement>('[data-primary-confirm]')!
  expect(confirm.textContent).toBe('Confirm selection')
  expect(confirm.disabled).toBe(true)
  await act(async () => cubes()[1]!.click())
  expect(checked()).toEqual(['stand.beta'])
  await act(async () => cubes()[2]!.click())
  expect(checked()).toEqual(['stand.gamma'])
  expect(confirm.disabled).toBe(false)
  await act(async () => confirm.click())
  expect(confirmed).toEqual(['stand.gamma'])
})

test('the cubes by keyboard: one tab stop, the arrows move and pick, Home and End', async () => {
  if (!inChild) return
  await mount(<UI.PrimaryAgentDialog open kehikkoName="Writing" agents={AGENTS} onConfirm={() => {}} onLater={() => {}} />)
  expect(cubes().map((one) => one.tabIndex)).toEqual([0, -1, -1])
  await key(cubes()[0]!, 'ArrowRight')
  expect(checked()).toEqual(['stand.beta'])
  expect(document.activeElement).toBe(cubes()[1]!)
  expect(cubes().map((one) => one.tabIndex)).toEqual([-1, 0, -1])
  await key(cubes()[1]!, 'End')
  expect(checked()).toEqual(['stand.gamma'])
  await key(cubes()[2]!, 'ArrowRight')
  expect(checked()).toEqual(['stand.alpha'])
  await key(cubes()[0]!, 'ArrowLeft')
  expect(checked()).toEqual(['stand.gamma'])
})

test('Later puts the question off', async () => {
  if (!inChild) return
  let later = 0
  await mount(<UI.PrimaryAgentDialog open kehikkoName="Writing" agents={AGENTS} onConfirm={() => {}} onLater={() => void later++} />)
  await act(async () => button('Later').click())
  expect(later).toBe(1)
})

const answer = (over: Partial<import('../src/host/kehikkoSettings.ts').KehikkoSettingsAnswer> = {}) => ({
  settings: { primary: null, later: [] },
  agents: AGENTS.slice(0, 2),
  primary: null,
  due: true,
  ...over,
})

function Window({ start = 'general' as const, load, save, onRename = () => {} }: { start?: 'general' | 'skills' | 'agents'; load: never; save?: never; onRename?: (id: number, name: string) => void }) {
  const [section, setSection] = React.useState<'general' | 'skills' | 'agents'>(start)
  return (
    <UI.KehikkoSettingsDialog
      open
      onOpenChange={() => {}}
      kehikko={{ id: 2, name: 'Review', project: 1 }}
      section={section}
      onSection={setSection}
      onRename={onRename}
      load={load}
      save={save ?? ((async () => answer()) as never)}
      skills={{ load: async () => ({ skills: [], folder: '.kehikot/host/skills/k2/' }) }}
    />
  )
}

test('the window: General, Skills and Agents tabs; renaming from General', async () => {
  if (!inChild) return
  const renamed: Array<[number, string]> = []
  await mount(<Window load={(async () => answer()) as never} onRename={(id, name) => void renamed.push([id, name])} />)
  expect([...document.querySelectorAll('[role="tab"]')].map((one) => one.textContent?.replace('choose', '').trim())).toEqual(['General', 'Skills', 'Agents'])
  expect(document.querySelector('[data-agents-due]')).not.toBeNull()
  const name = document.querySelector<HTMLInputElement>('#kehikko-settings-name')!
  expect(name.value).toBe('Review')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Code review')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => document.querySelector<HTMLButtonElement>('[data-kehikko-rename]')!.click())
  expect(renamed).toEqual([[2, 'Code review']])
})

test('Agents: a quiet reminder after Later, and the same cubes to choose with', async () => {
  if (!inChild) return
  const chosen: unknown[] = []
  const save = (async (_: number, edit: unknown) => {
    chosen.push(edit)
    return answer({ primary: 'stand.beta', settings: { primary: 'stand.beta', later: [] }, due: false })
  }) as never
  await mount(<Window start="agents" load={(async () => answer({ settings: { primary: null, later: ['stand.alpha', 'stand.beta'] }, due: false })) as never} save={save} />)
  expect(document.querySelector('[data-primary-reminder]')!.getAttribute('data-primary-reminder')).toBe('later')
  const confirm = document.querySelector<HTMLButtonElement>('[role="tabpanel"][data-state="active"] [data-primary-confirm]')!
  expect(confirm.disabled).toBe(true)
  await act(async () => cubes()[1]!.click())
  await act(async () => confirm.click())
  await act(async () => {})
  expect(chosen).toEqual([{ primary: 'stand.beta' }])
  expect(document.querySelector('[data-primary-reminder]')).toBeNull()
  expect(document.body.textContent).toContain('primary now')
})

test('a deep link opens that kehikko’s settings at that section', async () => {
  if (!inChild) return
  const asked: number[] = []
  const load = (async (id: number) => {
    asked.push(id)
    return answer({ due: false })
  }) as never
  const canvases = [
    { id: 1, name: 'Writing', project: 1, placements: [] },
    { id: 2, name: 'Review', project: 1, placements: [] },
  ]
  await mount(<UI.KehikkoSettingsHost canvases={canvases} open={canvases[0]!} onRename={() => {}} load={load} save={(async () => answer()) as never} />)
  expect(document.querySelector('[data-kehikko-settings]')).toBeNull()
  await act(async () => links.openKehikkoSettings('agents', 'primary-agent', 2))
  await act(async () => {})
  expect(document.querySelector('[data-kehikko-settings]')).not.toBeNull()
  expect(document.querySelector('[data-kehikko-settings] [data-modal-context]')!.textContent).toBe('Review')
  expect(document.querySelector('[role="tab"][data-state="active"]')!.textContent).toContain('Agents')
  expect(asked).toEqual([2])
})

test('the question opens by itself when a second agent module is placed, and not with one', async () => {
  if (!inChild) return
  const one = { id: 1, name: 'Writing', project: 1, placements: [{ i: 'stand.alpha' }] }
  const due = { current: false }
  const load = (async () => answer({ due: due.current })) as never
  const draw = (open: typeof one) => <UI.KehikkoSettingsHost canvases={[open]} open={open} onRename={() => {}} load={load} save={(async () => answer()) as never} />
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<TooltipProvider>{draw(one)}</TooltipProvider>))
  await act(async () => {})
  unmount = () => root.unmount()
  expect(document.querySelector('[data-primary-agent]')).toBeNull()
  due.current = true
  const two = { ...one, placements: [{ i: 'stand.alpha' }, { i: 'stand.beta' }] }
  await act(async () => root.render(<TooltipProvider>{draw(two)}</TooltipProvider>))
  await act(async () => {})
  expect(document.querySelector('[data-primary-agent]')).not.toBeNull()
})

test('the kehikko menu: a gear on every row opens that kehikko’s settings; no pencil', async () => {
  if (!inChild) return
  const opened: number[] = []
  const canvas = (id: number, name: string) => ({ id, key: `k${id}`, name, project: 1, placements: [], connections: undefined }) as never
  await mount(<Canvases canvases={[canvas(1, 'Writing'), canvas(2, 'Review')]} open={canvas(1, 'Writing')} onOpen={() => {}} onSettings={(id) => void opened.push(id)} onCreate={() => {}} onDelete={() => {}} />)
  const trigger = document.querySelector<HTMLElement>('[aria-label="switch kehikko"]')!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
  })
  expect(document.querySelector('[aria-label^="rename"]')).toBeNull()
  expect(document.body.textContent).not.toContain('skills for this kehikko')
  const gear = document.querySelector<HTMLElement>('[aria-label="settings for Review"]')!
  expect(gear).not.toBeNull()
  expect(document.querySelector('[aria-label="settings for Writing"]')).not.toBeNull()
  await act(async () => gear.click())
  await act(async () => new Promise((done) => setTimeout(done, 5)))
  expect(opened).toEqual([2])
})
