import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { WELL_KNOWN } from 'kehikot-module-protocol'

import { awarenessOf } from '../server/agents.ts'
import { look } from '../server/discover.ts'
import { HOST_ID } from '../server/kehikot.ts'
import {
  addArgs,
  awarenessAt,
  doorFor,
  doorName,
  heldName,
  hostDoor,
  nameRefusal,
  repoint,
  serverName,
  type Door,
  type Runner,
} from '../server/register.ts'
import { toolsSaying } from '../src/canvas/HeaderMenus.tsx'

/**
 * A module says what its door is called (`mcp.as`, protocol 1.3.0).
 *
 * The host derived a door's name from the module's id, so `kehikot.claude` was
 * connected as `claude`. The host names no module, so the module declares the
 * name. What can go wrong is what is tested: the reader and the writer
 * disagreeing about the name, a door left "connected" under a name the next
 * press removes, a rename that removes somebody's own server, and two doors
 * asking for one name.
 */

const url = 'http://127.0.0.1:7999/mcp'
const known = (servers: Record<string, string>) =>
  new Map<string, unknown>(Object.entries(servers).map(([name, at]) => [name, { type: 'http', url: at }]))

describe('what a door is called', () => {
  test('what the module declares, and the id’s last segment when it declares nothing', () => {
    expect(doorName('kehikot.claude', 'kehikko-claude')).toBe('kehikko-claude')
    expect(doorName('kehikot.claude')).toBe('claude')
    expect(doorName('kehikot.claude', null)).toBe(serverName('kehikot.claude'))
  })

  test('the host’s own door declares nothing and is read exactly as before', () => {
    const own = hostDoor(4180)
    expect(awarenessAt(own, known({ kehikko: own.url }))).toEqual({ kind: 'told', as: 'kehikko' })
    expect(awarenessAt(own, known({ kehikko: 'http://127.0.0.1:4182/mcp' }))).toEqual({
      kind: 'elsewhere',
      as: 'kehikko',
      pointsAt: 'http://127.0.0.1:4182/mcp',
    })
  })

  test('the name written and the name read are the same name', () => {
    const door: Door = { module: 'kehikot.claude', as: 'kehikko-claude', url, transport: 'http' }
    expect(addArgs(door)).toEqual(['mcp', 'add', '--scope', 'user', '--transport', 'http', 'kehikko-claude', url])
    expect(awarenessAt(door, known({ 'kehikko-claude': url }))).toEqual({ kind: 'told', as: 'kehikko-claude' })
  })
})

describe('what the agent has been told, for a module that declares a name', () => {
  const aware = (servers: Record<string, string>) => awarenessOf(url, 'kehikot.claude', known(servers), 'kehikko-claude')

  test('nothing configured is untold', () => {
    expect(aware({})).toEqual({ kind: 'untold' })
  })

  test('connected under the declared name is told', () => {
    expect(aware({ 'kehikko-claude': url })).toEqual({ kind: 'told', as: 'kehikko-claude' })
  })

  test('connected under the old short name is NOT called connected: it is renamed, and says to what', () => {
    expect(aware({ claude: url })).toEqual({ kind: 'renamed', as: 'claude', to: 'kehikko-claude' })
  })

  test('the full id was the other name this host matched, and is an old name too', () => {
    expect(aware({ 'kehikot.claude': url })).toEqual({ kind: 'renamed', as: 'kehikot.claude', to: 'kehikko-claude' })
  })

  test('both names pointing here is told under the declared one', () => {
    expect(aware({ claude: url, 'kehikko-claude': url })).toEqual({ kind: 'told', as: 'kehikko-claude' })
  })

  test('a name somebody chose by hand is still told, whatever it is called', () => {
    expect(aware({ mine: url })).toEqual({ kind: 'told', as: 'mine' })
  })

  test('the declared name pointing somewhere else is elsewhere', () => {
    expect(aware({ 'kehikko-claude': 'http://127.0.0.1:7001/mcp' })).toEqual({
      kind: 'elsewhere',
      as: 'kehikko-claude',
      pointsAt: 'http://127.0.0.1:7001/mcp',
    })
  })

  test('the OLD name pointing somewhere else is somebody else’s server, and nothing offers to remove it', () => {
    /* `elsewhere` and `renamed` are the two states with a press that removes
       an entry. A server called `claude` that does not point at this door is
       neither. */
    expect(aware({ claude: 'http://127.0.0.1:7001/mcp' })).toEqual({ kind: 'untold' })
    expect(aware({ 'kehikot.claude': 'https://example.com/mcp' })).toEqual({ kind: 'untold' })
  })

  test('a module that declares nothing is read as it always was', () => {
    expect(awarenessOf(url, 'kehikot.claude', known({ claude: url }))).toEqual({ kind: 'told', as: 'claude' })
    expect(awarenessOf(url, 'kehikot.claude', known({ claude: 'http://127.0.0.1:1/mcp' }))).toMatchObject({
      kind: 'elsewhere',
      as: 'claude',
    })
  })
})

