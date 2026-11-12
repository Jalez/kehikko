import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { INBOX_ITEMS_MAX, LIMITS, inboxLogResult, inboxReadResult } from 'kehikot-module-protocol'

import { answerInbox, clip, fitChoices, readOf, whole, type InboxDoor } from '../src/host/inboxDoor.ts'
import type { Entry, LogRow } from '../src/host/inbox.ts'

/**
 * `inbox.read` (and every Inbox answer) is read by the module with the protocol's own schema, which
 * refuses the WHOLE answer for one field over its limit. These hold the host's answer to that
 * schema with the data a real record holds: many choices, long words,
 * odd times, many projects.
 */

const entry = (id: string, more: Partial<Entry> = {}): Entry => ({
  module: 'kehikot.asker',
  name: 'Asker',
  id,
  state: 'attention',
  label: id,
  priority: 'normal',
  refs: [],
  entered: 1_000,
  opened: 1_000,
  closed: null,
  how: null,
  seen: null,
  dismissed: null,
  origin: 'activity',
  ...more,
})

const many = (n: number) => Array.from({ length: n }, (_, i) => `Choice ${i}`)
const asking = entry('q-many', { question: { text: 'Which one?', choices: [...many(9), 'None of these'], to: { module: 'kehikot.asker', session: 's' } } })

function door(more: Partial<InboxDoor> = {}): InboxDoor & { ran: string[] } {
  const ran: string[] = []
  return {
    ran,
    entries: () => [],
    elsewhere: () => [],
    muted: () => [],
    earlier: () => 0,
    rev: () => 1,
    next: () => null,
    at: () => ({ epic: null, kehikko: null }),
    names: () => ({ epic: () => null, part: () => null, kehikko: () => null }),
    projectName: () => 'Thesis',
    log: async () => ({ rows: [], more: false, total: 0 }),
    act: () => {},
    answer: async () => ({ ok: true }),
    open: () => {},
    use: () => {},
    hasProject: () => true,
    ...more,
  }
}

const read = (d: InboxDoor) => {
  const got = inboxReadResult.safeParse(readOf(d))
  if (!got.success) throw new Error(JSON.stringify(got.error.issues[0]))
  return got.data
}

let warned: string[] = []
let spy: ReturnType<typeof spyOn> | null = null
beforeEach(() => {
  warned = []
  spy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warned.push(args.join(' ')))
})
afterEach(() => spy?.mockRestore())

