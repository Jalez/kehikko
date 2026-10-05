import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Runnable } from '../server/launch.ts'
import { takeOver, within, type Processes } from '../server/takeover.ts'

/**
 * Restarting a module the host did not start, and every way that is refused.
 * No process is created or signalled: the operating system is a fake.
 */

const made: string[] = []
function dir(name = 'mod'): string {
  const path = join(tmpdir(), `kehikko-takeover-${process.pid}-${made.length}-${name}`)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  made.push(path)
  return path
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

const runnable = (root: string, port: number | null = 7870): Runnable => ({
  dir: root,
  script: join(root, 'run.sh'),
  port,
  url: `http://127.0.0.1:${port ?? ''}`,
  command: 'run.sh',
})

interface World {
  listener: number | null
  cwds: Record<number, string>
  groups: Record<number, number>
  own: number
  /** Which signal frees the port; `null` never. */
  freesOn: NodeJS.Signals | null
  signals: Array<[number, NodeJS.Signals]>
  listenerThrows?: boolean
}

function fake(over: Partial<World>): { os: Processes; world: World } {
  const world: World = { listener: null, cwds: {}, groups: {}, own: 500, freesOn: 'SIGTERM', signals: [], ...over }
  const os: Processes = {
    async listenerOf() {
      if (world.listenerThrows) throw new Error('no lsof')
      return world.listener
    },
    async cwdOf(pid) {
      return world.cwds[pid] ?? null
    },
    async groupOf(pid) {
      return world.groups[pid] ?? null
    },
    signalGroup(pgid, signal) {
      world.signals.push([pgid, signal])
      if (signal === world.freesOn || signal === 'SIGKILL') world.listener = null
    },
    async portFree() {
      return world.listener === null
    },
    async ownGroup() {
      return world.own
    },
    async sleep() {},
  }
  return { os, world }
}

describe('a listener proven to be the module', () => {
  test('running from the registered directory is stopped by group with SIGTERM', async () => {
    const root = dir()
    const { os, world } = fake({ listener: 1234, cwds: { 1234: root, 1200: root }, groups: { 1234: 1200 } })
    expect(await takeOver('kehikot.paper', runnable(root), os)).toEqual({ kind: 'stopped', pgid: 1200, killed: false })
    expect(world.signals).toEqual([[1200, 'SIGTERM']])
  })

  test('running from inside the registered directory counts', async () => {
    const root = dir()
    const inner = join(root, 'web')
    mkdirSync(inner)
    const { os, world } = fake({ listener: 1234, cwds: { 1234: inner }, groups: { 1234: 1234 } })
    expect((await takeOver('kehikot.paper', runnable(root), os)).kind).toBe('stopped')
    expect(world.signals).toEqual([[1234, 'SIGTERM']])
  })

  test('a port that never frees after SIGTERM gets SIGKILL to the same group', async () => {
    const root = dir()
    const { os, world } = fake({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 1200 }, freesOn: null })
    expect(await takeOver('kehikot.paper', runnable(root), os)).toEqual({ kind: 'stopped', pgid: 1200, killed: true })
    expect(world.signals).toEqual([[1200, 'SIGTERM'], [1200, 'SIGKILL']])
  })

  test('SIGKILL is not sent when somebody else took the port meanwhile', async () => {
    const root = dir()
    const { os, world } = fake({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 1200, 9999: 9000 }, freesOn: null })
    os.signalGroup = (pgid, signal) => {
      world.signals.push([pgid, signal])
      world.listener = 9999
    }
    const taken = await takeOver('kehikot.paper', runnable(root), os)
    expect(taken.kind).toBe('refused')
    expect(world.signals).toEqual([[1200, 'SIGTERM']])
  })
})

describe('refused, and nothing signalled', () => {
  test('a listener running from somewhere else', async () => {
    const root = dir()
    const elsewhere = dir('other')
    const { os, world } = fake({ listener: 1234, cwds: { 1234: elsewhere }, groups: { 1234: 1200 } })
    const taken = await takeOver('kehikot.paper', runnable(root), os)
    expect(taken.kind).toBe('refused')
    if (taken.kind === 'refused') {
      expect(taken.why).toContain('kehikot.paper is already running at http://127.0.0.1:7870 and this host did not start it')
      expect(taken.why).toContain(`not running from ${root}`)
    }
    expect(world.signals).toEqual([])
  })

  test('a sibling directory sharing a prefix is not inside', async () => {
    const root = dir('mod')
    const { os, world } = fake({ listener: 1234, cwds: { 1234: `${root}-evil` }, groups: { 1234: 1200 } })
    expect((await takeOver('kehikot.paper', runnable(root), os)).kind).toBe('refused')
    expect(world.signals).toEqual([])
  })

  test('a working directory that cannot be read', async () => {
    const root = dir()
    const { os, world } = fake({ listener: 1234, groups: { 1234: 1200 } })
    expect((await takeOver('kehikot.paper', runnable(root), os)).kind).toBe('refused')
    expect(world.signals).toEqual([])
  })

  for (const pgid of [0, 1]) {
    test(`process group ${pgid}`, async () => {
      const root = dir()
      const { os, world } = fake({ listener: 1234, cwds: { 1234: root }, groups: { 1234: pgid } })
      expect((await takeOver('kehikot.paper', runnable(root), os)).kind).toBe('refused')
      expect(world.signals).toEqual([])
    })
  }

  test("the host's own process group", async () => {
    const root = dir()
    const { os, world } = fake({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 500 }, own: 500 })
    expect((await takeOver('kehikot.paper', runnable(root), os)).kind).toBe('refused')
    expect(world.signals).toEqual([])
  })

  test('a group whose live leader runs from elsewhere', async () => {
    const root = dir()
    const home = dir('home')
    const { os, world } = fake({ listener: 1234, cwds: { 1234: root, 1200: home }, groups: { 1234: 1200 } })
    expect((await takeOver('kehikot.paper', runnable(root), os)).kind).toBe('refused')
    expect(world.signals).toEqual([])
  })

  test('the listener cannot be looked up at all', async () => {
    const root = dir()
    const { os, world } = fake({ listenerThrows: true })
    expect((await takeOver('kehikot.paper', runnable(root), os)).kind).toBe('refused')
    expect(world.signals).toEqual([])
  })

  test('a registration with no port', async () => {
    const root = dir()
    const { os, world } = fake({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 1200 } })
    expect((await takeOver('kehikot.paper', runnable(root, null), os)).kind).toBe('refused')
    expect(world.signals).toEqual([])
  })
})

test('no listener means start normally, signalling nothing', async () => {
  const root = dir()
  const { os, world } = fake({ listener: null })
  expect(await takeOver('kehikot.paper', runnable(root), os)).toEqual({ kind: 'nothing' })
  expect(world.signals).toEqual([])
})

test('within resolves symlinks and respects path boundaries', () => {
  const root = dir()
  expect(within(root, root)).toBe(true)
  expect(within(join(root, 'a', 'b'), root)).toBe(true)
  expect(within(`${root}x`, root)).toBe(false)
  expect(within('/', root)).toBe(false)
})
