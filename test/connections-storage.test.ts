import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'

import { createCanvas, editCanvas, listCanvases, open as openDb } from '../server/canvases.ts'
import { kehikotFile, keep, parse, serialize, syncProject } from '../server/kehikot.ts'
import { addProject, type Project } from '../server/projects.ts'
import { AUTOMATIC, HOST_NODE, switched, type ConnectionsSetting } from '../src/host/connections.ts'
import { olderHostReads } from './fixtures/pre-split/reader.ts'

/*
 * The switches are the kehikko's, kept with its arrangement in `kehikot.json`: they say how the
 * kehikko works, so they are SHARED and travel with the project. Written only when the person
 * changed one, so a kehikko on automatic is the same file it always was.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-connections-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let made = 0
const folder = () => {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const project = (store: ReturnType<typeof openDb>, dir: string): Project => {
  const out = addProject(store, dir, undefined, false)
  if (!out.ok) throw new Error(out.why)
  return out.project
}
const notes = { i: 'kehikot.notes', x: 0, y: 0, w: 6, h: 20 }
const paper = { i: 'kehikot.paper', x: 6, y: 0, w: 6, h: 20 }

const SWITCHED: ConnectionsSetting = switched(
  switched(AUTOMATIC, { kind: 'passage', from: 'kehikot.paper', to: 'kehikot.notes', about: '' }, false),
  { kind: 'parts', from: HOST_NODE, to: 'kehikot.notes', about: '' },
  false,
)

describe('in the database', () => {
  test('a kehikko is automatic until changed, and keeps what it is given', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    const one = createCanvas(store, 'one', p.id)
    expect(one.connections).toEqual(AUTOMATIC)
    editCanvas(store, one.id, { connections: SWITCHED })
    expect(listCanvases(store).find((c) => c.id === one.id)!.connections).toEqual(SWITCHED)
    /* An edit of the placements leaves them alone. */
    editCanvas(store, one.id, { placements: [notes] })
    expect(listCanvases(store).find((c) => c.id === one.id)!.connections).toEqual(SWITCHED)
    editCanvas(store, one.id, { connections: AUTOMATIC })
    expect(listCanvases(store).find((c) => c.id === one.id)!.connections).toEqual(AUTOMATIC)
  })
})

describe('in kehikot.json', () => {
  test('written beside the name, read back the same, and carried to another computer', () => {
    const dir = folder()
    const here = openDb(':memory:')
    const p = project(here, dir)
    const one = createCanvas(here, 'writing', p.id)
    editCanvas(here, one.id, { placements: [notes, paper], connections: SWITCHED })
    keep(here, p.id)
    const text = readFileSync(kehikotFile(dir)!, 'utf8')
    expect(text).toContain('"connections": {"off":[')
    const read = parse(text)
    expect(read.ok && read.kehikot[0]!.connections).toEqual(SWITCHED)

    const there = openDb(':memory:')
    const q = project(there, dir)
    expect(syncProject(there, q).outcome).toBe('read')
    expect(listCanvases(there)[0]!.connections).toEqual(SWITCHED)
  })

  test('a kehikko on automatic writes no line: the file an older host has always read', () => {
    const store = openDb(':memory:')
    const p = project(store, folder())
    const one = createCanvas(store, 'one', p.id)
    editCanvas(store, one.id, { placements: [notes] })
    const text = serialize(listCanvases(store))
    expect(text).not.toContain('connections')
  })

  test('a change made in the file (a pull) is what the database holds after the next read', () => {
    const dir = folder()
    const store = openDb(':memory:')
    const p = project(store, dir)
    const one = createCanvas(store, 'one', p.id)
    editCanvas(store, one.id, { placements: [notes, paper] })
    keep(store, p.id)
    const file = kehikotFile(dir)!
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace(/("name": "one",)/, `$1\n      "connections": ${JSON.stringify(SWITCHED)},`))
    expect(syncProject(store, p)).toMatchObject({ outcome: 'read', changed: true })
    expect(listCanvases(store)[0]!.connections).toEqual(SWITCHED)
  })

  test('a setting that will not read refuses the file, with the reason, and nothing is written over it', () => {
    const text = serialize([{ id: 1, key: 'one', name: 'one', project: null, placements: [], connections: SWITCHED }]).replace('"kind":"passage"', '"kind":"telepathy"')
    const read = parse(text)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.why).toContain('connections')
  })

  test('an older host refuses a file that carries switches, naming the field (the break accepted for rows)', () => {
    const text = serialize([{ id: 1, key: 'one', name: 'one', project: null, placements: [], connections: SWITCHED }])
    const halved = JSON.parse(text) as { rows?: number }
    delete halved.rows
    const older = olderHostReads(JSON.stringify(halved))
    expect(older.success).toBe(false)
    if (older.success) return
    expect(older.error.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['connections'] })
    /* The same kehikko on automatic is read. */
    const plain = JSON.parse(serialize([{ id: 1, key: 'one', name: 'one', project: null, placements: [], connections: AUTOMATIC }])) as { rows?: number }
    delete plain.rows
    expect(olderHostReads(JSON.stringify(plain)).success).toBe(true)
  })
})

describe('read_canvas', () => {
  test('lists the connections and whether each is on; no tool changes them', async () => {
    const { call, TOOL_NAMES } = await import('../server/mcp.ts')
    const { Openness } = await import('../server/open.ts')
    const store = openDb(':memory:')
    const p = project(store, folder())
    const one = createCanvas(store, 'one', p.id)
    editCanvas(store, one.id, { placements: [{ ...notes, wish: 20 }, { ...paper, wish: 20 }] as never, connections: SWITCHED })
    const manifest = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/manifests', `${name}.json`), 'utf8'))
    const openness = new Openness()
    const read = await call('read_canvas', { kehikko: one.id }, {
      db: store,
      which: () => openness.open(),
      wake: () => {},
      epicsChanged: () => {},
      dispositionsChanged: () => {},
      seen: async () => [
        { id: 'kehikot.notes', name: 'Notes', condition: 'ready', manifest: manifest('notes') },
        { id: 'kehikot.paper', name: 'Paper', condition: 'ready', manifest: manifest('paper') },
      ],
    } as never)
    expect(read.text).toContain('connections between modules here')
    expect(read.text).toContain('[off] passage: Notes doesn’t follow Paper’s passage here.')
    expect(read.text).toContain('[on]  passage: Paper follows the passage Notes points at.')
    expect(read.text).toContain('[off] parts: Notes shows the whole epic here, whatever parts are picked.')
    /* There is no tool for it: the person decides. */
    const names: readonly string[] = TOOL_NAMES
    expect(names.some((name) => /connection/.test(name))).toBe(false)
  })
})