describe('the rename: the old name is removed, then the new one is written', () => {
  const door: Door = { module: 'kehikot.claude', as: 'kehikko-claude', url, transport: 'http' }

  test('remove then add, with the names read and declared', async () => {
    const calls: string[][] = []
    const run: Runner = async (args) => {
      calls.push(args)
      return { ok: true, said: '' }
    }
    const before = awarenessAt(door, known({ claude: url }))
    expect(before.kind).toBe('renamed')
    if (before.kind !== 'renamed') return

    const ran = await repoint(before.as, door, run)
    expect(ran.ok).toBe(true)
    expect(calls).toEqual([
      ['mcp', 'remove', 'claude'],
      ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'kehikko-claude', url],
    ])
  })

  test('a remove that fails writes nothing', async () => {
    const calls: string[][] = []
    const run: Runner = async (args) => {
      calls.push(args)
      return { ok: false, said: 'No such server' }
    }
    const ran = await repoint('claude', door, run)
    expect(ran.ok).toBe(false)
    expect(calls).toEqual([['mcp', 'remove', 'claude']])
  })
})

describe('a declared name that is another door’s', () => {
  test('the host’s own name is refused, in a sentence that names it', () => {
    const why = nameRefusal('kehikot.claude', HOST_ID, new Map())
    expect(why).toContain('kehikot.claude')
    expect(why).toContain(`"${HOST_ID}"`)
    expect(why).toContain("this host's own door")
  })

  test('another module’s derived name is refused, and the other module is named', () => {
    const others = new Map<string, string | null>([['kehikot.checklist', 'checklist']])
    const why = nameRefusal('kehikot.claude', 'checklist', others)
    expect(why).toContain('"checklist"')
    expect(why).toContain("kehikot.checklist's door")
  })

  test('two modules declaring one name are both refused', () => {
    const held = new Map<string, string | null>([
      ['kehikot.a', 'shared'],
      ['kehikot.b', 'shared'],
    ])
    expect(nameRefusal('kehikot.a', 'shared', held)).toContain("kehikot.b's door")
    expect(nameRefusal('kehikot.b', 'shared', held)).toContain("kehikot.a's door")
  })

  test('a module is not refused over its own name, a free name, or a name it did not declare', () => {
    const held = new Map<string, string | null>([
      ['kehikot.claude', 'kehikko-claude'],
      ['kehikot.checklist', 'checklist'],
      ['kehikot.pageonly', null],
    ])
    expect(nameRefusal('kehikot.claude', 'kehikko-claude', held)).toBeNull()
    /* Derived names that collide are not refused: that is the old behaviour, and it reads as `elsewhere`. */
    expect(nameRefusal('other.checklist', undefined, held)).toBeNull()
    expect(nameRefusal('other.checklist', null, held)).toBeNull()
  })

  test('what a neighbour holds: its declared name, its derived one, nothing without a door, the derived one when asleep', () => {
    const mcp = { url, transport: 'http', about: '' }
    expect(heldName({ id: 'kehikot.claude', module: { mcp: { ...mcp, as: 'kehikko-claude' } } as never }, 'kehikot.claude')).toBe('kehikko-claude')
    expect(heldName({ id: 'kehikot.claude', module: { mcp } as never }, 'kehikot.claude')).toBe('claude')
    expect(heldName({ id: 'kehikot.page', module: { mcp: null } as never }, 'kehikot.page')).toBeNull()
    expect(heldName({ id: 'kehikot.asleep', module: null as never }, 'kehikot.asleep')).toBe('asleep')
    expect(heldName(undefined, 'kehikot.unseen')).toBe('unseen')
  })
})

/**
 * End to end over a real manifest: a program on loopback serving one, a
 * registration naming it, and `doorFor` reading the name off what it served.
 */
