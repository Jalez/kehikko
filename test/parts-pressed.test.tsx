import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/*
 * The parts picker, opened and pressed: a row is two things to press — its
 * box, which ticks that part and leaves the others alone, and its name, which
 * picks that part and no other.
 *
 * The last group is the property the name press exists for. It is driven
 * through the same three functions `App.tsx` wires the picker to — `withEdit`
 * on screen, `editSubject` to the server, `partsOnWire` into the context — and
 * counts what one press costs: one write, and one context that is never
 * "nothing picked" on the way.
 *
 * ## Why this file runs itself in a process of its own
 *
 * The reason `updates-panel.test.tsx` gives: Radix decides at module load
 * whether it has a DOM, and `bun test` loads every file into one process.
 */

const inChild = process.env.PARTS_PRESSED_DOM === '1'

if (!inChild) {
  test('the parts picker, pressed in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, PARTS_PRESSED_DOM: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    if (run.exitCode !== 0) console.error(out)
    expect(run.exitCode).toBe(0)
    expect(out).toMatch(/\b9 pass/)
  }, 60_000)
}

type Part = import('../src/host/parts.ts').Part

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Parts: typeof import('../src/canvas/Parts.tsx').Parts
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let partsOnWire: typeof import('../src/host/parts.ts').partsOnWire
let subject: typeof import('../src/host/subject.ts')

/** Every write to the server: the body of each `PATCH /host/subject`. */
let written: { parts?: string[] }[] = []

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { parts?: string[] }
    written.push(body)
    return new Response(JSON.stringify({ subject: { epic: 'thesis', parts: body.parts ?? [], selection: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Parts } = await import('../src/canvas/Parts.tsx'))
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
  ;({ partsOnWire } = await import('../src/host/parts.ts'))
  subject = await import('../src/host/subject.ts')
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
  written = []
})

const parts: Part[] = [
  { id: 'the-posting-seam', heading: 'The posting seam', refs: ['gh#1', 'gh#3'], steps: 0 },
  { id: 'the-agent-seam', heading: 'The agent seam', refs: ['gh#4'], steps: 2 },
  { id: 'what-the-page-shows', heading: 'What the page shows', refs: [], steps: 0, files: ['chapters/page.tex'] },
]
const [A, B, C] = parts.map((part) => part.id) as [string, string, string]

/**
 * The picker, wired the way `App.tsx` wires it, with the menu open.
 * `picks` is every list `onPick` was handed; `contexts` is every distinct
 * `context.parts` a module would have been sent, the first being the one it
 * already had.
 */
async function open(stored: string[]) {
  const picks: string[][] = []
  const contexts: string[][] = []
  const PROJECT = 1
  function Wired() {
    const [subjects, setSubjects] = React.useState(() => subject.withEdit({}, PROJECT, { epic: 'thesis', parts: stored }))
    const about = subject.subjectOf(subjects, PROJECT)
    /* `narrowedTo` in `App.tsx`: the context is rebuilt when this string moves. */
    const narrowedTo = JSON.stringify(partsOnWire(parts, about.parts))
    React.useEffect(() => {
      contexts.push((JSON.parse(narrowedTo) as { id: string; picked: boolean }[]).filter((p) => p.picked).map((p) => p.id))
    }, [narrowedTo])
    return (
      <TooltipProvider>
        <Parts
          parts={parts}
          picked={about.parts}
          epic="thesis"
          onPick={(ids) => {
            picks.push(ids)
            setSubjects((was) => subject.withEdit(was, PROJECT, { parts: ids }))
            void subject.editSubject(PROJECT, { parts: ids })
          }}
        />
      </TooltipProvider>
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Wired />))
  unmount = () => root.unmount()
  const trigger = host.querySelector('button[aria-haspopup="menu"]') as HTMLElement
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    trigger.click()
  })
  return { picks, contexts }
}

const row = (id: string) => document.querySelector(`[data-part="${id}"]`) as HTMLElement
const box = (id: string) => row(id).querySelector('[role="checkbox"]') as HTMLElement
const name = (id: string) => row(id).querySelector('[role="menuitem"]') as HTMLElement
const ticked = () => parts.map((part) => part.id).filter((id) => box(id).getAttribute('aria-checked') === 'true')
const press = (el: HTMLElement) => act(async () => el.click())
const key = (el: HTMLElement, k: string) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))

