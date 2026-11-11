import { describe, expect, test } from 'bun:test'
import { INBOX_NEXT_MS, PERSON_METHODS, SERVER_METHODS, serverAskSchema } from 'kehikot-module-protocol'

import { answeredFor, ANSWERED_BY_THE_SERVER, ANSWERED_BY_THE_VIEW } from '../src/host/division.ts'
import { makeAsk, type CanvasControls } from '../src/host/ask.ts'
import { DOOR_SAYS, answerInbox, readOf, type InboxDoor } from '../src/host/inboxDoor.ts'
import { addWords, chordGoes, countLook, inboxModuleOf, needingCount, pressGoes, topItems } from '../src/host/inboxBar.ts'
import { PAGE_ONLY } from '../server/guard.ts'
import { inboxColourChange, readInboxColour, writeInboxColour, INBOX_COLOUR_DEFAULT } from '../server/inboxCount.ts'
import { Database } from 'bun:sqlite'
import type { Entry } from '../src/host/inbox.ts'

/**
 * The Inbox moved into a module (protocol 2.79.0): the host keeps the record and the bar's small
 * count, answers a module's page that declares `inbox:person`, and nothing else may act for the
 * person.
 */

const entry = (id: string, state: Entry['state'], more: Partial<Entry> = {}): Entry => ({
  module: 'kehikot.asker',
  name: 'Asker',
  id,
  state,
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

describe('the bar’s count', () => {
  test('counts live attention here and in other projects, nothing else', () => {
    const here = [entry('a', 'attention'), entry('w', 'working'), entry('d', 'done'), entry('x', 'attention', { dismissed: 1_000 })]
    expect(needingCount(here)).toBe(1)
    expect(needingCount(here, [{ entries: [entry('b', 'attention')] }])).toBe(2)
  })

  test('with colour and number on: the number in the attention colour, and the count in words', () => {
    const look = countLook(3, true)
    expect(look).toEqual({ number: '3', attention: true, label: expect.stringContaining('3 need you') })
    expect(countLook(1, true).label).toContain('1 needs you')
    expect(countLook(120, true).number).toBe('99+')
  })

  test('off: the plain icon, no number and no colour, and still the count in words', () => {
    const look = countLook(3, false)
    expect(look.number).toBeNull()
    expect(look.attention).toBe(false)
    expect(look.label).toContain('3 need you')
  })

  test('the colour never comes without the number, and nothing needing is plain', () => {
    for (const [n, on] of [[0, true], [0, false], [5, true], [5, false]] as const) {
      const look = countLook(n, on)
      if (look.attention) expect(look.number).not.toBeNull()
    }
    expect(countLook(0, true)).toMatchObject({ number: null, attention: false, label: expect.stringContaining('nothing needs you') })
  })

  test('a press focuses the Inbox placed here, else opens the popover; the chord tells it, else the popover', () => {
    expect(pressGoes(true)).toBe('focus')
    expect(pressGoes(false)).toBe('popover')
    expect(chordGoes(true)).toBe('tell')
    expect(chordGoes(false)).toBe('popover')
  })

  test('the popover lists three as text: what needs you first, urgent before the rest', () => {
    const items = topItems([
      entry('w', 'working', { label: 'Building' }),
      entry('n', 'attention', { label: 'Normal', entered: 500 }),
      entry('u', 'attention', { label: 'Urgent', priority: 'urgent', entered: 900 }),
      entry('d', 'done', { label: 'Done' }),
    ])
    expect(items.map((one) => one.text)).toEqual(['Asker says · needs you: Urgent', 'Asker says · needs you: Normal', 'Asker says · working: Building'])
  })

  test('the module that shows the Inbox: a registered one by its capability, else the list’s by role, never by name', () => {
    const registered = [{ id: 'kehikot.other', name: 'Other', uses: ['activity:report'] }, { id: 'kehikot.shows', name: 'Shows', icon: 'lucide:inbox', uses: ['inbox:person'] }]
    expect(inboxModuleOf(registered)).toEqual({ id: 'kehikot.shows', name: 'Shows', icon: 'lucide:inbox', registered: true })
    const listed = [{ id: 'kehikot.listed', name: 'Listed', icon: 'lucide:inbox', role: 'inbox' }]
    expect(inboxModuleOf([registered[0]!], listed)).toEqual({ id: 'kehikot.listed', name: 'Listed', icon: 'lucide:inbox', registered: false })
    expect(inboxModuleOf([registered[0]!], [{ id: 'kehikot.x', name: 'X' }])).toBeNull()
    expect(addWords('Shows')).toBe('Add Shows to this kehikko')
  })

  test('the checkbox is kept on this machine, on by default, and the route takes only a boolean', () => {
    const db = new Database(':memory:')
    db.exec('create table settings (key text primary key, value text not null)')
    expect(readInboxColour(db)).toBe(INBOX_COLOUR_DEFAULT)
    expect(INBOX_COLOUR_DEFAULT).toBe(true)
    writeInboxColour(db, false)
    expect(readInboxColour(db)).toBe(false)
    expect(inboxColourChange({ colour: true })).toBe(true)
    expect(inboxColourChange({ colour: 'yes' })).toBeNull()
    expect(PAGE_ONLY).toContain('/host/settings')
  })
})

function door(more: Partial<InboxDoor> = {}): InboxDoor & { did: string[] } {
  const did: string[] = []
  const entries = [entry('q', 'attention', { question: { text: 'Merge?', choices: ['Yes', 'No'], to: { module: 'kehikot.asker', session: 's' } } }), entry('d', 'done')]
  return {
    did,
    entries: () => entries,
    elsewhere: () => [],
    muted: () => [{ id: 'kehikot.quiet', name: 'Quiet' }],
    earlier: () => 2,
    rev: () => 7,
    next: () => entries[0]!,
    at: () => ({ epic: null, kehikko: null }),
    names: () => ({ epic: () => null, part: () => null, kehikko: () => null }),
    projectName: () => 'Thesis',
    log: async () => ({ rows: [], more: false, total: 0 }),
    act: (what, keys) => void did.push(`act ${what} ${keys?.length ?? 0}`),
    answer: async (one, said) => {
      did.push(`answer ${one.id} ${JSON.stringify(said)}`)
      return { ok: true }
    },
    open: (one) => void did.push(`open ${one.id}`),
    use: (module, on) => void did.push(`use ${module} ${on}`),
    hasProject: (id) => id === 1,
    ...more,
  }
}

describe('the page methods', () => {
  test('are the view’s, never the server’s, and none is a server method; a server ask is refused', () => {
    for (const method of PERSON_METHODS) {
      expect((ANSWERED_BY_THE_VIEW as readonly string[]).includes(method)).toBe(true)
      expect((ANSWERED_BY_THE_SERVER as readonly string[]).includes(method)).toBe(false)
      expect((SERVER_METHODS as readonly string[]).includes(method)).toBe(false)
      expect(serverAskSchema.safeParse({ module: 'kehikot.shows', pass: 'p'.repeat(40), project: '/p', method, params: {} }).success).toBe(false)
    }
  })

  test('the greeting offers them only to a module that declares inbox:person', () => {
    expect(answeredFor(['inbox:person'])).toEqual(expect.arrayContaining([...PERSON_METHODS]))
    expect(answeredFor(['activity:report']).some((one) => one.startsWith('inbox.'))).toBe(false)
  })

  test('a module that did not declare it is refused at the canvas, and the canvas is never asked', async () => {
    let asked = 0
    const canvas = { inbox: async () => ((asked += 1), { ok: true, data: {} }) } as unknown as CanvasControls
    const ask = makeAsk('kehikot.other', canvas, (capability) => capability === 'activity:report')
    const answer = await ask('inbox.read', {}, { pressed: true })
    expect(asked).toBe(0)
    expect(answer.ok).toBe(false)
    const declared = makeAsk('kehikot.shows', canvas, (capability) => capability === 'inbox:person')
    expect((await declared('inbox.read', {}, { pressed: false })).ok).toBe(true)
    expect(asked).toBe(1)
  })

  test('read is the record in the protocol’s words, without where an answer goes', async () => {
    const answer = await answerInbox('inbox.read', {}, false, door())
    expect(answer.ok).toBe(true)
    const data = (answer as { data: ReturnType<typeof readOf> }).data
    expect(data.rev).toBe(7)
    expect(data.items.map((one) => one.id)).toEqual(['q', 'd'])
    expect(data.items[0]!.question).toEqual({ text: 'Merge?', choices: ['Yes', 'No'], answered: null })
    expect(JSON.stringify(data)).not.toContain('"session"')
    expect(data.next).toEqual({ module: 'kehikot.asker', id: 'q' })
    expect(data.muted).toEqual([{ id: 'kehikot.quiet', name: 'Quiet' }])
    expect(data.items[0]!.mutable).toBe(true)
  })

  test('seen needs no press; dismiss, forget, answer, open and use are declined without one and nothing is done', async () => {
    const d = door()
    expect(await answerInbox('inbox.act', { do: 'seen', keys: [{ module: 'kehikot.asker', id: 'd' }] }, false, d)).toMatchObject({ ok: true, data: { outcome: 'done' } })
    for (const [method, params] of [
      ['inbox.act', { do: 'dismiss', keys: [{ module: 'kehikot.asker', id: 'q' }] }],
      ['inbox.act', { do: 'forget' }],
      ['inbox.act', { do: 'seen-all' }],
      ['inbox.answer', { module: 'kehikot.asker', id: 'q', choice: 'Yes' }],
      ['inbox.open', { module: 'kehikot.asker', id: 'q' }],
      ['inbox.use', { module: 'kehikot.asker', use: false }],
    ] as const) {
      const answer = await answerInbox(method, params, false, d)
      expect(answer).toMatchObject({ ok: true, data: { outcome: 'declined', why: DOOR_SAYS.noPress } })
    }
    expect(d.did).toEqual(['act seen 1'])
  })

  test('on the person’s press each is done: the choice by its index, the place gone to, the module muted', async () => {
    const d = door()
    await answerInbox('inbox.act', { do: 'dismiss', keys: [{ module: 'kehikot.asker', id: 'q' }] }, true, d)
    expect(await answerInbox('inbox.answer', { module: 'kehikot.asker', id: 'q', choice: 'No' }, true, d)).toMatchObject({ data: { outcome: 'sent' } })
    expect(await answerInbox('inbox.answer', { module: 'kehikot.asker', id: 'q', choice: 'Maybe' }, true, d)).toMatchObject({ data: { outcome: 'declined' } })
    expect(await answerInbox('inbox.open', { module: 'kehikot.asker', id: 'q' }, true, d)).toMatchObject({ data: { outcome: 'opened' } })
    expect(await answerInbox('inbox.open', { module: 'kehikot.asker', id: 'gone' }, true, d)).toMatchObject({ data: { outcome: 'no-such-item' } })
    await answerInbox('inbox.use', { module: 'kehikot.asker', use: false }, true, d)
    expect(await answerInbox('inbox.use', { module: 'kehikko', use: false }, true, d)).toMatchObject({ data: { outcome: 'declined', why: DOOR_SAYS.muteHost } })
    expect(d.did).toEqual(['act dismiss 1', 'answer q {"choice":1}', 'open q', 'use kehikot.asker false'])
  })

  test('the host’s Next stands for a press: open of the item it named, for a while, and nothing else', async () => {
    const d = door()
    const told = { module: 'kehikot.shows', key: 'kehikot.asker\u0000q', at: 10_000 }
    expect(await answerInbox('inbox.open', { module: 'kehikot.asker', id: 'q' }, false, d, told, 10_000 + INBOX_NEXT_MS)).toMatchObject({ data: { outcome: 'opened' } })
    expect(await answerInbox('inbox.open', { module: 'kehikot.asker', id: 'q' }, false, d, told, 10_001 + INBOX_NEXT_MS)).toMatchObject({ data: { outcome: 'declined' } })
    expect(await answerInbox('inbox.open', { module: 'kehikot.asker', id: 'd' }, false, d, told, 10_000)).toMatchObject({ data: { outcome: 'declined' } })
    expect(await answerInbox('inbox.act', { do: 'dismiss', keys: [{ module: 'kehikot.asker', id: 'q' }] }, false, d, told, 10_000)).toMatchObject({ data: { outcome: 'declined' } })
    expect(d.did).toEqual(['open q'])
  })

  test('another project must be one of the person’s; malformed params are refused', async () => {
    expect(await answerInbox('inbox.act', { do: 'dismiss', keys: [{ module: 'a', id: 'b' }], project: 9 }, true, door())).toMatchObject({ data: { outcome: 'declined', why: DOOR_SAYS.noProject } })
    expect((await answerInbox('inbox.act', { do: 'hide' }, true, door())).ok).toBe(false)
  })
})

describe('agents', () => {
  test('no MCP tool sees, dismisses, forgets, answers or opens for the person: the door reads the Inbox only', async () => {
    const { TOOL_NAMES } = await import('../server/mcp.ts')
    const inboxTools = TOOL_NAMES.filter((one) => /inbox|seen|dismiss|forget|answer/.test(one))
    expect(inboxTools).toEqual(['read_inbox'])
  })
})