describe('the door read from a served manifest', () => {
  const dirs: string[] = []
  const servers: { stop(force?: boolean): unknown }[] = []
  const before = process.env.KEHIKOT_MODULES_DIR

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true)
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    /* Put back, never delete: see `test/setup.ts`. */
    if (before === undefined) delete process.env.KEHIKOT_MODULES_DIR
    else process.env.KEHIKOT_MODULES_DIR = before
  })

  function registry(): string {
    const dir = join(tmpdir(), `kehikko-door-name-${process.pid}-${dirs.length}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    dirs.push(dir)
    process.env.KEHIKOT_MODULES_DIR = dir
    return dir
  }

  /** A module answering with a manifest, registered in `dir`. Returns its origin. */
  function module(dir: string, id: string, mcp: Record<string, unknown> | undefined): string {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === WELL_KNOWN
          ? Response.json({
              kind: 'kehikot.module',
              protocol: 2,
              id,
              name: id,
              entry: '/app',
              modes: [{ id: 'main', label: 'Main' }],
              partless: 'Nothing in it belongs to a part of an epic.',
              ...(mcp ? { mcp } : {}),
            })
          : new Response('', { status: 404 }),
    })
    servers.push(server)
    const origin = `http://127.0.0.1:${server.port}`
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ url: origin }))
    return origin
  }

  test('the declared name is carried from the manifest to the door', async () => {
    const dir = registry()
    const origin = module(dir, 'kehikot.claude', { url: '/mcp', as: 'kehikko-claude' })

    const presence = await look({ id: 'kehikot.claude', url: origin } as never)
    expect(presence.module?.mcp).toMatchObject({ url: `${origin}/mcp`, as: 'kehikko-claude' })

    const found = await doorFor('kehikot.claude')
    expect(found).toEqual({
      ok: true,
      door: { module: 'kehikot.claude', as: 'kehikko-claude', url: `${origin}/mcp`, transport: 'http' },
    })
  })

  test('a module that declares nothing gets the name it always had', async () => {
    const dir = registry()
    const origin = module(dir, 'kehikot.checklist', { url: '/mcp' })
    const found = await doorFor('kehikot.checklist')
    expect(found.ok && found.door.as).toBe('checklist')
    const presence = await look({ id: 'kehikot.checklist', url: origin } as never)
    expect(presence.module?.mcp && 'as' in presence.module.mcp).toBe(false)
  })

  test('a name the protocol refuses is a manifest this host refuses, so nothing reaches a command line', async () => {
    const dir = registry()
    module(dir, 'kehikot.claude', { url: '/mcp', as: '--scope' })
    const found = await doorFor('kehikot.claude')
    expect(found.ok).toBe(false)
  })

  test('a declared name that is the host’s own is refused with the sentence', async () => {
    const dir = registry()
    module(dir, 'kehikot.claude', { url: '/mcp', as: HOST_ID })
    const found = await doorFor('kehikot.claude')
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.status).toBe(409)
    expect(found.why).toContain("this host's own door")
  })

  test('a declared name that is a registered neighbour’s is refused, and the neighbour keeps its door', async () => {
    const dir = registry()
    module(dir, 'kehikot.claude', { url: '/mcp', as: 'checklist' })
    const neighbour = module(dir, 'kehikot.checklist', { url: '/mcp' })

    const found = await doorFor('kehikot.claude')
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.status).toBe(409)
    expect(found.why).toContain("kehikot.checklist's door")

    const kept = await doorFor('kehikot.checklist')
    expect(kept.ok && kept.door).toEqual({ module: 'kehikot.checklist', as: 'checklist', url: `${neighbour}/mcp`, transport: 'http' })
  })

  test('what the last sweep saw of a neighbour decides: one seen to declare the same name refuses both', async () => {
    const dir = registry()
    const a = module(dir, 'kehikot.a', { url: '/mcp', as: 'shared' })
    const b = module(dir, 'kehikot.b', { url: '/mcp', as: 'shared' })
    const seen = new Map([
      ['kehikot.a', await look({ id: 'kehikot.a', url: a } as never)],
      ['kehikot.b', await look({ id: 'kehikot.b', url: b } as never)],
    ])
    const first = await doorFor('kehikot.a', seen)
    const second = await doorFor('kehikot.b', seen)
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
  })
})

describe('what the frame menu says', () => {
  test('a door connected under its old name is loud, and names both', () => {
    const saying = toolsSaying({ kind: 'renamed', as: 'claude', to: 'kehikko-claude' }, 'Claude')
    expect(saying?.loud).toBe(true)
    expect(saying?.state).not.toBe('connected')
    expect(saying?.hint).toContain('"claude"')
    expect(saying?.hint).toContain('"kehikko-claude"')
  })

  test('a refused name is loud, and the sentence is the host’s', () => {
    const why = nameRefusal('kehikot.claude', HOST_ID, new Map())!
    expect(toolsSaying({ kind: 'refused', why }, 'Claude')).toEqual({ state: 'name refused', loud: true, hint: why })
  })
})
