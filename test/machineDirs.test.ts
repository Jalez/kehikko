import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameDbFile, machineDir, modulesDir } from '../server/machineDirs.ts'
import { readRegistrations } from '../server/registrations.ts'

const made: string[] = []
function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kehikot-machine-'))
  made.push(home)
  return home
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('where machine state lives', () => {
  test('Application Support on macOS, XDG elsewhere, overridable by KEHIKOT_*', () => {
    expect(machineDir({ HOME: '/Users/x' }, 'darwin')).toBe('/Users/x/Library/Application Support/Kehikot')
    expect(machineDir({ HOME: '/home/x' }, 'linux')).toBe('/home/x/.local/share/kehikot')
    expect(machineDir({ HOME: '/home/x', XDG_DATA_HOME: '/data' }, 'linux')).toBe('/data/kehikot')
    expect(frameDbFile({ KEHIKOT_FRAME_DB: '/a' })).toBe('/a')
    expect(modulesDir({ KEHIKOT_MODULES_DIR: '/m' })).toBe('/m')
    expect(modulesDir({ HOME: '/Users/x' })).toBe(join(machineDir({ HOME: '/Users/x' }), 'modules'))
  })
})

describe('the registry', () => {
  const saved = { HOME: process.env.HOME, K: process.env.KEHIKOT_MODULES_DIR }
  afterEach(() => {
    process.env.HOME = saved.HOME
    if (saved.K === undefined) delete process.env.KEHIKOT_MODULES_DIR
    else process.env.KEHIKOT_MODULES_DIR = saved.K
  })

  test('is one directory, read whole; given another, only that one is read', async () => {
    const home = scratchHome()
    process.env.HOME = home
    delete process.env.KEHIKOT_MODULES_DIR
    const now = modulesDir({ HOME: home })
    const other = join(home, 'other')
    mkdirSync(now, { recursive: true })
    mkdirSync(other, { recursive: true })
    writeFileSync(join(now, 'kehikot.notes.json'), JSON.stringify({ url: 'http://127.0.0.1:7001' }))
    writeFileSync(join(now, 'kehikot.paper.json'), JSON.stringify({ url: 'http://127.0.0.1:7002' }))
    writeFileSync(join(other, 'kehikot.slides.json'), JSON.stringify({ url: 'http://127.0.0.1:7003' }))

    const swept = await readRegistrations()
    expect(swept.dir).toBe(now)
    expect(Object.fromEntries(swept.registrations.map((r) => [r.id, r.url]))).toEqual({
      'kehikot.notes': 'http://127.0.0.1:7001',
      'kehikot.paper': 'http://127.0.0.1:7002',
    })
    expect((await readRegistrations(other)).registrations.map((r) => r.id)).toEqual(['kehikot.slides'])
  })
})
