import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, listCanvases, open } from '../server/canvases.ts'
import { Inbox } from '../server/inbox.ts'
import { mergeLists, mergeRetired } from '../server/officialSource.ts'
import { OFFICIAL, RETIRED, readOfficial, readRetired } from '../server/official.ts'
import { retireDesk, type RetireDeps } from '../server/retired.ts'
import { addProject } from '../server/projects.ts'

const LIST = [
  { id: 'kehikot.gone', name: 'Gone', says: 'the Inbox does its job.' },
  { id: 'kehikot.other', name: 'Other', says: 'something else does.' },
]

describe('a retired module is taken off the machine', () => {
  let db: Database
  let base: string
  let project: string
  let id: number
  let root: string
  let registry: string
  let stopped: string[]
  let inbox: Inbox
  let canvas: number
  let told: number[]
  let desk: ReturnType<typeof retireDesk>
  let registered: { id: string; dir?: string }[]

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
    mkdirSync(join(root, 'kehikot.gone'), { recursive: true })
    writeFileSync(join(root, 'kehikot.gone', 'run.sh'), '')
    mkdirSync(registry, { recursive: true })
    writeFileSync(join(registry, 'kehikot.gone.json'), '{}')
    writeFileSync(join(registry, 'kehikot.kept.json'), '{}')
    canvas = createCanvas(db, 'main', id).id
    const place = (i: string, x: number) => ({ i, x, y: 0, w: 4, h: 4 }) as never
    editCanvas(db, canvas, { placements: [place('kehikot.gone', 0), place('kehikot.kept', 4)] })
    stopped = []
    told = []
    inbox = new Inbox(db)
    registered = [{ id: 'kehikot.gone', dir: join(root, 'kehikot.gone') }, { id: 'kehikot.kept', dir: join(root, 'kehikot.kept') }]
    const deps: RetireDeps = {
      db,
      inbox,
      retired: () => readRetired({ retired: LIST }),
      root,
      registry,
      registered: async () => registered,
      stop: (one) => void stopped.push(one),
      keep: () => undefined,
      woke: () => undefined,
      projects: () => [{ id }],
      changed: (project) => void told.push(project),
      registryChanged: () => undefined,
      log: () => undefined,
    }
    desk = retireDesk(deps)
  })
  afterEach(() => {
    db.close()
    rmSync(base, { recursive: true, force: true })
  })

  test('its containers, process, registration and installed copy go; project data and other modules stay; one Inbox line', async () => {
    expect(await desk.sweep()).toBe(1)
    expect(listCanvases(db).find((one) => one.id === canvas)!.placements.map((p) => p.i)).toEqual(['kehikot.kept'])
    expect(stopped).toEqual(['kehikot.gone'])
    expect(existsSync(join(root, 'kehikot.gone'))).toBe(false)
    expect(readdirSync(registry)).toEqual(['kehikot.kept.json'])
    expect(readFileSync(join(project, '.kehikot', 'kehikot.gone', 'data.json'), 'utf8')).toBe('{"keep":true}')
    const lines = inbox.all(id)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.name).toBe('Kehikot')
    expect(lines[0]!.label).toBe('Gone was retired from the module list and removed: the Inbox does its job.')
    expect(told).toEqual([id])
    /* Nothing left to do: a second sweep says nothing more. */
    registered = registered.filter((one) => one.id !== 'kehikot.gone')
    expect(await desk.sweep()).toBe(0)
    expect(inbox.all(id)).toHaveLength(1)
  })

  test('a copy registered from somebody’s own checkout is left entirely alone', async () => {
    registered = [{ id: 'kehikot.gone', dir: join(base, 'my-checkout') }]
    expect(await desk.sweep()).toBe(0)
    expect(stopped).toEqual([])
    expect(existsSync(join(root, 'kehikot.gone'))).toBe(true)
    expect(listCanvases(db).find((one) => one.id === canvas)!.placements).toHaveLength(2)
    expect(inbox.all(id)).toHaveLength(0)
  })

  test('a module that is nowhere on this machine is not announced', async () => {
    rmSync(join(root, 'kehikot.gone'), { recursive: true })
    rmSync(join(registry, 'kehikot.gone.json'))
    editCanvas(db, canvas, { placements: [] })
    registered = []
    expect(await desk.sweep()).toBe(0)
    expect(inbox.all(id)).toHaveLength(0)
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

  test('the built-in list retires two modules and no longer offers them', () => {
    expect(RETIRED.map((one) => one.id).sort()).toEqual(['kehikot.atlas', 'kehikot.notifications'])
    expect(OFFICIAL.some((one) => RETIRED.some((gone) => gone.id === one.id))).toBe(false)
  })
})
