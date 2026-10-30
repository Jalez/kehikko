import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, deleteCanvas, listCanvases, open } from '../server/canvases.ts'
import { epicsDir } from '../server/hostData.ts'
import { call, type Door } from '../server/mcp.ts'
import { editPinnedPlaces, ensurePinnedPlaces, readPinnedPlaces } from '../server/pinnedPlaces.ts'
import { addProject, forgetProject, type Project } from '../server/projects.ts'
import { planJump, sameView, type Place } from '../src/host/jump.ts'
import {
  isPinChord,
  labelOf,
  movedBy,
  movedOnto,
  normalTarget,
  pinEditSchema,
  pinnedHere,
  PINNED_MAX,
  placeOf,
  resolvePin,
  sameTarget,
  targetOf,
  type PinFacts,
  type PinTarget,
  type StoredPin,
} from '../src/host/pinnedPlaces.ts'

/*
 * Pinned places: the rules (`src/host/pinnedPlaces.ts`) and the store
 * (`server/pinnedPlaces.ts`, a table in `frame.sqlite`): add, remove, order,
 * and pins whose project, kehikko, epic or parts are gone. The DOM of the
 * menu and the Pin button is `pinned-places-dom.test.tsx`; the bar's fit at
 * narrow widths is measured on bee (`dev/header-fit.drive.mjs`).
 */

