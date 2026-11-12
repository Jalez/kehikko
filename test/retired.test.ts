import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, listCanvases, open } from '../server/canvases.ts'
import { mergeLists, mergeRetired } from '../server/officialSource.ts'
import { OFFICIAL, RETIRED, readOfficial, readRetired } from '../server/official.ts'
import { isOwnCheckout, noteOf, retireDesk, type RetireDeps } from '../server/retired.ts'
import { addProject } from '../server/projects.ts'

const LIST = [
  { id: 'kehikot.gone', name: 'Gone', says: 'the Inbox does its job.' },
  { id: 'kehikot.other', name: 'Other', says: 'something else does.' },
]

describe('Uninstall takes a module off the machine, only on a press', () => {
  let db: Database
  let base: string
  let project: string
  let id: number
  let root: string
  let registry: string
  let stopped: string[]
  let canvas: number
  let desk: ReturnType<typeof retireDesk>
  let registered: { id: string; dir?: string }[]
  let own: string

  beforeEach(() => {
    db = open(':memory:')
    base = mkdtempSync(join(tmpdir(), 'kehikko-retired-'))
    project = join(base, 'project')
    mkdirSync(join(project, '.kehikot', 'kehikot.gone'), { recursive: true })
    writeFileSync(join(project, '.kehikot', 'kehikot.gone', 'data.json'), '{"keep":true}')
    const added = addProject(db, project, 'p')
    if (!added.ok) throw new Error(added.why)
    id = added.project.id
    root = join(base, 'installed')
    registry = join(base, 'modules')
    own = join(base, 'my-checkout')
    mkdirSync(join(root, 'kehikot.gone'), { recursive: true })
    writeFileSync(join(root, 'kehikot.gone', 'run.sh'), '')
    mkdirSync(own, { recursive: true })
    writeFileSync(join(own, 'run.sh'), '')
    mkdirSync(registry, { recursive: true })
    for (const one of ['gone', 'mine', 'kept']) writeFileSync(join(registry, `kehikot.${one}.json`), '{}')
    canvas = createCanvas(db, 'main', id).id
    const place = (i: string, x: number) => ({ i, x, y: 0, w: 4, h: 4 }) as never
    editCanvas(db, canvas, { placements: [place('kehikot.gone', 0), place('kehikot.kept', 4), place('kehikot.mine', 8)] })
    stopped = []
    registered = [
      { id: 'kehikot.gone', dir: join(root, 'kehikot.gone') },
      { id: 'kehikot.kept', dir: join(root, 'kehikot.kept') },
      { id: 'kehikot.mine', dir: own },
    ]
    const deps: RetireDeps = {
      db,
      retired: () => readRetired({ retired: LIST }),
      root,
      registry,
      registered: async () => registered,
      stop: (one) => void stopped.push(one),
      keep: () => undefined,
      woke: () => undefined,
      registryChanged: () => undefined,
      log: () => undefined,
    }
    desk = retireDesk(deps)
  })
  afterEach(() => {
    db.close()
    rmSync(base, { recursive: true, force: true })
  })

  test('nothing is removed until Uninstall is pressed: a desk has no sweep', () => {
    expect('sweep' in desk).toBe(false)
    expect(existsSync(join(root, 'kehikot.gone'))).toBe(true)
    expect(readdirSync(registry)).toHaveLength(3)
  })

  test('a copy Kehikot installed: containers, process, registration and copy go; project data and other modules stay', async () => {
    const out = await desk.uninstall('kehikot.gone')
    expect(out).toEqual({ ok: true, removed: 'kehikot.gone', own: false })
    expect(listCanvases(db).find((one) => one.id === canvas)!.placements.map((p) => p.i).sort()).toEqual(['kehikot.kept', 'kehikot.mine'])
    expect(stopped).toEqual(['kehikot.gone'])
    expect(existsSync(join(root, 'kehikot.gone'))).toBe(false)
    expect(readdirSync(registry).sort()).toEqual(['kehikot.kept.json', 'kehikot.mine.json'])
    expect(readFileSync(join(project, '.kehikot', 'kehikot.gone', 'data.json'), 'utf8')).toBe('{"keep":true}')
  })

  test('works for any registered module, not only a retired one', async () => {
    expect((await desk.uninstall('kehikot.kept')).ok).toBe(true)
    expect(readdirSync(registry).sort()).toEqual(['kehikot.gone.json', 'kehikot.mine.json'])
  })

  test('a person’s own checkout is unregistered and its folder is left whole', async () => {
    const out = await desk.uninstall('kehikot.mine')
    expect(out).toEqual({ ok: true, removed: 'kehikot.mine', own: true })
    expect(existsSync(join(own, 'run.sh'))).toBe(true)
    expect(existsSync(join(registry, 'kehikot.mine.json'))).toBe(false)
    expect(listCanvases(db).find((one) => one.id === canvas)!.placements.map((p) => p.i)).not.toContain('kehikot.mine')
  })

  test('a module that is nowhere on this machine is refused', async () => {
    const out = await desk.uninstall('kehikot.nowhere')
    expect(out.ok).toBe(false)
  })
})

describe('a retired module is flagged wherever it lives', () => {
  const retired = readRetired({ retired: [{ id: 'kehikot.gone', name: 'Gone', says: 'Replaced by the Inbox module.', replacedBy: 'kehikot.next' }] })

  test('the note names the successor from the list, only when its name is known', () => {
    expect(noteOf(retired, 'kehikot.gone', () => 'Next')).toEqual({ says: 'Replaced by the Inbox module.', successor: { id: 'kehikot.next', name: 'Next' } })
    expect(noteOf(retired, 'kehikot.gone', () => null)).toEqual({ says: 'Replaced by the Inbox module.' })
    expect(noteOf(retired, 'kehikot.other', () => 'Next')).toBeNull()
  })

  test('a checkout outside installed/ is flagged as the person’s own; the installed copy is not', () => {
    const base = mkdtempSync(join(tmpdir(), 'kehikko-own-'))
    mkdirSync(join(base, 'installed', 'm'), { recursive: true })
    expect(isOwnCheckout(join(base, 'installed', 'm'), join(base, 'installed', 'm'))).toBe(false)
    expect(isOwnCheckout(join(base, 'elsewhere'), join(base, 'installed', 'm'))).toBe(true)
    expect(isOwnCheckout(undefined, join(base, 'installed', 'm'))).toBe(true)
    rmSync(base, { recursive: true, force: true })
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
