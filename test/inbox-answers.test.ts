import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INBOX_VIA, LIMITS, typedFrame, type ActivityItem } from 'kehikot-module-protocol'

import { AgentMessages } from '../server/agentMessages.ts'
import { open } from '../server/canvases.ts'
import { PAGE_ONLY, own, refusal } from '../server/guard.ts'
import { Inbox, itemsIn } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'
import { readInboxText } from '../server/inboxText.ts'
import { HOST_ID } from '../server/kehikot.ts'
import { addProject } from '../server/projects.ts'
import { answerFor, askedOf, heldQuestion, isAnswered, type Entry } from '../src/host/inbox.ts'
import { settledToasts, type Toast } from '../src/host/toasts.ts'

/*
 * Answering an agent's question from the Inbox (protocol 2.55.0, `question` on an activity item):
 * the question is held to the reporting module, kept through the record, answered only on the
 * person's press in this page, sent to the ONE session it names as the person's message by
 * `INBOX_VIA`, and the entry marked answered until its module withdraws it. Stand-ins only.
 */

const ME = 'kehikot.asker'
const OTHER = 'kehikot.other'

const asking = (id: string, more: Partial<ActivityItem> = {}, question: Record<string, unknown> = {}): ActivityItem =>
  ({
    id,
    state: 'attention',
    label: `waiting: ${id}`,
    since: 5,
    place: { epic: 'methods', kehikko: 'wide' },
    question: { text: 'Merge the branch now, or wait for review?', choices: ['Merge', 'Wait'], to: { module: ME, session: 'conv-1' }, ...question },
    ...more,
  }) as ActivityItem

describe('the rules', () => {
  test('a question is kept only on an attention item, and only for the reporter’s own session unless it relays', () => {
    const item = asking('a')
    expect(heldQuestion(item, ME, false)).toEqual({
      text: 'Merge the branch now, or wait for review?',
      choices: ['Merge', 'Wait'],
      to: { module: ME, session: 'conv-1' },
    })
    expect(heldQuestion({ ...item, state: 'working' }, ME, false)).toBeUndefined()
    const elsewhere = asking('b', {}, { to: { module: OTHER, session: 'conv-9' } })
    expect(heldQuestion(elsewhere, ME, false)).toBeUndefined()
    expect(heldQuestion(elsewhere, ME, true)?.to).toEqual({ module: OTHER, session: 'conv-9' })
  })

  test('a bad question parses as none, and the item is kept', () => {
    const list = itemsIn([{ id: 'a', state: 'attention', label: 'x', question: { text: '', to: { module: ME, session: 'c' } } }])
    expect(list).not.toBeNull()
    expect(list![0]!.question).toBeUndefined()
    const many = itemsIn([{ id: 'a', state: 'attention', label: 'x', question: { text: 'Q', choices: ['1', '2', '3', '4', '5', '6', '7'], to: { module: ME, session: 'c' } } }])
    expect(many![0]!.question).toBeUndefined()
  })

  test('an answer is one of the choices, or words of the person’s own', () => {
    const entry: Entry = {
      module: ME, name: 'Asker', id: 'a', state: 'attention', label: 'a', priority: 'normal', refs: [],
      question: { text: 'Q?', choices: ['Merge', 'Wait'], to: { module: ME, session: 'conv-1' } },
      entered: 5, opened: 5, closed: null, how: null, seen: null, dismissed: null, origin: 'activity',
    }
    expect(answerFor(entry, { choice: 1 })).toEqual({ ok: true, text: 'Wait' })
    expect(answerFor(entry, { choice: 1, answer: 'Wait' })).toEqual({ ok: true, text: 'Wait' })
    expect(answerFor(entry, { choice: 1, answer: 'Merge' }).ok).toBe(false)
    expect(answerFor(entry, { choice: 2 }).ok).toBe(false)
    expect(answerFor(entry, { choice: '0' }).ok).toBe(false)
    expect(answerFor(entry, { answer: '  after lunch  ' })).toEqual({ ok: true, text: 'after lunch' })
    expect(answerFor(entry, { answer: '   ' }).ok).toBe(false)
    expect(answerFor(entry, { answer: 'x'.repeat(LIMITS.MESSAGE_BODY + 1) }).ok).toBe(false)
    expect(answerFor({ ...entry, answered: { entered: 5, at: 9, text: 'Wait' } }, { choice: 0 }).ok).toBe(false)
    /* An answer to the question it asked in an earlier state does not count now. */
    expect(isAnswered({ ...entry, entered: 6, answered: { entered: 5, at: 9, text: 'Wait' } })).toBe(false)
    expect(askedOf({ ...entry, answered: { entered: 5, at: 9, text: 'Wait' } })).toEqual({ text: 'Q?', choices: ['Merge', 'Wait'], answered: 'Answered: Wait' })
    expect(askedOf({ ...entry, state: 'done' })).toBeNull()
  })
})

