import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { open } from '../server/canvases.ts'
import { mergeLists, mergeRetired } from '../server/officialSource.ts'
import { OFFICIAL, RETIRED, readOfficial, readRetired } from '../server/official.ts'
import { noteOf, retiredItem, retiredOffer, retiredStill, retiredWords, RETIRED_INBOX_MODULE, RETIRED_ITEM } from '../server/retired.ts'
import { addProject } from '../server/projects.ts'
import { Inbox } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'

const LIST = [
  { id: 'kehikot.gone', name: 'Gone', says: 'the Inbox does its job.' },
  { id: 'kehikot.other', name: 'Other', says: 'something else does.' },
]

describe('a retired module is flagged wherever it lives', () => {
  const retired = readRetired({ retired: [{ id: 'kehikot.gone', name: 'Gone', says: 'Replaced by the Inbox module.', replacedBy: 'kehikot.next' }] })

  test('the note names the successor from the list, only when its name is known', () => {
    expect(noteOf(retired, 'kehikot.gone', () => 'Next')).toEqual({ says: 'Replaced by the Inbox module.', successor: { id: 'kehikot.next', name: 'Next' } })
    expect(noteOf(retired, 'kehikot.gone', () => null)).toEqual({ says: 'Replaced by the Inbox module.' })
    expect(noteOf(retired, 'kehikot.other', () => 'Next')).toBeNull()
  })

})

describe('the retired list', () => {
  test('reads leniently: no key is none, a bad entry is dropped alone, a list without the key still parses', () => {
    expect(readRetired({ modules: [] })).toEqual([])
    expect(readRetired({ retired: 'x' })).toEqual([])
    expect(readRetired({ retired: [LIST[0], { id: 5 }, { id: 'kehikot.a', name: 'A' }, LIST[0]] })).toEqual([LIST[0]!])
    expect(readOfficial({ modules: [], retired: [{ anything: true }] })).toEqual([])
  })

  test('a retired module is not offered, and one the list still names is not retired', () => {
    const entry = (idOf: string) => ({ ...OFFICIAL[0]!, id: idOf })
    expect(mergeLists([entry('kehikot.gone'), entry('kehikot.stays')], [entry('kehikot.gone')], readRetired({ retired: LIST })).map((one) => one.id)).toEqual(['kehikot.stays'])
    expect(mergeRetired([LIST[0]!], null, [entry('kehikot.gone')])).toEqual([])
  })

  test('the built-in list retires three modules and no longer offers them', () => {
    expect(RETIRED.map((one) => one.id).sort()).toEqual(['kehikot.atlas', 'kehikot.notifications', 'kehikot.tests'])
    expect(OFFICIAL.some((one) => RETIRED.some((gone) => gone.id === one.id))).toBe(false)
  })
})

describe('the built-in list', () => {
  test('Replaced-by wording and the says text are the list’s', () => {
    const one = RETIRED.find((entry) => entry.id === 'kehikot.notifications')!
    expect(one.says).toBe('Replaced by the Inbox module.')
    expect(one.replacedBy).toBe('kehikot.inbox')
    expect(OFFICIAL.some((entry) => entry.id === one.replacedBy)).toBe(true)
  })
})

describe('the retired modules still installed: one Inbox item, one press to uninstall them all', () => {
  let db: Database
  let folder: string
  let project: number
  let inbox: Inbox
  let registered: Set<string>
  let uninstalled: string[]
  let told: string[]
  let offer: ReturnType<typeof retiredOffer>
  let desk: ReturnType<typeof inboxDesk>
  const retired = readRetired({
    retired: [
      { id: 'kehikot.notifications', name: 'Notifications', says: 'Replaced by the Inbox module.' },
      { id: 'kehikot.atlas', name: 'Atlas', says: 'Replaced.' },
      { id: 'kehikot.tests', name: 'Tests', says: 'Replaced.' },
    ],
  })

  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-retired-offer-'))
    const added = addProject(db, folder, 'p')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
    inbox = new Inbox(db)
    registered = new Set(['kehikot.notifications', 'kehikot.atlas', 'kehikot.tests', 'kehikot.paper'])
    uninstalled = []
    told = []
    offer = retiredOffer({
      inbox,
      where: () => [project],
      changed: () => undefined,
      still: async () => retiredStill(retired, [...registered], () => null),
      uninstall: async (id) => {
        uninstalled.push(id)
        registered.delete(id)
        return { ok: true, id, name: id, removed: [], left: [], freed: 0, said: `${id} is uninstalled.` }
      },
      tell: (line) => void told.push(line),
    })
    desk = inboxDesk({
      inbox,
      pathOf: (id) => (id === project ? folder : undefined),
      changed: () => undefined,
      hostAnswer: (_project, entry, text) => (entry.module === RETIRED_INBOX_MODULE && entry.id === RETIRED_ITEM ? offer.answer(text) : null),
    })
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  const answer = async (choice: number) => {
    const url = new URL('/host/inbox/answer', 'http://127.0.0.1:4180')
    const body = { project, module: RETIRED_INBOX_MODULE, item: RETIRED_ITEM, choice, pressed: true }
    const response = await desk.route(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url)
    return { status: response!.status, body: (await response!.json()) as Record<string, unknown> }
  }

  test('the words name them, sorted, and ask once', () => {
    expect(retiredWords(['Atlas', 'Notifications', 'Tests']).label).toBe('Atlas, Notifications and Tests are retired and still installed. Uninstall them?')
    expect(retiredWords(['Atlas'])).toEqual({ label: 'Atlas is retired and still installed. Uninstall it?', yes: 'Uninstall it', no: 'Not now' })
    expect(retiredItem(['Atlas']).question).toEqual({ text: 'Atlas is retired and still installed. Uninstall it?', choices: ['Uninstall it', 'Not now'], to: { module: RETIRED_INBOX_MODULE, session: RETIRED_ITEM } })
  })

  test('ONE item on start, with its question; nothing is removed by it', async () => {
    await offer.offer()
    await offer.offer()
    const open = inbox.open(project).filter((one) => one.module === RETIRED_INBOX_MODULE)
    expect(open).toHaveLength(1)
    expect(open[0]!.label).toBe('Atlas, Notifications and Tests are retired and still installed. Uninstall them?')
    expect(open[0]!.question?.choices).toEqual(['Uninstall them', 'Not now'])
    expect(uninstalled).toEqual([])
  })

  test('one press uninstalls every one of them, each fully, says so, and the item goes', async () => {
    await offer.offer()
    const got = await answer(0)
    expect(got.status).toBe(200)
    expect(uninstalled).toEqual(['kehikot.atlas', 'kehikot.notifications', 'kehikot.tests'])
    expect(told).toEqual(['kehikot.atlas is uninstalled.', 'kehikot.notifications is uninstalled.', 'kehikot.tests is uninstalled.'])
    expect(inbox.open(project).filter((one) => one.module === RETIRED_INBOX_MODULE)).toEqual([])
    expect(registered.has('kehikot.paper')).toBe(true)
  })

  test('“Not now” removes nothing and is not asked again until the app starts again', async () => {
    await offer.offer()
    expect((await answer(1)).status).toBe(200)
    expect(uninstalled).toEqual([])
    await offer.offer()
    expect(inbox.open(project).filter((one) => one.module === RETIRED_INBOX_MODULE)).toEqual([])
  })

  test('none installed: no item', async () => {
    registered = new Set(['kehikot.paper'])
    await offer.offer()
    expect(inbox.open(project)).toEqual([])
  })
})
