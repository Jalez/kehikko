import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { measure, ownerOf, storageDesk, type Locations, type Measured, type Named } from '../server/storage.ts'
import { bytesSaid, storageText, storageViewOf } from '../src/host/storage.ts'

/**
 * The storage overview (`server/storage.ts`): sizes per module folder in every
 * project, folders named by module, a missing project skipped, the budget
 * honoured, a symbolic link never followed, the machine's own data, and the
 * cache. All in a scratch directory; nothing here is the real machine.
 */

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-storage-')))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const MODULES: Named[] = [
  { id: 'kehikot.checklist', name: 'Checklist' },
  { id: 'kehikot.notes', name: 'Notes' },
]

function file(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x'.repeat(bytes))
}

function machine(name: string): Locations {
  const at = join(ROOT, name)
  mkdirSync(at, { recursive: true })
  return {
    machine: at,
    frame: join(at, 'frame.sqlite'),
    registry: join(at, 'modules'),
    officialList: join(at, 'official-modules.json'),
    versions: join(at, 'versions'),
    installed: join(at, 'installed'),
    browserProfile: join(at, 'browser-profile'),
    logs: join(at, 'logs'),
  }
}

/** A project with a checklist, notes, the host's folder, project.json and a folder nobody claims. */
function project(name: string, checklistBytes: number[]): string {
  const root = join(ROOT, name)
  const kehikot = join(root, '.kehikot')
  checklistBytes.forEach((bytes, i) => file(join(kehikot, 'checklist', `list-${i}.json`), bytes))
  file(join(kehikot, 'notes', 'notes.json'), 40)
  file(join(kehikot, 'host', 'epics', 'one.json'), 30)
  file(join(kehikot, 'project.json'), 20)
  file(join(kehikot, 'leftover', 'old.json'), 5)
  return root
}

const here = (id: number, name: string, path: string, missing = false): Measured => ({ id, name, path, missing })

