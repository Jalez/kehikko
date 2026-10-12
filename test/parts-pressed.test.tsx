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
    expect(out).toMatch(/\b19 pass/)
  }, 60_000)
}

type Part = import('../src/host/parts.ts').Part

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let Parts: typeof import('../src/canvas/Parts.tsx').Parts
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider
let partsOnWire: typeof import('../src/host/parts.ts').partsOnWire
let edited: typeof import('../src/host/parts.ts').edited
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
  ;({ partsOnWire, edited } = await import('../src/host/parts.ts'))
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
async function open(stored: string[], from: readonly Part[] = parts, editable = true) {
  const picks: string[][] = []
  const contexts: string[][] = []
  /** Every edit the picker asked for, as `parts.set` would carry it. */
  const edits: unknown[] = []
  const PROJECT = 1
  function Wired() {
    const [subjects, setSubjects] = React.useState(() => subject.withEdit({}, PROJECT, { epic: 'thesis', parts: stored }))
    /* The epic's list, held where `App.tsx` holds the project's epics: an edit is answered with the row as it now reads. */
    const [list, setList] = React.useState<readonly Part[]>(from)
    const about = subject.subjectOf(subjects, PROJECT)
    /* `narrowedTo` in `App.tsx`: the context is rebuilt when this string moves. */
    const narrowedTo = JSON.stringify(partsOnWire(list, about.parts))
    React.useEffect(() => {
      contexts.push((JSON.parse(narrowedTo) as { id: string; picked: boolean }[]).filter((p) => p.picked).map((p) => p.id))
    }, [narrowedTo])
    return (
      <TooltipProvider>
        <Parts
          parts={list}
          picked={about.parts}
          epic="thesis"
          onPick={(ids) => {
            picks.push(ids)
            setSubjects((was) => subject.withEdit(was, PROJECT, { parts: ids }))
            void subject.editSubject(PROJECT, { parts: ids })
          }}
          onEdit={
            editable
              ? async (edit) => {
                  edits.push(edit)
                  /* The server's one writer decides with this same function. */
                  const said = edited(list.map((part) => ({ id: part.id, name: part.heading })), edit)
                  if (said.outcome !== 'changed' && said.outcome !== 'unchanged') return false
                  setList(said.parts.map((one) => list.find((part) => part.id === one.id && part.heading === one.name) ?? { ...(list.find((part) => part.id === one.id) ?? { refs: [], steps: 0 }), id: one.id, heading: one.name }))
                  return true
                }
              : null
          }
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
  return { picks, contexts, edits, trigger, host }
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

/** Every part in the menu, top to bottom, as its id. */
const order = () => [...document.querySelectorAll('[data-part]')].map((el) => el.getAttribute('data-part'))
const tool = (id: string, label: string) => row(id).querySelector(`[aria-label^="${label}"]`) as HTMLElement
const box_ = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null
/** Type a name into a box the way a person does, and press a key in it. */
async function type(input: HTMLInputElement, text: string, then: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => void input.dispatchEvent(new KeyboardEvent('keydown', { key: then, bubbles: true, cancelable: true })))
}
const addRow = () => [...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === 'part') as HTMLElement

describe.if(inChild)('the picker is where the parts are made', () => {
  test('the list ends in "+ part", and pressing it puts a name box there', async () => {
    const { edits } = await open([])
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    expect(items.at(-1)).toBe(addRow())
    expect(box_('the name of a new part')).toBeNull()
    await press(addRow())
    const input = box_('the name of a new part')!
    expect(input.getAttribute('placeholder')).toBe('name of the part')
    expect(document.activeElement).toBe(input)
    await type(input, '  Limitations  ', 'Enter')
    expect(edits).toEqual([{ add: { name: 'Limitations' } }])
    expect(order()).toEqual([A, B, C, 'limitations'])
    /* Emptied and still there, with the caret in it: the next one is usually next. */
    expect(box_('the name of a new part')!.value).toBe('')
    expect(document.activeElement).toBe(box_('the name of a new part'))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })

  test('nothing typed is not a part; Escape leaves the list as it was', async () => {
    const { edits } = await open([])
    await press(addRow())
    await type(box_('the name of a new part')!, '   ', 'Enter')
    expect(edits).toEqual([])
    expect(box_('the name of a new part')).toBeNull()
    await press(addRow())
    await type(box_('the name of a new part')!, 'Half a na', 'Escape')
    expect(edits).toEqual([])
    /* The box is gone and the menu is not: Escape undid the name, not the opening. */
    expect(box_('the name of a new part')).toBeNull()
    expect(order()).toEqual([A, B, C])
    expect(addRow()).toBeDefined()
  })

  test('an epic with no parts opens straight onto the name box, and one name is one part', async () => {
    const { edits, trigger } = await open([], [])
    expect(trigger.textContent).toBe('no parts')
    expect(document.querySelectorAll('[data-part]')).toHaveLength(0)
    const input = box_('the name of a new part')!
    expect(input).not.toBeNull()
    await type(input, 'Introduction', 'Enter')
    expect(edits).toEqual([{ add: { name: 'Introduction' } }])
    expect(order()).toEqual(['introduction'])
    expect(trigger.textContent).toBe('all parts')
    /* The same menu, still open, now with a list in it. */
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })

  test('rename is typed in the row; the id does not change and what was picked stays picked', async () => {
    const { edits, picks, contexts } = await open([B])
    await press(tool(B, 'rename'))
    const input = box_('what the part The agent seam is called')!
    expect(input.value).toBe('The agent seam')
    /* The other rows are still there: a part is named by looking at the others. */
    expect(order()).toEqual([A, B, C])
    await type(input, 'One function posts', 'Enter')
    expect(edits).toEqual([{ rename: { id: B, name: 'One function posts' } }])
    expect(order()).toEqual([A, B, C])
    expect(name(B).textContent).toStartWith('only One function posts')
    expect(ticked()).toEqual([B])
    expect(picks).toEqual([])
    /* One context for the new name; the pick in it is the same pick. */
    expect(contexts).toEqual([[B], [B]])
  })

  test('the same name again writes nothing; F2 on a row is the pencil', async () => {
    const { edits } = await open([])
    await key(name(C), 'F2')
    const input = box_('what the part What the page shows is called')!
    await type(input, 'What the page shows', 'Enter')
    expect(edits).toEqual([])
    expect(box_('what the part What the page shows is called')).toBeNull()
  })

  test('up and down move a part one place, and the ends have nowhere to go', async () => {
    const { edits } = await open([])
    await press(tool(C, 'move What the page shows up'))
    expect(order()).toEqual([A, C, B])
    await press(tool(C, 'move What the page shows up'))
    expect(order()).toEqual([C, A, B])
    await press(tool(C, 'move What the page shows up'))
    await press(tool(C, 'move What the page shows down'))
    expect(order()).toEqual([A, C, B])
    expect(edits).toEqual([{ move: { id: C, after: A } }, { move: { id: C, after: null } }, { move: { id: C, after: A } }])
    expect(tool(A, 'move The posting seam up').getAttribute('aria-disabled')).toBe('true')
    expect(tool(B, 'move The agent seam down').getAttribute('aria-disabled')).toBe('true')
    /* On the keyboard: Alt and an arrow. */
    await key2(name(B), 'ArrowUp')
    expect(order()).toEqual([A, B, C])
  })

  test('remove asks once: the first press arms, the second removes, and a press on the name while armed picks nothing', async () => {
    const { edits, picks } = await open([])
    await press(tool(B, 'remove'))
    expect(edits).toEqual([])
    expect(row(B).textContent).toContain('remove?')
    await press(name(B))
    expect(picks).toEqual([])
    await press([...row(B).querySelectorAll('button')].find((el) => el.textContent === 'remove?') as HTMLElement)
    expect(edits).toEqual([{ remove: { id: B } }])
    expect(order()).toEqual([A, C])
  })

  test('a picked part that is removed is said in the bar, with one press to forget it', async () => {
    const { host, picks } = await open([B])
    await press(tool(B, 'remove'))
    await press([...row(B).querySelectorAll('button')].find((el) => el.textContent === 'remove?') as HTMLElement)
    const gone = host.querySelector('[data-gone]') as HTMLElement
    expect(gone.textContent).toBe('a picked part is gone')
    await press(gone)
    expect(picks).toEqual([[]])
    expect(host.querySelector('[data-gone]')).toBeNull()
  })

  test('a row says its whole name where a narrow one cannot', async () => {
    await open([])
    expect(name(B).querySelector('[title]')!.getAttribute('title')).toBe('The agent seam')
  })

  test('a list that cannot be edited from here is the picker it always was: no tools, no last row', async () => {
    await open([], parts, false)
    expect(document.querySelector('[data-tools]')).toBeNull()
    expect(addRow()).toBeUndefined()
    expect(name(B).textContent).toBe('only The agent seam2 steps · 1 ref')
  })
})

const key2 = (el: HTMLElement, k: string) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true })))