describe('inbox.read fits the protocol', () => {
  test('a tracker notice of a ref no epic names: "Tracker" by-line, and "Not in any epic · <host>" for its place', () => {
    const notice = entry('gitlab:gitlab.example.org/group/project!4721', { module: 'kehikko.trackers', name: '', label: '!4721 · changes requested by mona' })
    const item = read(door({ entries: () => [notice] })).items[0]!
    expect(item.by).toBe('Tracker')
    expect(item.where).toBe('Not in any epic · gitlab.example.org')
    const inEpic = read(door({ entries: () => [{ ...notice, place: { epic: 'auth' } }], names: () => ({ epic: () => 'Auth', part: () => null, kehikko: () => null }) })).items[0]!
    expect(inEpic.where).toBe('Auth')
  })

  test('a question with more choices than the protocol carries: at most six, the last one kept', () => {
    const choices = read(door({ entries: () => [asking] })).items[0]!.question!.choices
    expect(choices.length).toBe(LIMITS.MESSAGE_CHOICES)
    expect(choices[0]).toBe('Choice 0')
    expect(choices.at(-1)).toBe('None of these')
  })

  test('a module’s question still takes a free-text answer', async () => {
    const said: unknown[] = []
    const d = door({ entries: () => [asking], answer: async (_entry, one) => (said.push(one), { ok: true }) })
    expect(await answerInbox('inbox.answer', { module: 'kehikot.asker', id: 'q-many', answer: 'what are you working on?' }, true, d)).toMatchObject({ ok: true, data: { outcome: 'sent' } })
    expect(said).toEqual([{ answer: 'what are you working on?' }])
  })

  test('a module’s question: text, choices and answer clipped; an answer by a clipped choice goes by its index', async () => {
    const long = 'c'.repeat(100)
    const question = { text: 'q'.repeat(1500), choices: ['a', 'b', 'c', 'd', 'e', 'f', 'g', long], to: { module: 'kehikot.asker', session: 's' } }
    const said: string[] = []
    const d = door({
      entries: () => [entry('q', { question, answered: { entered: 1_000, at: 1_001, text: 'x'.repeat(3000) } })],
      answer: async (_one, how) => (said.push(JSON.stringify(how)), { ok: true }),
    })
    const q = read(d).items[0]!.question!
    expect(q.text.length).toBe(LIMITS.ACTIVITY_QUESTION)
    expect(q.answered!.length).toBe(LIMITS.MESSAGE_BODY)
    expect(q.choices).toEqual(['a', 'b', 'c', 'd', 'e', clip(long, LIMITS.MESSAGE_CHOICE)])
    await answerInbox('inbox.answer', { module: 'kehikot.asker', id: 'q', choice: q.choices[5] }, true, d)
    await answerInbox('inbox.answer', { module: 'kehikot.asker', id: 'q', choice: 'b' }, true, d)
    expect(said).toEqual(['{"choice":7}', '{"choice":1}'])
  })

  test('long by, says, label, detail and where are clipped to their limits', () => {
    const data = read(
      door({
        entries: () => [
          entry('long', {
            name: 'N'.repeat(300),
            label: 'L'.repeat(500),
            detail: 'D'.repeat(500),
            named: { id: 'ev', says: 'S'.repeat(300) },
            place: { epic: 'p'.repeat(500) },
          }),
        ],
        names: () => ({ epic: (slug: string) => slug, part: () => null, kehikko: () => null }),
      }),
    )
    const item = data.items[0]!
    expect(item.label.length).toBe(LIMITS.ACTIVITY_LABEL)
    expect(item.detail!.length).toBe(LIMITS.ACTIVITY_DETAIL)
    expect(item.says!.length).toBeLessThanOrEqual(LIMITS.TITLE)
    expect(item.by.length).toBeLessThanOrEqual(LIMITS.TITLE)
    expect(item.where.length).toBeLessThanOrEqual(LIMITS.TITLE * 2)
  })

  test('times are whole ms, never negative: a float, a negative and a NaN', () => {
    const data = read(
      door({
        entries: () => [entry('f', { entered: 1_794_404_485_651.75 }), entry('n', { entered: -5 }), entry('x', { entered: Number.NaN })],
        rev: () => 3.5,
        earlier: () => -1,
      }),
    )
    expect(data.items.map((one) => one.entered)).toEqual([1_794_404_485_651, 0, 0])
    expect(data.rev).toBe(3)
    expect(data.earlier).toBe(0)
    expect(whole(2.9)).toBe(2)
  })

  test('more than 500 items and 50 projects are capped; a project with no positive whole id is left out, said once', () => {
    const many = Array.from({ length: INBOX_ITEMS_MAX + 20 }, (_, i) => entry(`i${i}`))
    const projects = [
      { project: { id: 'uuid-like' as unknown as number, name: 'Bad' }, entries: [entry('b')] },
      { project: { id: 0, name: 'Zero' }, entries: [entry('z')] },
      ...Array.from({ length: 60 }, (_, i) => ({ project: { id: i + 1, name: `P${i}`, path: `/p/${i}` }, entries: many })),
    ]
    const data = read(door({ entries: () => many, elsewhere: () => projects }))
    expect(data.items.length).toBe(INBOX_ITEMS_MAX)
    expect(data.elsewhere.length).toBe(50)
    expect(data.elsewhere[0]!.project).toEqual({ id: 1, name: 'P0' })
    expect(data.elsewhere[0]!.items.length).toBe(INBOX_ITEMS_MAX)
    expect(warned.filter((one) => one.includes('elsewhere.project.id')).length).toBe(2)
  })

  test('an item that cannot be repaired (a state outside the protocol) is left out with one line naming the field', () => {
    const data = read(door({ entries: () => [entry('ok'), entry('odd', { state: 'paused' as Entry['state'] }), entry('', { state: 'attention' })] }))
    expect(data.items.map((one) => one.id)).toEqual(['ok'])
    expect(warned.some((one) => one.includes('kehikot.asker/odd') && one.includes('state'))).toBe(true)
    expect(warned.some((one) => one.includes('id'))).toBe(true)
  })

  test('muted names clipped, and a Next the protocol cannot name is none', () => {
    const data = read(door({ muted: () => [{ id: 'kehikot.q', name: 'Q'.repeat(300) }], next: () => entry('i'.repeat(200)) }))
    expect(data.muted[0]!.name.length).toBe(LIMITS.TITLE)
    expect(data.next).toBeNull()
  })

  test('fitChoices keeps the first and the last, never a duplicate', () => {
    expect(fitChoices(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], (one) => one).map((one) => one.label)).toEqual(['a', 'b', 'c', 'd', 'e', 'h'])
    expect(fitChoices(['a', 'a', 'b'], (one) => one).map((one) => one.label)).toEqual(['a', 'b'])
  })
})

describe('every Inbox answer fits the protocol', () => {
  test('inbox.log: rows clipped and whole, a page at most, an unrepairable row left out', async () => {
    const row = (id: string, more: Partial<LogRow> = {}): LogRow => ({
      key: `k${id}`,
      kind: 'past',
      module: 'kehikot.asker',
      name: 'Asker',
      id,
      state: 'done',
      label: 'L'.repeat(400),
      priority: 'normal',
      refs: [],
      at: 1_000.5,
      how: null,
      origin: 'activity',
      ...more,
    })
    const rows = [row('a'), row('bad', { priority: 'whenever' as LogRow['priority'] }), ...Array.from({ length: 120 }, (_, i) => row(`r${i}`))]
    const answer = await answerInbox('inbox.log', {}, false, door({ log: async () => ({ rows, more: true, total: 122.2 }) }))
    expect(answer.ok).toBe(true)
    const data = inboxLogResult.parse((answer as { data: unknown }).data)
    expect(data.rows.length).toBe(100)
    expect(data.rows[0]!.label.length).toBe(LIMITS.ACTIVITY_LABEL)
    expect(data.rows[0]!.at).toBe(1_000)
    expect(data.rows.some((one) => one.id === 'bad')).toBe(false)
    expect(data.total).toBe(122)
  })

  test('a long refusal from the door is clipped to the protocol’s reason', async () => {
    const question = { text: 'Merge?', choices: ['Yes'], to: { module: 'kehikot.asker', session: 's' } }
    const d = door({ entries: () => [entry('q', { question })], answer: async () => ({ ok: false, why: 'w'.repeat(1000) }) })
    const answer = await answerInbox('inbox.answer', { module: 'kehikot.asker', id: 'q', choice: 'Yes' }, true, d)
    expect((answer as { data: { why: string } }).data.why.length).toBe(LIMITS.REASON)
  })

  test('the inbox.read answer itself is checked before it goes', async () => {
    const answer = await answerInbox('inbox.read', {}, false, door({ entries: () => [asking] }))
    expect(answer.ok).toBe(true)
    expect(inboxReadResult.safeParse((answer as { data: unknown }).data).success).toBe(true)
  })
})