describe('measuring', () => {
  test('sizes, file counts, the largest files and when each folder last changed', async () => {
    const a = project('alpha', [100, 300, 50])
    const report = await measure([here(1, 'alpha', a)], MODULES, { at: machine('m1') })
    const alpha = report.projects[0]!
    expect(alpha.total.bytes).toBe(100 + 300 + 50 + 40 + 30 + 20 + 5)
    expect(alpha.total.files).toBe(7)
    const checklist = alpha.shares.find((share) => share.owner.name === 'Checklist')!
    expect(checklist.folder).toBe('checklist')
    expect(checklist.tally).toMatchObject({ bytes: 450, files: 3, cut: false })
    expect(checklist.tally.largest.map((one) => one.path)).toEqual(['checklist/list-1.json', 'checklist/list-0.json', 'checklist/list-2.json'])
    expect(checklist.tally.modified).toBe(Math.max(...readdirSync(join(a, '.kehikot', 'checklist')).map((f) => statSync(join(a, '.kehikot', 'checklist', f)).mtimeMs)))
    /* Largest first. */
    expect(alpha.shares[0]!.owner.name).toBe('Checklist')
  })

  test('folders are named by module; the host’s folder and project.json are Kehikot’s; an unclaimed folder keeps its name', async () => {
    const report = await measure([here(1, 'alpha', join(ROOT, 'alpha'))], MODULES, { at: machine('m2') })
    const owners = Object.fromEntries(report.projects[0]!.shares.map((share) => [share.folder, share.owner]))
    expect(owners.checklist).toEqual({ id: 'kehikot.checklist', name: 'Checklist' })
    expect(owners.notes).toEqual({ id: 'kehikot.notes', name: 'Notes' })
    expect(owners.host).toEqual({ id: 'kehikko', name: 'Kehikot' })
    expect(owners.leftover).toEqual({ id: null, name: 'leftover' })
    /* host/ and project.json are one row. */
    const host = report.projects[0]!.shares.find((share) => share.folder === 'host')!
    expect(host.tally).toMatchObject({ bytes: 50, files: 2 })
    expect(host.tally.largest.map((one) => one.path).sort()).toEqual(['host/epics/one.json', 'project.json'])
    expect(ownerOf('kehikko', MODULES).name).toBe('Kehikot')
  })

  test('per module across projects: "Checklist: … across 2 projects"', async () => {
    const b = project('beta', [1050])
    const report = await measure([here(1, 'alpha', join(ROOT, 'alpha')), here(2, 'beta', b)], MODULES, { at: machine('m3') })
    const checklist = report.modules.find((total) => total.id === 'kehikot.checklist')!
    expect(checklist).toMatchObject({ name: 'Checklist', bytes: 1500, files: 4, projects: 2 })
    expect(storageText(report)).toContain('Checklist: 1.5 KB across 2 projects')
  })

  test('a project whose folder is gone is skipped, and said', async () => {
    const gone = join(ROOT, 'gone')
    const report = await measure([here(1, 'alpha', join(ROOT, 'alpha')), here(3, 'gone', gone, true)], MODULES, { at: machine('m4') })
    expect(report.projects.map((one) => one.name)).toEqual(['alpha'])
    expect(report.missing).toEqual([{ id: 3, name: 'gone', path: gone }])
    expect(storageText(report)).toContain('its folder is gone, so it was not measured')
  })

  test('a symbolic link is not followed, inside a module’s folder or as one', async () => {
    const outside = join(ROOT, 'outside')
    file(join(outside, 'huge.bin'), 50_000)
    const root = join(ROOT, 'linked')
    file(join(root, '.kehikot', 'checklist', 'list.json'), 10)
    symlinkSync(outside, join(root, '.kehikot', 'checklist', 'elsewhere'))
    symlinkSync(join(outside, 'huge.bin'), join(root, '.kehikot', 'checklist', 'huge.bin'))
    symlinkSync(outside, join(root, '.kehikot', 'notes'))
    const report = await measure([here(1, 'linked', root)], MODULES, { at: machine('m5') })
    const linked = report.projects[0]!
    expect(linked.total.bytes).toBe(10)
    expect(linked.total.files).toBe(1)
    expect(linked.total.links).toBe(3)
    expect(linked.shares.map((share) => share.folder)).toEqual(['checklist'])
  })

  test('the budget is honoured: an entry limit stops the walk and marks it "at least"', async () => {
    const root = join(ROOT, 'many')
    for (let i = 0; i < 50; i++) file(join(root, '.kehikot', 'checklist', `f-${i}.json`), 10)
    const full = await measure([here(1, 'many', root)], MODULES, { at: machine('m6') })
    expect(full.cut).toBe(false)
    expect(full.projects[0]!.total.files).toBe(50)

    const cut = await measure([here(1, 'many', root)], MODULES, { at: machine('m6'), budget: { ms: 60_000, entries: 10 } })
    expect(cut.cut).toBe(true)
    expect(cut.projects[0]!.total.cut).toBe(true)
    expect(cut.projects[0]!.total.files).toBeLessThan(50)
    expect(storageText(cut)).toContain('at least')
  })

  test('the budget is honoured: a time limit stops the walk too', async () => {
    let clock = 0
    const now = () => (clock += 100)
    const report = await measure([here(1, 'many', join(ROOT, 'many'))], MODULES, { at: machine('m7'), budget: { ms: 500, entries: 1_000_000 }, now })
    expect(report.cut).toBe(true)
    expect(report.projects[0]!.total.files).toBeLessThan(50)
  })

  test('the machine’s own data: the database with its log, installed modules and versions per module, the browser profile, the logs', async () => {
    const at = machine('m8')
    file(at.frame, 4000)
    file(`${at.frame}-wal`, 1000)
    file(join(at.installed, 'kehikot.checklist', 'index.ts'), 700)
    file(join(at.installed, 'kehikot.notes', 'index.ts'), 900)
    file(join(at.versions, 'kehikot.notes', 'v1.0.0', 'index.ts'), 300)
    file(join(at.browserProfile, 'Default', 'Cookies'), 2000)
    file(join(at.logs, 'kehikot.notes.log'), 50)
    const report = await measure([], MODULES, { at })
    const part = Object.fromEntries(report.machine.parts.map((one) => [one.key, one]))
    expect(part.frame!.tally).toMatchObject({ bytes: 5000, files: 2 })
    expect(part.installed!.modules!.map((one) => [one.owner.name, one.tally.bytes])).toEqual([
      ['Notes', 900],
      ['Checklist', 700],
    ])
    expect(part.versions!.modules![0]!.owner.name).toBe('Notes')
    expect(part['browser-profile']!.tally!.bytes).toBe(2000)
    expect(part.logs!.tally!.bytes).toBe(50)
    expect(part.registry!.tally).toBeNull()
    expect(report.machine.bytes).toBe(5000 + 1600 + 300 + 2000 + 50)
    expect(storageText(report)).toContain('nothing there')
  })
})

