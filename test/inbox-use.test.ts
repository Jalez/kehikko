import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityItem } from 'kehikot-module-protocol'

import { createCanvas, editCanvas, open, type Placement } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'
import { call, type Door, type Sighting } from '../server/mcp.ts'
import { Openness } from '../server/open.ts'
import { addProject } from '../server/projects.ts'
import { mayMute, mutedWords, offersInboxUse, stopWords, unmuted } from '../src/host/inboxUse.ts'

/*
 * "Use inbox": the person's switch per module, machine-wide, for whether what a module says reaches
 * their Inbox (`src/host/inboxUse.ts`, `Inbox.use`). Off keeps the record whole and changes what is
 * drawn, sounded and counted; an agent still reads it, marked "(muted by the person)".
 */

const item = (id: string, state: ActivityItem['state'] = 'attention', more: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  state,
  label: id,
  since: 5,
  ...more,
})

describe('the store', () => {
  let db: Database
  let folders: string[]
  let one: number
  let two: number
  let inbox: Inbox

  beforeEach(() => {
    db = open(':memory:')
    folders = [mkdtempSync(join(tmpdir(), 'kehikko-use-a-')), mkdtempSync(join(tmpdir(), 'kehikko-use-b-'))]
    const a = addProject(db, folders[0]!, 'a')
    const b = addProject(db, folders[1]!, 'b')
    if (!a.ok || !b.ok) throw new Error('no project')
    one = a.project.id
    two = b.project.id
    inbox = new Inbox(db)
  })
  afterEach(() => {
    db.close()
    for (const folder of folders) rmSync(folder, { recursive: true, force: true })
  })

  test('on by default; off is stored per module, for every project, and back on removes it', () => {
    expect(inbox.muted()).toEqual([])
    expect(inbox.snapshot(one).muted).toEqual([])
    expect(inbox.use('kehikot.one', false).changed).toBe(true)
    expect(inbox.muted()).toEqual(['kehikot.one'])
    expect(inbox.snapshot(one).muted).toEqual(['kehikot.one'])
    expect(inbox.snapshot(two).muted).toEqual(['kehikot.one'])
    /* Kept across a reopening of the same database. */
    expect(new Inbox(db).muted()).toEqual(['kehikot.one'])
    expect(inbox.use('kehikot.one', true).changed).toBe(true)
    expect(inbox.muted()).toEqual([])
  })

  test('a switch moves every project’s revision; the same switch again moves none', () => {
    const before = [inbox.rev(one), inbox.rev(two)]
    const out = inbox.use('kehikot.one', false)
    expect(out.revs.map((r) => r.project).sort()).toEqual([one, two].sort())
    expect([inbox.rev(one), inbox.rev(two)]).toEqual([before[0]! + 1, before[1]! + 1])
    const again = inbox.use('kehikot.one', false)
    expect(again).toEqual({ changed: false, revs: [] })
    expect([inbox.rev(one), inbox.rev(two)]).toEqual([before[0]! + 1, before[1]! + 1])
  })

  test('a muted module’s reports are still kept, so turning it back on shows what it says now', () => {
    inbox.report(one, 'kehikot.one', 'One', [item('a')])
    inbox.use('kehikot.one', false)
    inbox.report(one, 'kehikot.one', 'One', [item('b', 'done')])
    expect(inbox.open(one).map((e) => [e.id, e.state])).toEqual([['b', 'done']])
    inbox.use('kehikot.one', true)
    expect(inbox.snapshot(one).open.map((e) => e.id)).toEqual(['b'])
  })

  test('the Earlier count and the log leave a muted module out', () => {
    inbox.report(one, 'kehikot.one', 'One', [item('a')])
    inbox.report(one, 'kehikot.one', 'One', [])
    inbox.report(one, 'kehikot.two', 'Two', [item('b')])
    inbox.report(one, 'kehikot.two', 'Two', [])
    expect(inbox.snapshot(one).earlier).toBe(2)
    inbox.use('kehikot.one', false)
    expect(inbox.snapshot(one).earlier).toBe(1)
    expect(inbox.log(one, null, 0, 20).rows.every((row) => row.module === 'kehikot.two')).toBe(true)
    inbox.use('kehikot.one', true)
    expect(inbox.snapshot(one).earlier).toBe(2)
  })

  test('the route: one module and a boolean, every project told it changed', async () => {
    const told: [number, number][] = []
    const desk = inboxDesk({ inbox, pathOf: (id) => (id === one ? folders[0] : id === two ? folders[1] : undefined), changed: (p, r) => told.push([p, r]) })
    const post = async (body: unknown) => {
      const url = new URL('http://127.0.0.1:4180/host/inbox/use')
      const response = (await desk.route(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url))!
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    }
    expect((await post({ use: false })).status).toBe(400)
    expect((await post({ module: 'kehikot.one', use: 'no' })).status).toBe(400)
    const off = await post({ module: 'kehikot.one', use: false })
    expect(off.body).toEqual({ ok: true, changed: true, muted: ['kehikot.one'] })
    expect(told.map(([p]) => p).sort()).toEqual([one, two].sort())
    const read = await desk.route(new Request(`http://127.0.0.1:4180/host/inbox?project=${one}`), new URL(`http://127.0.0.1:4180/host/inbox?project=${one}`))
    expect(((await read!.json()) as { muted: string[] }).muted).toEqual(['kehikot.one'])
    expect((await post({ module: 'kehikot.one', use: true })).body).toEqual({ ok: true, changed: true, muted: [] })
  })

  test('read_canvas and read_inbox still say what is muted, and say it is', async () => {
    const openness = new Openness()
    const made = createCanvas(db, 'the wire', one)
    editCanvas(db, made.id, { placements: [{ i: 'kehikot.one', x: 0, y: 0, w: 6, h: 10, wish: 10 }] as Placement[] })
    const seen: Sighting[] = [{ id: 'kehikot.one', name: 'One', condition: 'ready' }]
    const door = (): Door => ({
      db,
      which: () => openness.open(),
      watched: () => openness.every(),
      wake: () => {},
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      inbox,
      seen: async () => seen,
    })
    inbox.report(one, 'kehikot.one', 'One', [item('waits', 'attention', { label: 'Wants an answer' })])
    inbox.report(one, 'kehikot.two', 'Two', [item('other', 'attention', { label: 'Also here' })])
    inbox.use('kehikot.one', false)
    const text = (await call('read_inbox', { kehikko: made.id, scope: 'everywhere' }, door())).text
    expect(text).toContain('Muted by the person: "One"')
    expect(text.split('\n').find((line) => line.includes('Wants an answer'))).toContain('(muted by the person)')
    expect(text.split('\n').find((line) => line.includes('Also here'))).not.toContain('muted')
    const canvas = (await call('read_canvas', { kehikko: made.id }, door())).text
    expect(canvas.split('\n').find((line) => line.includes('Wants an answer'))).toContain('(muted by the person)')
  })
})