describe('the record and the answer route', () => {
  let db: Database
  let folder: string
  let project: number
  let inbox: Inbox
  let messages: AgentMessages
  let changed: number[]
  let mail: number[]
  let relaying: Set<string>
  let desk: ReturnType<typeof inboxDesk>

  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-answers-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    inbox = new Inbox(db)
    messages = new AgentMessages(db)
    changed = []
    mail = []
    relaying = new Set()
    desk = inboxDesk({
      inbox,
      pathOf: (id) => (id === project ? folder : undefined),
      relays: (module) => relaying.has(module),
      messages,
      messagesChanged: (id) => mail.push(id),
      changed: (id) => changed.push(id),
    })
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  const post = async (path: string, body: unknown) => {
    const url = new URL(path, 'http://127.0.0.1:4180')
    const response = await desk.route(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url)
    return { status: response!.status, body: (await response!.json()) as Record<string, unknown> }
  }
  const report = (module: string, items: ActivityItem[]) => post('/host/inbox/report', { project, module, name: 'Asker', items })
  const stored = () => messages.all(project)

  test('the question is kept through the report and read back whole', async () => {
    const got = await report(ME, [asking('a')])
    expect((got.body.open as Entry[])[0]!.question).toEqual({ text: 'Merge the branch now, or wait for review?', choices: ['Merge', 'Wait'], to: { module: ME, session: 'conv-1' } })
    /* A fresh store over the same database reads it back. */
    expect(new Inbox(db).open(project)[0]!.question?.text).toBe('Merge the branch now, or wait for review?')
  })

  test('a question naming another module’s session is dropped, unless the reporter declares messages:as-person', async () => {
    const elsewhere = asking('a', {}, { to: { module: OTHER, session: 'conv-9' } })
    const dropped = await report(ME, [elsewhere])
    expect((dropped.body.open as Entry[])[0]).toMatchObject({ id: 'a', state: 'attention' })
    expect((dropped.body.open as Entry[])[0]!.question).toBeUndefined()
    relaying.add(ME)
    const kept = await report(ME, [elsewhere])
    expect((kept.body.open as Entry[])[0]!.question?.to).toEqual({ module: OTHER, session: 'conv-9' })
  })

  test('answered by a choice: the person’s message to that one session, answering the question’s text; the entry answered', async () => {
    await report(ME, [asking('a')])
    changed = []
    const got = await post('/host/inbox/answer', { project, module: ME, item: 'a', choice: 0, answer: 'Merge', pressed: true })
    expect(got.status).toBe(200)
    expect(got.body.ok).toBe(true)
    const [message, ...rest] = stored()
    expect(rest).toEqual([])
    expect(message!.to).toEqual({ session: { module: ME, session: 'conv-1' } })
    expect(message!.from).toMatchObject({ module: HOST_ID, name: INBOX_VIA, session: null, person: true, place: { epic: 'methods', kehikko: 'wide' } })
    expect(message!.body).toBe('Merge')
    expect(message!.answers).toBe('Merge the branch now, or wait for review?')
    expect(message!.replyTo).toBeNull()
    expect(mail).toEqual([project])
    expect(changed).toEqual([project])
    /* Delivered to that session only: another session of the same module, and another module, get nothing. */
    expect(messages.unread(project, { module: ME, session: 'conv-1', epic: null, kehikko: null }).map((one) => one.id)).toEqual([message!.id])
    expect(messages.unread(project, { module: ME, session: 'conv-2', epic: 'methods', kehikko: 'wide' })).toEqual([])
    expect(messages.unread(project, { module: OTHER, session: 'conv-1', epic: 'methods', kehikko: 'wide' })).toEqual([])
    /* The frame the session reads it under says who and through what. */
    expect(typedFrame(message!)).toContain(`via ${INBOX_VIA}`)
    /* The entry: answered, still open; the act is in the timeline, not a state. */
    const entry = (got.body.open as Entry[]).find((one) => one.id === 'a')!
    expect(entry.closed).toBeNull()
    expect(askedOf(entry)?.answered).toBe('Answered: Merge')
    expect(inbox.moves(project).map((one) => one.state)).toEqual(['attention'])
    expect(db.query<{ n: number }, []>("select count(*) as n from inbox_moves where act = 'answered'").get()!.n).toBe(1)
    /* Answered once: a second answer is refused, and nothing more is sent. */
    const again = await post('/host/inbox/answer', { project, module: ME, item: 'a', answer: 'Wait', pressed: true })
    expect(again.status).toBe(409)
    expect(stored()).toHaveLength(1)
    /* The module re-reporting the same question keeps the answer; read_inbox says so. */
    await report(ME, [asking('a')])
    expect(isAnswered(inbox.open(project)[0]!)).toBe(true)
  })

  test('answered with words: replying to the question’s message when it was one', async () => {
    await report(ME, [asking('a', {}, { replyTo: 42, choices: undefined })])
    const got = await post('/host/inbox/answer', { project, module: ME, item: 'a', answer: 'Wait until Monday', pressed: true })
    expect(got.body).toMatchObject({ ok: true })
    const [message] = stored()
    expect(message!.body).toBe('Wait until Monday')
    expect(message!.replyTo).toBe(42)
    expect(message!.answers).toBeNull()
    expect(message!.from.person).toBe(true)
    expect(message!.to).toEqual({ session: { module: ME, session: 'conv-1' } })
  })

  test('refused without the person’s press, and for what is not an answer; nothing is sent or marked', async () => {
    await report(ME, [asking('a'), { id: 'plain', state: 'attention', label: 'no question' }])
    const before = inbox.rev(project)
    expect((await post('/host/inbox/answer', { project, module: ME, item: 'a', choice: 0 })).status).toBe(403)
    expect((await post('/host/inbox/answer', { project, module: ME, item: 'a', choice: 0, pressed: 'yes' })).status).toBe(403)
    expect((await post('/host/inbox/answer', { project, module: ME, item: 'a', choice: 5, pressed: true })).status).toBe(409)
    expect((await post('/host/inbox/answer', { project, module: ME, item: 'a', answer: ' ', pressed: true })).status).toBe(409)
    expect((await post('/host/inbox/answer', { project, module: ME, item: 'plain', answer: 'Yes', pressed: true })).status).toBe(409)
    expect((await post('/host/inbox/answer', { project, module: ME, item: 'nope', answer: 'Yes', pressed: true })).status).toBe(404)
    expect((await post('/host/inbox/answer', { project, module: OTHER, item: 'a', answer: 'Yes', pressed: true })).status).toBe(404)
    expect(stored()).toEqual([])
    expect(inbox.rev(project)).toBe(before)
    expect(isAnswered(inbox.open(project).find((one) => one.id === 'a')!)).toBe(false)
  })

  test('withdrawn by its module, the entry closes as any other', async () => {
    await report(ME, [asking('a')])
    await post('/host/inbox/answer', { project, module: ME, item: 'a', choice: 1, pressed: true })
    const got = await report(ME, [])
    expect(got.body.open).toEqual([])
    const closed = inbox.all(project).find((one) => one.id === 'a')!
    expect(closed).toMatchObject({ how: 'listed' })
    expect(closed.closed).not.toBeNull()
    /* And a closed entry is answered no more. */
    expect((await post('/host/inbox/answer', { project, module: ME, item: 'a', choice: 0, pressed: true })).status).toBe(404)
  })

  test('an agent reads the question and that it was answered, and is told it is the person’s to answer', async () => {
    await report(ME, [asking('a')])
    const canvas = { id: 1, key: 'wide', name: 'Wide', project } as unknown as Parameters<typeof readInboxText>[2]
    const before = readInboxText(inbox, db, canvas, 'test', { scope: 'everywhere', earlier: 0 })
    expect(before).toContain('asks the person "Merge the branch now, or wait for review?" (choices: "Merge", "Wait")')
    expect(before).not.toContain('the person answered it')
    await post('/host/inbox/answer', { project, module: ME, item: 'a', choice: 0, pressed: true })
    expect(readInboxText(inbox, db, canvas, 'test', { scope: 'everywhere', earlier: 0 })).toContain('the person answered it')
  })

  test('an answered item’s toast is settled', async () => {
    await report(ME, [asking('a')])
    await post('/host/inbox/answer', { project, module: ME, item: 'a', choice: 0, pressed: true })
    const entry = inbox.open(project)[0]!
    const toast = { id: 7, kind: 'attention', by: 'Asker', label: 'a', place: '', count: 1, entry: { ...entry, answered: undefined }, project } as Toast
    expect(settledToasts([toast], [entry], project)).toEqual([7])
  })
})

describe('the route is the page’s alone', () => {
  const PAGE = 'http://127.0.0.1:4181'
  const SELF = own({}, 4180, [PAGE])
  const ask = (headers: Record<string, string>) =>
    refusal({ method: 'POST', pathname: '/host/inbox/answer', headers: new Headers({ host: '127.0.0.1:4180', ...headers }) }, SELF)

  test('in PAGE_ONLY: the page is let through; a module’s frame, another site and a program are not', () => {
    expect(PAGE_ONLY).toContain('/host/inbox/answer')
    const json = { 'content-type': 'application/json', 'content-length': '2' }
    expect(ask({ origin: PAGE, ...json })).toBeNull()
    for (const headers of [{ origin: 'http://127.0.0.1:4300', ...json }, { origin: 'https://example.org', ...json }, { ...json }]) {
      expect(ask(headers)?.status).toBe(403)
    }
  })
})