describe('the desk', () => {
  test('answers from memory for a while, measures again when asked fresh, and shares one walk', async () => {
    let clock = 1_000_000
    let walks = 0
    const desk = storageDesk({
      projects: () => {
        walks += 1
        return [here(1, 'alpha', join(ROOT, 'alpha'))]
      },
      modules: async () => MODULES,
      at: () => machine('m9'),
      now: () => clock,
    })
    const [one, two] = await Promise.all([desk.read(), desk.read()])
    expect(one).toBe(two)
    expect(walks).toBe(1)
    clock += 1000
    expect(await desk.read()).toBe(one)
    expect(walks).toBe(1)
    await desk.read(true)
    expect(walks).toBe(2)
    clock += 60_000
    await desk.read()
    expect(walks).toBe(3)
  })
})

describe('the words', () => {
  test('bytes as a person reads them', () => {
    expect(bytesSaid(0)).toBe('0 bytes')
    expect(bytesSaid(1)).toBe('1 byte')
    expect(bytesSaid(812)).toBe('812 bytes')
    expect(bytesSaid(2_400)).toBe('2.4 KB')
    expect(bytesSaid(2_400_000)).toBe('2.4 MB')
    expect(bytesSaid(18_000_000)).toBe('18 MB')
    expect(bytesSaid(1_200_000_000)).toBe('1.2 GB')
  })

  test('a module’s own storage view is a switch or go option with the id "storage"', () => {
    expect(storageViewOf([{ kind: 'switch', id: 'view', options: [{ id: 'list' }, { id: 'storage' }] }])).toEqual({ item: 'view', value: 'storage' })
    expect(storageViewOf([{ kind: 'go', id: 'to', options: [{ id: 'storage' }] }])).toEqual({ item: 'to', value: 'storage' })
    expect(storageViewOf([{ kind: 'run', id: 'storage' }])).toBeNull()
    expect(storageViewOf(undefined)).toBeNull()
  })
})

describe('the door’s storage tool', () => {
  test('says the same numbers, names no kehikko, refuses a bad argument, and asks fresh only when told', async () => {
    const { call } = await import('../server/mcp.ts')
    const { open } = await import('../server/canvases.ts')
    const asked: boolean[] = []
    const report = await measure([here(1, 'alpha', join(ROOT, 'alpha')), here(3, 'gone', join(ROOT, 'gone'), true)], MODULES, { at: machine('m10') })
    const door = {
      db: open(':memory:'),
      which: () => ({ id: null, how: 'none' }) as never,
      wake: () => {},
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      seen: async () => [],
      storage: async (fresh: boolean) => {
        asked.push(fresh)
        return report
      },
    }
    const said = await call('storage', {}, door)
    expect(said.failed).toBe(false)
    expect(said.text).toBe(storageText(report))
    expect(said.text).toContain('Project alpha')
    expect(said.text).toContain('Checklist (.kehikot/checklist/)')
    expect(said.text).toContain('Machine data')
    await call('storage', { fresh: true }, door)
    expect(asked).toEqual([false, true])
    expect((await call('storage', { fresh: 'yes' }, door)).failed).toBe(true)
    const { storage: _, ...without } = door
    expect((await call('storage', {}, without)).failed).toBe(true)
  })
})
