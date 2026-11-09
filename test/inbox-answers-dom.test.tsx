import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INBOX_VIA, type ActivityItem } from 'kehikot-module-protocol'

import { AgentMessages } from '../server/agentMessages.ts'
import { open as openDb } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'
import { addProject } from '../server/projects.ts'
import type { Entry } from '../src/host/inbox.ts'

/*
 * An item's question, rendered (protocol 2.55.0): whole in its Inbox row and in its toast, its
 * choices as buttons, a reply field; answered through `useInbox` against a real store over the real
 * routes, only on the person's fresh press (`navigator.userActivation`), and then "Answered: …"
 * with no controls. In a process of its own, as `whats-new-dom.test.tsx` explains.
 */

const inChild = process.env.INBOX_ANSWERS_DOM === '1'
const TESTS = 5

if (!inChild) {
  test('an item’s question, rendered in a process of its own', () => {
    const run = Bun.spawnSync([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, INBOX_ANSWERS_DOM: '1' },
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
let useInbox: typeof import('../src/canvas/useInbox.ts').useInbox
let Panel: typeof import('../src/canvas/Inbox.tsx')
let Toasts: typeof import('../src/canvas/InboxToasts.tsx')
let Rules: typeof import('../src/host/inbox.ts')
let TooltipProvider: typeof import('../src/components/ui/tooltip.tsx').TooltipProvider

beforeAll(async () => {
  if (!inChild) return
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useInbox } = await import('../src/canvas/useInbox.ts'))
  Panel = await import('../src/canvas/Inbox.tsx')
  Toasts = await import('../src/canvas/InboxToasts.tsx')
  Rules = await import('../src/host/inbox.ts')
  ;({ TooltipProvider } = await import('../src/components/ui/tooltip.tsx'))
})
afterAll(async () => {
  if (!inChild) return
  await GlobalRegistrator.unregister()
})

const ME = 'kehikot.asker'
/** A question with markup in it: drawn as text, never as markup or a link. */
const QUESTION = 'Merge <b>now</b> or wait? See https://example.org — '.repeat(6).trim()
const asking = (id: string, choices?: string[]): ActivityItem =>
  ({
    id,
    state: 'attention',
    label: `waiting: ${id}`,
    since: 5,
    question: { text: QUESTION, ...(choices ? { choices } : {}), to: { module: ME, session: 'conv-1' } },
  }) as ActivityItem
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const nothing = () => {}

/** The person's fresh press, as the browser says it (`pressFresh`). */
function pressing(on: boolean) {
  Object.defineProperty(navigator, 'userActivation', { value: { isActive: on }, configurable: true })
}

/** Type into a React-controlled input. */
function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  set.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const button = (root: ParentNode, words: string) =>
  [...root.querySelectorAll('button')].find((one) => one.textContent?.trim() === words) as HTMLButtonElement | undefined

describe.if(inChild)('the question in the Inbox row, answered through the page', () => {
  let db: Database
  let folder: string
  let project: number
  let inbox: Inbox
  let messages: AgentMessages
  let hook: ReturnType<typeof useInbox> | null
  let unmount: () => void
  let host: HTMLDivElement
  const realFetch = globalThis.fetch

  beforeEach(() => {
    db = openDb(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-answers-dom-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    inbox = new Inbox(db)
    messages = new AgentMessages(db)
    const desk = inboxDesk({ inbox, pathOf: (id) => (id === project ? folder : undefined), messages, changed: () => undefined })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://127.0.0.1:4180')
      const response = await desk.route(new Request(url, init), url)
      return response ?? new Response('{}', { status: 404 })
    }) as typeof fetch
    hook = null
    pressing(false)
  })
  afterEach(() => {
    act(() => unmount())
    globalThis.fetch = realFetch
    db.close()
    rmSync(folder, { recursive: true, force: true })
    document.body.innerHTML = ''
  })

  async function mount() {
    const at = { epic: null, kehikko: null }
    function Page() {
      hook = useInbox({
        project,
        projects: [{ id: project, name: 'a project', path: folder }],
        alive: new Set([ME]),
        at: { epic: null, parts: [], kehikko: null },
        nameOf: () => 'Asker',
        notify: nothing,
      })
      const view: import('../src/canvas/Inbox.tsx').InboxView = {
        entries: hook.open,
        earlierCount: 0,
        at,
        scope: 'everywhere',
        onScope: nothing,
        names: { epic: () => null, part: () => null, kehikko: () => null },
        tally: Rules.tally(hook.open, at),
        next: null,
        open: true,
        onOpenChange: nothing,
        onGo: nothing,
        onNext: nothing,
        onSee: nothing,
        onDismiss: nothing,
        onForget: nothing,
        onSeeAll: nothing,
        loadLog: async () => ({ rows: [], more: false, total: 0 }),
        rev: hook.rev,
        shortcut: 'Alt+Shift+N',
        now: () => Date.now(),
        onAnswer: (entry, said, pressed, inProject) => hook!.answer(entry, said, pressed, inProject),
      }
      return <TooltipProvider><Panel.InboxPanel view={view} /></TooltipProvider>
    }
    host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<Page />))
    unmount = () => root.unmount()
    await act(async () => wait(20))
  }

  const row = () => host.querySelector('[data-inbox-row="attention"]') as HTMLElement

  test('the row shows the whole question as text, its choices as buttons, and a reply field', async () => {
    inbox.report(project, ME, 'Asker', [asking('a', ['Merge', 'Wait'])])
    await mount()
    const said = row().querySelector('[data-inbox-question-text]')!
    expect(said.textContent).toBe(QUESTION)
    expect(said.querySelector('b, a')).toBeNull()
    expect(row().querySelector('a')).toBeNull()
    const choices = row().querySelector('[data-inbox-question-choices]')!
    expect([...choices.querySelectorAll('button')].map((one) => one.textContent)).toEqual(['Merge', 'Wait'])
    expect(row().querySelector('[data-inbox-reply] input')).not.toBeNull()
  })

  test('a choice pressed: sent to that session as the person’s, and the row says “Answered:” with no controls', async () => {
    inbox.report(project, ME, 'Asker', [asking('a', ['Merge', 'Wait'])])
    await mount()
    pressing(true)
    await act(async () => {
      button(row(), 'Wait')!.click()
      await wait(30)
    })
    const [message, ...rest] = messages.all(project)
    expect(rest).toEqual([])
    expect(message).toMatchObject({ body: 'Wait', to: { session: { module: ME, session: 'conv-1' } }, from: { name: INBOX_VIA, person: true }, answers: QUESTION })
    expect(row().querySelector('[data-inbox-answered]')?.textContent).toBe('Answered: Wait')
    expect(row().querySelector('[data-inbox-question-choices]')).toBeNull()
    expect(row().querySelector('[data-inbox-reply]')).toBeNull()
    /* The question itself stays in view. */
    expect(row().querySelector('[data-inbox-question-text]')?.textContent).toBe(QUESTION)
  })

  test('words typed and sent: the same, with the words as the answer', async () => {
    inbox.report(project, ME, 'Asker', [asking('a')])
    await mount()
    expect(row().querySelector('[data-inbox-question-choices]')).toBeNull()
    const input = row().querySelector('[data-inbox-reply] input') as HTMLInputElement
    await act(async () => type(input, 'Wait for Monday'))
    pressing(true)
    await act(async () => {
      button(row(), 'Send')!.click()
      await wait(30)
    })
    expect(messages.all(project).map((one) => [one.body, one.from.person, one.to])).toEqual([['Wait for Monday', true, { session: { module: ME, session: 'conv-1' } }]])
    expect(row().querySelector('[data-inbox-answered]')?.textContent).toBe('Answered: Wait for Monday')
  })

  test('without the person’s fresh press nothing is sent, and the row says why', async () => {
    inbox.report(project, ME, 'Asker', [asking('a', ['Merge', 'Wait'])])
    await mount()
    pressing(false)
    await act(async () => {
      button(row(), 'Merge')!.click()
      await wait(30)
    })
    expect(messages.all(project)).toEqual([])
    expect(row().querySelector('[data-inbox-answer-why]')?.textContent).toContain('Not sent')
    expect(Rules.isAnswered(inbox.open(project)[0]!)).toBe(false)
  })
})

