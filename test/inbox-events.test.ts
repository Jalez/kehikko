import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActivityItem, InboxEvent } from 'kehikot-module-protocol'

import { createCanvas, open } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { inboxDesk } from '../server/inboxRoutes.ts'
import { readInboxText } from '../server/inboxText.ts'
import { addProject } from '../server/projects.ts'
import {
  Burst,
  DEFAULT_CHIME,
  chimeFor,
  chimeFrom,
  declaredSound,
  eventDefault,
  chimePatched,
  eventSoundFor,
  presetOf,
  withoutFile,
  type ChimeSettings,
  type Kind,
} from '../src/host/chime.ts'
import { applyList, type Entry } from '../src/host/inbox.ts'
import { toastOf, toastWord, type Arrival } from '../src/host/toasts.ts'

/*
 * Named Inbox events (protocol 2.31.0): an item a module names as one of its
 * declared events — "Research complete", a `done` — keeps its state, carries the
 * event's words, can have a sound of its own, and is said by name in the toast
 * and to an agent.
 */

const RESEARCH: InboxEvent = { id: 'research-complete', says: 'Research complete', state: 'done' }
const item = (id: string, state: ActivityItem['state'], more: Partial<ActivityItem> = {}): ActivityItem => ({ id, state, label: `Label ${id}`, ...more })

describe('an item’s event is held to the manifest', () => {
  test('a declared event for the item’s state is carried by name', () => {
    const out = applyList([], 'kehikot.claude', 'Claude', [item('s', 'done', { event: 'research-complete' })], { now: 1, events: [RESEARCH] })
    expect(out.puts[0]!.named).toEqual({ id: 'research-complete', says: 'Research complete' })
    expect(out.puts[0]!.state).toBe('done')
  })

  test('an undeclared event is ignored, and the item is an ordinary item', () => {
    const undeclared = applyList([], 'kehikot.claude', 'Claude', [item('s', 'done', { event: 'build-green' })], { now: 1, events: [RESEARCH] })
    expect(undeclared.puts[0]!.named).toBeUndefined()
    const none = applyList([], 'kehikot.claude', 'Claude', [item('s', 'done', { event: 'research-complete' })], { now: 1 })
    expect(none.puts[0]!.named).toBeUndefined()
    const wrongState = applyList([], 'kehikot.claude', 'Claude', [item('s', 'attention', { event: 'research-complete' })], { now: 1, events: [RESEARCH] })
    expect(wrongState.puts[0]!.named).toBeUndefined()
  })

  test('a list that adds the event to a held item writes it again', () => {
    const first = applyList([], 'm', 'M', [item('s', 'done', { since: 5 })], { now: 1, events: [RESEARCH] })
    const again = applyList(first.puts, 'm', 'M', [item('s', 'done', { since: 5, event: 'research-complete' })], { now: 2, events: [RESEARCH] })
    expect(again.puts.map((one) => one.named?.says)).toEqual(['Research complete'])
    expect(again.moves).toEqual([])
  })
})

describe('the store and the routes', () => {
  let db: Database
  let folder: string
  let project: number
  beforeEach(() => {
    db = open(':memory:')
    folder = mkdtempSync(join(tmpdir(), 'kehikko-inbox-events-'))
    const added = addProject(db, folder, 'a project')
    if (!added.ok) throw new Error(added.why)
    project = added.project.id
  })
  afterEach(() => {
    db.close()
    rmSync(folder, { recursive: true, force: true })
  })

  test('the event is kept and read back', () => {
    const inbox = new Inbox(db)
    inbox.report(project, 'kehikot.claude', 'Claude', [item('s', 'done', { event: 'research-complete' })], { events: [RESEARCH] })
    expect(new Inbox(db).open(project)[0]!.named).toEqual({ id: 'research-complete', says: 'Research complete' })
  })

  test('a report is held to the events of the module that sent it', async () => {
    const inbox = new Inbox(db)
    const desk = inboxDesk({
      inbox,
      pathOf: (id) => (id === project ? folder : undefined),
      eventsOf: (module) => (module === 'kehikot.claude' ? [RESEARCH] : undefined),
      changed: () => undefined,
    })
    const send = async (body: unknown) => {
      const url = new URL('http://127.0.0.1:4180/host/inbox/report')
      const response = await desk.route(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url)
      return (await response!.json()) as { open: Entry[] }
    }
    const claude = await send({ project, module: 'kehikot.claude', name: 'Claude', items: [item('a', 'done', { event: 'research-complete' })] })
    expect(claude.open[0]!.named?.says).toBe('Research complete')
    /* Another module naming the same id has not declared it. */
    const other = await send({ project, module: 'kehikot.other', name: 'Other', items: [item('b', 'done', { event: 'research-complete' })] })
    expect(other.open.find((one) => one.module === 'kehikot.other')!.named).toBeUndefined()
  })

  test('read_inbox says the event', () => {
    const inbox = new Inbox(db)
    inbox.report(project, 'kehikot.claude', 'Claude', [item('s', 'done', { label: 'Protocol audit', event: 'research-complete' })], { events: [RESEARCH] })
    const canvas = createCanvas(db, 'the wire', project)
    const text = readInboxText(inbox, db, canvas, 'open', { scope: 'everywhere', earlier: 0 })
    expect(text).toContain('"Claude" says "Protocol audit" — finished (event research-complete: "Research complete")')
  })
})