describe.if(inChild)('a row of the parts picker is two things to press', () => {
  test('a real checkbox named for the part, and beside it the name, which says what it does', async () => {
    await open([])
    expect(box(B).tagName).toBe('BUTTON')
    expect(box(B).getAttribute('aria-label')).toBe('The agent seam')
    /* Not one inside the other: two targets, neither a child of the other. */
    expect(name(B).contains(box(B))).toBe(false)
    /* Its accessible name is its words: "only", the heading, and the count. */
    expect(name(B).getAttribute('aria-label')).toBeNull()
    expect(name(B).textContent).toBe('only The agent seam2 steps · 1 ref')
    expect(name(C).textContent).toBe('only What the page shows1 file')
    /* The box is not a stop of its own; the menu's walk is one stop a part. */
    expect(box(B).getAttribute('tabindex')).toBe('-1')
  })

  test('the box ticks its part and leaves every other as it is', async () => {
    const { picks } = await open([])
    await press(box(A))
    expect(ticked()).toEqual([A])
    await press(box(B))
    expect(ticked()).toEqual([A, B])
    await press(box(A))
    expect(ticked()).toEqual([B])
    await press(box(B))
    expect(ticked()).toEqual([])
    expect(picks).toEqual([[A], [A, B], [B], []])
  })

  test('the name picks its part and no other', async () => {
    const { picks } = await open([A, B])
    await press(name(C))
    expect(ticked()).toEqual([C])
    /* Of two picked, the name of one of them keeps that one. */
    await press(box(A))
    await press(name(A))
    expect(ticked()).toEqual([A])
    expect(picks).toEqual([[C], [A, C], [A]])
  })

  test('the name of the only part picked leaves it picked, and writes nothing', async () => {
    const { picks } = await open([C])
    await press(name(C))
    await press(name(C))
    expect(ticked()).toEqual([C])
    expect(picks).toEqual([])
    expect(written).toEqual([])
    /* The box is the way back to nothing picked. */
    await press(box(C))
    expect(ticked()).toEqual([])
  })

  test('the menu stays open through both presses', async () => {
    await open([])
    await press(box(A))
    await press(name(B))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })
})

describe.if(inChild)('on the keyboard a part is one stop and two keys', () => {
  test('Space ticks the part and leaves the others', async () => {
    const { picks } = await open([A])
    await key(name(B), ' ')
    expect(ticked()).toEqual([A, B])
    await key(name(B), ' ')
    expect(ticked()).toEqual([A])
    /* One press each: the menu did not also take Space as a press on the name. */
    expect(picks).toEqual([[A, B], [A]])
  })

  test('Enter picks the part alone', async () => {
    const { picks } = await open([A, B])
    await key(name(C), 'Enter')
    expect(ticked()).toEqual([C])
    await key(name(C), 'Enter')
    expect(ticked()).toEqual([C])
    expect(picks).toEqual([[C]])
  })
})

describe.if(inChild)('one press is one write and one context', () => {
  test('picking a part alone never says "nothing picked" on the way', async () => {
    const { picks, contexts } = await open([A, B])
    expect(contexts).toEqual([[A, B]])
    await press(name(C))
    expect(picks).toEqual([[C]])
    expect(written).toEqual([{ project: 1, parts: [C] }] as never)
    expect(contexts).toEqual([[A, B], [C]])
  })

  test('and so is a tick, and a press that changes nothing is neither', async () => {
    const { contexts } = await open([C])
    await press(box(A))
    expect(written.map((w) => w.parts)).toEqual([[A, C]])
    expect(contexts).toEqual([[C], [A, C]])
    await key(name(B), 'Enter')
    expect(written.map((w) => w.parts)).toEqual([[A, C], [B]])
    expect(contexts).toEqual([[C], [A, C], [B]])
    await press(name(B))
    expect(written).toHaveLength(2)
    expect(contexts).toHaveLength(3)
  })
})