describe.if(inChild)('the question in the toast', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('shown whole with its choices and a reply field; an answer goes on a press and closes the toast', async () => {
    const entry: Entry = {
      module: ME, name: 'Asker', id: 'a', state: 'attention', label: 'waiting: a', priority: 'normal', refs: [],
      question: { text: QUESTION, choices: ['Merge', 'Wait'], to: { module: ME, session: 'conv-1' } },
      entered: 5, opened: 5, closed: null, how: null, seen: null, dismissed: null, origin: 'activity',
    }
    const toast = { id: 1, kind: 'attention' as const, by: 'Asker', label: entry.label, place: 'the project', count: 1, entry, project: 1 }
    const answered: [string, unknown, boolean][] = []
    const closed: number[] = []
    function Shown() {
      const [list, setList] = React.useState([toast])
      return (
        <Toasts.InboxToasts
          toasts={list}
          onOpen={nothing}
          onClose={(id) => {
            closed.push(id)
            setList((was) => was.filter((one) => one.id !== id))
          }}
          onCloseAll={nothing}
          onAnswer={async (one, said, pressed) => {
            answered.push([one.entry.id, said, pressed])
            return pressed ? { ok: true } : { ok: false, why: 'no press' }
          }}
        />
      )
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(<Shown />))
    const card = host.querySelector('[data-inbox-toast]') as HTMLElement
    expect(card.querySelector('[data-inbox-question-text]')?.textContent).toBe(QUESTION)
    expect(card.querySelector('[data-inbox-question-text] b, [data-inbox-question-text] a')).toBeNull()
    expect([...card.querySelectorAll('[data-inbox-question-choices] button')].map((one) => one.textContent)).toEqual(['Merge', 'Wait'])
    expect(card.querySelector('[data-inbox-reply] input')).not.toBeNull()
    pressing(true)
    await act(async () => {
      button(card, 'Merge')!.click()
      await wait(10)
    })
    expect(answered).toEqual([['a', { choice: 0, answer: 'Merge' }, true]])
    expect(closed).toEqual([1])
    expect(host.querySelector('[data-inbox-toast]')).toBeNull()
    act(() => root.unmount())
  })
})