describe('an event’s own sound', () => {
  const file = { id: '0123456789abcdef', name: 'ding.wav', ext: 'wav', bytes: 10, seconds: 1 }
  const settings = (more: Partial<ChimeSettings> = {}): ChimeSettings => ({ ...DEFAULT_CHIME, files: [file], ...more })

  test('the host ships a generic Answer chime; an event plays it when its manifest names it (protocol 2.33.0), from any module', () => {
    expect(presetOf('answer')?.name).toBe('Answer')
    expect(declaredSound('answer')).toEqual({ type: 'preset', id: 'answer' })
    expect(chimeFor(settings(), 'done', 'kehikot.someagent', 'research-complete', 'answer')).toEqual({ sound: { type: 'preset', id: 'answer' }, asWritten: true })
    expect(chimeFor(settings(), 'done', 'kehikot.other', 'build-green', 'bell')).toEqual({ sound: { type: 'preset', id: 'bell' }, asWritten: true })
    expect(eventDefault('answer')).toEqual({ type: 'preset', id: 'answer' })
  })

  test('the host keeps no table of event ids: an event whose manifest names no sound plays its kind', () => {
    const kindSound = { sound: DEFAULT_CHIME.sounds.done, asWritten: false }
    expect(chimeFor(settings(), 'done', 'kehikot.someagent', 'research-complete')).toEqual(kindSound)
    expect(eventDefault()).toEqual({ type: 'kind' })
    /* A key this host has no sound for is the kind's too; a renamed one is read as its new id. */
    expect(declaredSound('chimes2')).toBeNull()
    expect(chimeFor(settings(), 'done', 'kehikot.someagent', 'research-complete', 'chimes2')).toEqual(kindSound)
    expect(declaredSound('research')).toEqual({ type: 'preset', id: 'answer' })
  })

  test('what the person chose wins over what the manifest names', () => {
    const chosen = settings({ events: { 'kehikot.someagent': { 'research-complete': { type: 'kind' } } } })
    expect(chimeFor(chosen, 'done', 'kehikot.someagent', 'research-complete', 'answer')).toEqual({ sound: DEFAULT_CHIME.sounds.done, asWritten: false })
  })

  test('a sound saved under the chime’s former id, research, is read as Answer', () => {
    expect(presetOf('research')?.id).toBe('answer')
    expect(chimeFrom({ events: { 'kehikot.claude': { 'research-complete': { type: 'preset', id: 'research' } } } }).events).toEqual({
      'kehikot.claude': { 'research-complete': { type: 'preset', id: 'answer' } },
    })
  })

  test('the event’s chosen sound is chosen over the kind’s and the module’s', () => {
    const chosen = settings({
      modules: { 'kehikot.claude': { done: { type: 'preset', id: 'bell' } } },
      events: { 'kehikot.claude': { 'research-complete': { type: 'file', id: file.id } } },
    })
    expect(chimeFor(chosen, 'done', 'kehikot.claude', 'research-complete')).toEqual({ sound: { type: 'file', id: file.id }, asWritten: true })
  })

  test('falls back to the kind: no event, an event with nothing set, "Same as", a file that is gone', () => {
    const kindSound = { sound: DEFAULT_CHIME.sounds.done, asWritten: false }
    expect(chimeFor(settings(), 'done', 'kehikot.claude')).toEqual(kindSound)
    expect(chimeFor(settings(), 'done', 'kehikot.claude', 'build-green')).toEqual(kindSound)
    expect(chimeFor(settings({ events: { 'kehikot.claude': { 'research-complete': { type: 'kind' } } } }), 'done', 'kehikot.claude', 'research-complete')).toEqual(kindSound)
    expect(eventSoundFor(settings({ files: [], events: { 'kehikot.claude': { 'research-complete': { type: 'file', id: file.id } } } }), 'kehikot.claude', 'research-complete')).toBeNull()
    /* The module's own sound for the kind is the fallback when it has one. */
    const moduleDone = settings({ modules: { 'kehikot.claude': { done: { type: 'preset', id: 'bell' } } } })
    expect(chimeFor(moduleDone, 'done', 'kehikot.claude', 'build-green')).toEqual({ sound: { type: 'preset', id: 'bell' }, asWritten: false })
  })

  test('kept, patched and cleaned like the module sounds', () => {
    const patched = chimePatched(settings(), { events: { 'kehikot.claude': { 'research-complete': { type: 'preset', id: 'bell' } } } })!
    expect(patched.events).toEqual({ 'kehikot.claude': { 'research-complete': { type: 'preset', id: 'bell' } } })
    expect(chimeFrom(JSON.parse(JSON.stringify(patched))).events).toEqual(patched.events)
    expect(chimePatched(patched, { events: { 'kehikot.claude': { 'research-complete': null } } })!.events).toEqual({})
    expect(chimePatched(settings(), { events: { 'kehikot.claude': { 'research-complete': { type: 'kind' } } } })!.events['kehikot.claude']).toEqual({ 'research-complete': { type: 'kind' } })
    expect(chimePatched(settings(), { events: { 'kehikot.claude': { 'Research Complete': { type: 'kind' } } } })).toBeNull()
    expect(chimePatched(settings(), { events: { 'kehikot.claude': { 'research-complete': { type: 'preset', id: 'nope' } } } })).toBeNull()
    const withFile = chimePatched(settings(), { events: { 'kehikot.claude': { 'research-complete': { type: 'file', id: file.id } } } })!
    const removed = withoutFile(withFile, file.id)
    expect(removed.settings.events).toEqual({})
    expect(removed.modules).toEqual(['kehikot.claude'])
    expect(chimeFrom({ events: { 'kehikot.claude': { 'research-complete': { type: 'file', id: 'gone00000000000a' } } } }).events).toEqual({})
  })

  test('a burst of equally urgent arrivals plays the named one', () => {
    const played: [Kind, string | undefined, string | undefined][] = []
    let run: (() => void) | null = null
    const burst = new Burst((kind, module, event) => played.push([kind, module, event]), { now: () => 0, after: (fn) => (run = fn) })
    burst.offer('done', 'kehikot.tests')
    burst.offer('done', 'kehikot.claude', 'research-complete')
    burst.offer('done', 'kehikot.tests')
    run!()
    expect(played).toEqual([['done', 'kehikot.claude', 'research-complete']])
  })
})

describe('the toast says the event', () => {
  const entry = (id: string, more: Partial<Entry> = {}): Entry => ({
    module: 'kehikot.claude', name: 'Claude', id, state: 'done', label: id, priority: 'normal', refs: [],
    entered: 1, opened: 1, closed: null, how: null, seen: null, dismissed: null, origin: 'activity', ...more,
  })
  const arrival = (e: Entry): Arrival => ({ entry: e, project: 1, by: 'Claude', place: 'the project' })

  test('its words in place of the kind’s', () => {
    const toast = toastOf(1, [arrival(entry('s', { label: 'Protocol audit', named: { id: 'research-complete', says: 'Research complete' } }))])!
    expect(toast.says).toBe('Research complete')
    expect(toast.kind).toBe('done')
    expect(toastWord(toast)).toBe('Research complete')
  })

  test('no event: the kind’s word', () => {
    expect(toastWord(toastOf(1, [arrival(entry('s'))])!)).toBe('Finished')
  })

  test('a burst headed by the named one of equals', () => {
    const toast = toastOf(1, [arrival(entry('a')), arrival(entry('b', { named: { id: 'research-complete', says: 'Research complete' } }))])!
    expect(toast.count).toBe(2)
    expect(toast.says).toBe('Research complete')
  })
})