describe('the rules', () => {
  const names = { project: 'CS-DEGREE', kehikko: 'Wide', epic: 'thesis', parts: { methods: 'methods', results: 'results' } }

  test('a label reads as the breadcrumb does', () => {
    expect(labelOf({ scope: 'epic', epic: 'thesis', parts: ['methods'], kehikko: 'k1' }, names)).toBe('CS-DEGREE › thesis › methods · Wide')
    expect(labelOf({ scope: 'epic', epic: 'thesis', parts: ['methods', 'results'], kehikko: 'k1' }, names)).toBe('CS-DEGREE › thesis › methods, results · Wide')
    expect(labelOf({ scope: 'epic', epic: 'thesis', parts: [], kehikko: null }, names)).toBe('CS-DEGREE › thesis')
    expect(labelOf({ scope: 'project', epic: null, parts: [], kehikko: 'k1' }, names)).toBe('CS-DEGREE › All epics · Wide')
    expect(labelOf({ scope: 'epic', epic: null, parts: [], kehikko: 'k1' }, names)).toBe('CS-DEGREE · Wide')
    /* A name not kept is said by its id. */
    expect(labelOf({ scope: 'epic', epic: 'x', parts: ['p'], kehikko: 'k9' }, { project: 'P', kehikko: null, epic: null, parts: {} })).toBe('P › x › p · k9')
  })

  test('one spelling of a place: parts sorted and unique, none on All epics', () => {
    expect(normalTarget({ project: 1, kehikko: 'k', epic: 'e', scope: 'epic', parts: ['b', 'a', 'b'] }).parts).toEqual(['a', 'b'])
    expect(normalTarget({ project: 1, kehikko: 'k', epic: 'e', scope: 'project', parts: ['a'] })).toEqual({ project: 1, kehikko: 'k', epic: null, scope: 'project', parts: [] })
    expect(sameTarget({ project: 1, kehikko: 'k', epic: 'e', scope: 'epic', parts: ['b', 'a'] }, { project: 1, kehikko: 'k', epic: 'e', scope: 'epic', parts: ['a', 'b'] })).toBe(true)
    expect(sameTarget({ project: 1, kehikko: 'k', epic: 'e', scope: 'epic', parts: [] }, { project: 2, kehikko: 'k', epic: 'e', scope: 'epic', parts: [] })).toBe(false)
  })

  test('the place on screen and a pin are the same place, both ways', () => {
    const here: Place = { project: 3, kehikko: 'k', epic: 'e', parts: ['b', 'a'], step: 4 }
    const target = targetOf(here)!
    expect(target).toEqual({ project: 3, kehikko: 'k', epic: 'e', scope: 'epic', parts: ['a', 'b'] })
    expect(sameView(placeOf(target), here)).toBe(true)
    expect(placeOf(target).step).toBeNull()
    expect(targetOf(null)).toBeNull()
    const all = targetOf({ project: 3, kehikko: 'k', epic: null, scope: 'project', parts: [], step: null })!
    expect(placeOf(all)).toEqual({ project: 3, kehikko: 'k', epic: null, scope: 'project', parts: [], step: null })
    const pins = [{ id: 7, target, label: '', stale: null, note: null }]
    expect(pinnedHere(pins, targetOf({ ...here, parts: ['a', 'b'] }))?.id).toBe(7)
    expect(pinnedHere(pins, targetOf({ ...here, parts: ['a'] }))).toBeNull()
  })

  test('a pin into another project goes by the same plan an agent’s jump takes', () => {
    const now: Place = { project: 1, kehikko: 'main', epic: 'share', parts: [], step: null }
    const pin = placeOf({ project: 2, kehikko: 'draft', epic: 'thesis', scope: 'epic', parts: ['ch1'] })
    const plan = planJump(
      { project: pin.project, kehikko: pin.kehikko!, epic: pin.epic!, parts: pin.parts },
      now,
      {
        projects: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
        kehikotOf: (p) => (p === 2 ? [{ key: 'draft', name: 'Draft' }] : [{ key: 'main', name: 'Main' }]),
        subjectOf: () => ({ epic: null, parts: [] }),
      },
    )
    expect(plan).toEqual({ kind: 'go', target: pin })
  })

  test('order: up, down, and dragged onto another row', () => {
    expect(movedBy([1, 2, 3], 2, -1)).toEqual([2, 1, 3])
    expect(movedBy([1, 2, 3], 2, 1)).toEqual([1, 3, 2])
    expect(movedBy([1, 2, 3], 1, -1)).toEqual([1, 2, 3])
    expect(movedBy([1, 2, 3], 3, 1)).toEqual([1, 2, 3])
    expect(movedOnto([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3])
    expect(movedOnto([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4])
    expect(movedOnto([1, 2, 3], 2, 2)).toEqual([1, 2, 3])
  })

  test('the chord is Alt+Shift+P, and never the Inbox’s Alt+Shift+N', () => {
    const k = (code: string, more: Partial<{ altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code, ...more })
    expect(isPinChord(k('KeyP'))).toBe(true)
    expect(isPinChord(k('KeyN'))).toBe(false)
    expect(isPinChord(k('KeyP', { metaKey: true }))).toBe(false)
    expect(isPinChord(k('KeyP', { shiftKey: false }))).toBe(false)
  })

  test('the wire takes a pin, an unpin or an order, and nothing else', () => {
    expect(pinEditSchema.safeParse({ pin: { project: 1, kehikko: 'k', epic: null, scope: 'epic', parts: [] } }).success).toBe(true)
    expect(pinEditSchema.safeParse({ unpin: 3 }).success).toBe(true)
    expect(pinEditSchema.safeParse({ order: [3, 1] }).success).toBe(true)
    expect(pinEditSchema.safeParse({ pin: { project: 1, kehikko: 'k', epic: null, scope: 'epic', parts: [], label: '<b>' } }).success).toBe(false)
    expect(pinEditSchema.safeParse({ unpin: 3, order: [] }).success).toBe(false)
    expect(pinEditSchema.safeParse({ order: Array.from({ length: PINNED_MAX + 1 }, (_, i) => i + 1) }).success).toBe(false)
  })

  describe('a stored pin, now', () => {
    const stored: StoredPin = {
      id: 1,
      target: { project: 5, kehikko: 'k1', epic: 'thesis', scope: 'epic', parts: ['methods', 'results'] },
      names: { project: 'CS-DEGREE', kehikko: 'Wide', epic: 'Thesis', parts: { methods: 'Methods', results: 'Results' } },
    }
    const facts = (over: Partial<PinFacts> = {}): PinFacts => ({
      project: { id: 5, name: 'CS-DEGREE', missing: false },
      kehikot: new Map([['k1', 'Wide']]),
      epics: new Map([['thesis', 'Thesis']]),
      parts: new Map([['methods', 'Methods'], ['results', 'Results']]),
      ...over,
    })

    test('everything there: gone to as it is, named as things are called now', () => {
      const now = resolvePin(stored, facts({ kehikot: new Map([['k1', 'Wider']]) }))
      expect(now).toEqual({ id: 1, target: normalTarget(stored.target), label: 'CS-DEGREE › Thesis › Methods, Results · Wider', stale: null, note: null })
    })
    test('the project gone: stale, named as it was', () => {
      expect(resolvePin(stored, facts({ project: null })).stale).toBe('CS-DEGREE is no longer a project here.')
    })
    test('the folder gone', () => {
      expect(resolvePin(stored, facts({ project: { id: 5, name: 'CS-DEGREE', missing: true } })).stale).toBe('The folder of CS-DEGREE is gone.')
    })
    test('the kehikko gone', () => {
      const now = resolvePin(stored, facts({ kehikot: new Map() }))
      expect(now.stale).toBe('The kehikko Wide is gone.')
      expect(now.label).toBe('CS-DEGREE › Thesis › Methods, Results · Wide')
    })
    test('the epic gone', () => {
      expect(resolvePin(stored, facts({ epics: new Map(), parts: null })).stale).toBe('The epic Thesis is gone.')
    })
    test('some parts gone: the rest kept, and said', () => {
      const now = resolvePin(stored, facts({ parts: new Map([['results', 'Results']]) }))
      expect(now.stale).toBeNull()
      expect(now.target.parts).toEqual(['results'])
      expect(now.note).toBe('Methods is gone from the epic; the rest are kept.')
    })
    test('every part gone: stale', () => {
      expect(resolvePin(stored, facts({ parts: new Map() })).stale).toBe('Methods and Results are gone from the epic.')
    })
    test('a project found again under a new id keeps the pin', () => {
      expect(resolvePin(stored, facts({ project: { id: 9, name: 'CS-DEGREE', missing: false } })).target.project).toBe(9)
    })
  })
})

/* ------------------------------------------------------------ the store */

let db: Database
let folders: string[]
let a: Project
let b: Project

function aProject(name: string, epics: Record<string, unknown>): Project {
  const outer = mkdtempSync(join(tmpdir(), 'kehikko-pins-'))
  folders.push(outer)
  const folder = join(outer, name)
  mkdirSync(epicsDir(folder), { recursive: true })
  for (const [slug, epic] of Object.entries(epics)) writeFileSync(join(epicsDir(folder), `${slug}.json`), JSON.stringify(epic))
  const added = addProject(db, folder, name)
  if (!added.ok) throw new Error(added.why)
  return added.project
}

beforeEach(() => {
  db = open(':memory:')
  ensurePinnedPlaces(db)
  folders = []
  a = aProject('CS-DEGREE', {
    thesis: { slug: 'thesis', title: 'thesis', steps: [], parts: [{ id: 'methods', name: 'methods' }, { id: 'results', name: 'results' }] },
  })
  b = aProject('Paper', { draft: { slug: 'draft', title: 'Draft', steps: [] } })
  createCanvas(db, 'Wide', a.id, 'wide')
  createCanvas(db, 'Main', b.id, 'main')
})
afterEach(() => {
  db.close()
  for (const folder of folders) rmSync(folder, { recursive: true, force: true })
})

const pin = (target: PinTarget) => {
  const done = editPinnedPlaces(db, { pin: target })
  if (!done.ok) throw new Error(done.why)
  return done.pinned
}
const thesis = (parts: string[] = ['methods']): PinTarget => ({ project: a.id, kehikko: 'wide', epic: 'thesis', scope: 'epic', parts })
const draft = (): PinTarget => ({ project: b.id, kehikko: 'main', epic: 'draft', scope: 'epic', parts: [] })

describe('the store', () => {
  test('starts empty, and a pin is read back with its label', () => {
    expect(readPinnedPlaces(db)).toEqual([])
    const pinned = pin(thesis())
    expect(pinned.map((one) => [one.label, one.stale, one.note])).toEqual([['CS-DEGREE › thesis › methods · Wide', null, null]])
    expect(readPinnedPlaces(db)).toEqual(pinned)
  })

  test('newest first; the same place twice is one pin', () => {
    pin(thesis())
    pin(draft())
    pin({ project: a.id, kehikko: 'wide', epic: null, scope: 'project', parts: [] })
    const pinned = pin(thesis(['methods']))
    expect(pinned.map((one) => one.label)).toEqual(['CS-DEGREE › All epics · Wide', 'Paper › Draft · Main', 'CS-DEGREE › thesis › methods · Wide'])
  })

  test('unpin removes that one and only that one', () => {
    pin(thesis())
    const [newest] = pin(draft())
    const done = editPinnedPlaces(db, { unpin: newest!.id })
    expect(done.ok && done.pinned.map((one) => one.label)).toEqual(['CS-DEGREE › thesis › methods · Wide'])
    /* Unpinning what is not there changes nothing. */
    expect(editPinnedPlaces(db, { unpin: 999 }).ok).toBe(true)
    expect(readPinnedPlaces(db)).toHaveLength(1)
  })

  test('an order is kept; ids it leaves out keep their turn after it, unknown ids are ignored', () => {
    pin(thesis())
    pin(draft())
    const [one, two, three] = pin(thesis(['results'])).map((p) => p.id) as [number, number, number]
    let done = editPinnedPlaces(db, { order: [three, two, one] })
    expect(done.ok && done.pinned.map((p) => p.id)).toEqual([three, two, one])
    done = editPinnedPlaces(db, { order: [one, 404] })
    expect(done.ok && done.pinned.map((p) => p.id)).toEqual([one, three, two])
    /* A new pin still comes first. */
    const after = pin({ project: b.id, kehikko: null, epic: null, scope: 'epic', parts: [] })
    expect(after[0]!.label).toBe('Paper')
  })

  test('a pin of a project this host does not hold is refused', () => {
    const done = editPinnedPlaces(db, { pin: { ...draft(), project: 999 } })
    expect(done.ok).toBe(false)
  })

  test('pins are capped', () => {
    for (let i = 0; i < PINNED_MAX; i++) pin({ project: a.id, kehikko: `k${i}`, epic: null, scope: 'epic', parts: [] })
    const done = editPinnedPlaces(db, { pin: draft() })
    expect(done.ok).toBe(false)
  })

  describe('stale targets', () => {
    test('a kehikko removed: greyed with the reason, and still unpinnable', () => {
      pin(draft())
      createCanvas(db, 'Other', b.id, 'other')
      expect(deleteCanvas(db, listCanvases(db).find((c) => c.key === 'main')!.id)).toBe('deleted')
      const [gone] = readPinnedPlaces(db)
      expect(gone!.stale).toBe('The kehikko Main is gone.')
      const done = editPinnedPlaces(db, { unpin: gone!.id })
      expect(done.ok && done.pinned).toEqual([])
    })

    test('an epic deleted', () => {
      pin(thesis())
      unlinkSync(join(epicsDir(a.path), 'thesis.json'))
      expect(readPinnedPlaces(db)[0]!.stale).toBe('The epic thesis is gone.')
    })

    test('one part removed keeps the other', () => {
      pin(thesis(['methods', 'results']))
      writeFileSync(join(epicsDir(a.path), 'thesis.json'), JSON.stringify({ slug: 'thesis', title: 'thesis', steps: [], parts: [{ id: 'results', name: 'results' }] }))
      const [now] = readPinnedPlaces(db)
      expect(now!.stale).toBeNull()
      expect(now!.target.parts).toEqual(['results'])
      expect(now!.note).toBe('methods is gone from the epic; the rest are kept.')
      expect(now!.label).toBe('CS-DEGREE › thesis › methods, results · Wide')
    })

    test('a project forgotten', () => {
      pin(draft())
      expect(forgetProject(db, b.id).ok).toBe(true)
      const [gone] = readPinnedPlaces(db)
      expect(gone!.stale).toBe('Paper is no longer a project here.')
      expect(gone!.label).toBe('Paper › Draft · Main')
    })

    test('a project folder gone', () => {
      pin(draft())
      rmSync(b.path, { recursive: true, force: true })
      expect(readPinnedPlaces(db)[0]!.stale).toBe('The folder of Paper is gone.')
    })
  })
})

describe('the door', () => {
  const door = (): Door => ({
    db,
    which: () => ({ ok: false, why: 'No page has a kehikko open.' }) as never,
    wake: () => {},
    epicsChanged: () => {},
    dispositionsChanged: () => {},
    seen: async () => [],
  })

  test('my_place lists the pinned places, read-only, with what jump takes', async () => {
    pin(thesis())
    const done = await call('my_place', {}, door())
    expect(done.text).toContain('pinned places (theirs; read-only')
    expect(done.text).toContain(`1. CS-DEGREE › thesis › methods · Wide (jump { project: ${JSON.stringify(a.path)}, kehikko: "wide", epic: "thesis", parts: ["methods"] })`)
  })

  test('no door tool pins or unpins: the door never reaches the store’s writer', async () => {
    const source = await Bun.file(join(import.meta.dir, '../server/mcp.ts')).text()
    expect(source).not.toMatch(/editPinnedPlaces/)
  })
})