describe('the rules', () => {
  test('unmuted leaves out the muted modules, and hands back the same list when nothing is muted', () => {
    const list = [{ module: 'kehikot.one' }, { module: 'kehikot.two' }]
    expect(unmuted(list, new Set())).toBe(list)
    expect(unmuted(list, new Set(['kehikot.three']))).toBe(list)
    expect(unmuted(list, new Set(['kehikot.one']))).toEqual([{ module: 'kehikot.two' }])
  })

  test('the row is offered to a module that can say something to the Inbox, or one muted now', () => {
    expect(offersInboxUse({ declares: { uses: ['activity:report'] } }, false)).toBe(true)
    expect(offersInboxUse({ declares: { uses: ['events:emit'] } }, false)).toBe(true)
    expect(offersInboxUse({ declares: { uses: ['state:keep'] } }, false)).toBe(false)
    expect(offersInboxUse(undefined, false)).toBe(false)
    expect(offersInboxUse(undefined, true)).toBe(true)
  })

  test('the host’s own lists are never muted from the Inbox; the words say what happens', () => {
    expect(mayMute('kehikko')).toBe(false)
    expect(mayMute('kehikko.trackers')).toBe(false)
    expect(mayMute('kehikot.one')).toBe(true)
    expect(mutedWords(1)).toBe('1 module muted')
    expect(mutedWords(3)).toBe('3 modules muted')
    expect(stopWords('One')).toBe('Stop showing One here')
  })
})
