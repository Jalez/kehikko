import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { epicPartsOf, spaceWithin, type SpaceNode } from 'kehikot-module-protocol'

import { open as openDb, readSubject, setSubject, spaceOfSubject } from '../server/canvases.ts'
import { epicsDir, hostPath } from '../server/hostData.ts'
import { listEpics } from '../server/holdings.ts'
import { addProject } from '../server/projects.ts'
import { SPACES_BACKUP, editSpaces, migrateSpaces, readSpacesFile, spaceEditIn, spaceTree } from '../server/spaces.ts'
import { parseView, serializeView } from '../server/view.ts'
import { toWireContext } from '../src/host/context.ts'
import { edited } from '../src/host/subject.ts'
import { spaceHere, standIn } from '../src/host/spaces.ts'

/**
 * Spaces (protocol 2.89.0): one tree of spaces, to any depth, in place of epic → parts.
 *
 * What has to hold: the epics become top-level spaces and their parts child spaces, once, with the
 * same ids, and every epic file stays where it was (copied aside, never moved); deeper spaces live in
 * `spaces.json`; the one writer edits every level; and epic and parts are still what an older module
 * is told, by the protocol's mapping.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-spaces-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let made = 0
function project(epics: Record<string, unknown>): string {
  const dir = join(root, `p${(made += 1)}`)
  mkdirSync(join(dir, '.kehikot', 'host', 'epics'), { recursive: true })
  for (const [slug, body] of Object.entries(epics)) {
    writeFileSync(join(dir, '.kehikot', 'host', 'epics', `${slug}.json`), `${JSON.stringify(body, null, 2)}\n`)
  }
  return dir
}

const AUTH = { slug: 'auth', title: 'Auth', parts: [{ id: 'login', name: 'Login' }, { id: 'signup', name: 'Sign-up' }] }
const BILLING = { slug: 'billing', title: 'Billing', parts: [{ id: 'login', name: 'Login' }] }

const ids = (tree: readonly SpaceNode[]): unknown => tree.map((node) => [node.id, ids(node.children)])

function epicFiles(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(epicsDir(dir)).map((file) => [file, readFileSync(join(epicsDir(dir), file), 'utf8')]))
}

describe('the migration', () => {
  test('adding a project makes its epics spaces', () => {
    const dir = project({ auth: AUTH })
    addProject(openDb(':memory:'), dir, undefined, true)
    expect(ids(readSpacesFile(dir)!.spaces)).toEqual([['auth', [['login', []], ['signup', []]]]])
  })

  test('epics become top-level spaces and parts child spaces, with the same ids', () => {
    const dir = project({ auth: AUTH, billing: BILLING })
    const before = epicFiles(dir)
    const done = migrateSpaces(dir, () => {}, '2026-11-12')
    expect(done).toEqual({ wrote: true, backedUp: 2 })
    const file = readSpacesFile(dir)!
    expect(file.migrated).toBe('2026-11-12')
    expect(ids(file.spaces)).toEqual([['auth', [['login', []], ['signup', []]]], ['billing', [['login', []]]]])
    expect(file.spaces[0]!.name).toBe('Auth')
    /* Read back: the tree is the epics. */
    expect(ids(spaceTree(dir))).toEqual(ids(file.spaces))
    /* Not one epic file moved or changed, and a copy of each is aside. */
    expect(epicFiles(dir)).toEqual(before)
    const backup = hostPath(dir, SPACES_BACKUP)!
    for (const [name, text] of Object.entries(before)) expect(readFileSync(join(backup, name), 'utf8')).toBe(text)
  })

  test('idempotent: a second start writes nothing', () => {
    const dir = project({ auth: AUTH })
    migrateSpaces(dir, () => {})
    const written = readFileSync(hostPath(dir, 'spaces.json')!, 'utf8')
    expect(migrateSpaces(dir, () => {})).toEqual({ wrote: false, backedUp: 0 })
    expect(readFileSync(hostPath(dir, 'spaces.json')!, 'utf8')).toBe(written)
  })

  test('a project with no epics is left as it is', () => {
    const dir = project({})
    expect(migrateSpaces(dir, () => {}).wrote).toBe(false)
    expect(existsSync(hostPath(dir, 'spaces.json')!)).toBe(false)
  })

  test('a downgrade still finds every epic file, and parts made after the migration in them', () => {
    const dir = project({ auth: AUTH })
    migrateSpaces(dir, () => {})
    editSpaces(dir, { create: { parent: ['auth'], name: 'Errors' } })
    editSpaces(dir, { create: { parent: ['auth', 'login'], name: 'Copy' } })
    /* What an older host reads: the epic file, with the new part in it. */
    const listed = listEpics(dir)
    expect(listed.map((one) => one.slug)).toEqual(['auth'])
    expect(listed[0]!.parts!.map((part) => part.id)).toEqual(['login', 'signup', 'errors'])
    /* An older host adds an epic meanwhile; the upgrade finds it, and keeps the deep space. */
    writeFileSync(join(epicsDir(dir), 'later.json'), `${JSON.stringify({ slug: 'later', title: 'Later' })}\n`)
    expect(ids(spaceTree(dir))).toEqual([['auth', [['login', [['copy', []]]], ['signup', []], ['errors', []]]], ['later', []]])
  })

  test('an epic file removed by hand hides its space but keeps what was under it, for when it comes back', () => {
    const dir = project({ auth: AUTH })
    migrateSpaces(dir, () => {})
    editSpaces(dir, { create: { parent: ['auth', 'login'], name: 'Copy' } })
    const text = readFileSync(join(epicsDir(dir), 'auth.json'), 'utf8')
    rmSync(join(epicsDir(dir), 'auth.json'))
    expect(spaceTree(dir)).toEqual([])
    writeFileSync(join(epicsDir(dir), 'auth.json'), text)
    expect(ids(spaceTree(dir))).toEqual([['auth', [['login', [['copy', []]]], ['signup', []]]]])
  })
})

describe('the one writer', () => {
  test('deep nesting: spaces under spaces, to any depth', () => {
    const dir = project({ auth: AUTH })
    let parent = ['auth', 'login']
    for (let n = 0; n < 6; n += 1) {
      const done = editSpaces(dir, { create: { parent, name: `Level ${n}` } })
      expect(done.outcome).toBe('changed')
      parent = done.path!
    }
    expect(parent.length).toBe(8)
    expect(parent.slice(0, 3)).toEqual(['auth', 'login', 'level-0'])
  })

  test('the top two levels are epic files and their parts; below is spaces.json', () => {
    const dir = project({})
    expect(editSpaces(dir, { create: { parent: [], name: 'Search' } }).path).toEqual(['search'])
    expect(existsSync(join(epicsDir(dir), 'search.json'))).toBe(true)
    expect(editSpaces(dir, { create: { parent: ['search'], name: 'Ranking' } }).path).toEqual(['search', 'ranking'])
    expect(JSON.parse(readFileSync(join(epicsDir(dir), 'search.json'), 'utf8')).parts).toEqual([{ id: 'ranking', name: 'Ranking' }])
    expect(editSpaces(dir, { create: { parent: ['search', 'ranking'], name: 'Ties' } }).path).toEqual(['search', 'ranking', 'ties'])
    /* A new id is unique in the whole tree. */
    expect(editSpaces(dir, { create: { parent: ['search', 'ranking'], name: 'Ranking' } }).path).toEqual(['search', 'ranking', 'ranking-2'])
  })

  test('rename at every level', () => {
    const dir = project({ auth: AUTH })
    editSpaces(dir, { create: { parent: ['auth', 'login'], name: 'Copy' } })
    expect(editSpaces(dir, { rename: { path: ['auth'], name: 'Identity' } }).outcome).toBe('changed')
    expect(JSON.parse(readFileSync(join(epicsDir(dir), 'auth.json'), 'utf8')).title).toBe('Identity')
    expect(editSpaces(dir, { rename: { path: ['auth', 'login'], name: 'Sign-in' } }).outcome).toBe('changed')
    expect(editSpaces(dir, { rename: { path: ['auth', 'login', 'copy'], name: 'Words' } }).outcome).toBe('changed')
    const tree = spaceTree(dir)
    expect([tree[0]!.name, tree[0]!.children[0]!.name, tree[0]!.children[0]!.children[0]!.name]).toEqual(['Identity', 'Sign-in', 'Words'])
    /* Ids never change on a rename. */
    expect(ids(tree)).toEqual([['auth', [['login', [['copy', []]]], ['signup', []]]]])
  })

  test('move: reorder at every level, and a deep space under another', () => {
    const dir = project({ auth: AUTH, billing: BILLING })
    migrateSpaces(dir, () => {})
    expect(editSpaces(dir, { move: { path: ['billing'], after: null } }).outcome).toBe('changed')
    expect(spaceTree(dir).map((node) => node.id)).toEqual(['billing', 'auth'])
    expect(editSpaces(dir, { move: { path: ['auth', 'signup'], after: null } }).outcome).toBe('changed')
    expect(spaceTree(dir)[1]!.children.map((node) => node.id)).toEqual(['signup', 'login'])
    editSpaces(dir, { create: { parent: ['auth', 'login'], name: 'Copy' } })
    expect(editSpaces(dir, { move: { path: ['auth', 'login', 'copy'], parent: ['billing', 'login'] } }).path).toEqual(['billing', 'login', 'copy'])
    expect(editSpaces(dir, { move: { path: ['auth', 'login'], parent: ['billing'] } }).outcome).toBe('declined')
    expect(editSpaces(dir, { move: { path: ['billing', 'login', 'copy'], parent: ['billing', 'login', 'copy'] } }).outcome).toBe('declined')
  })

  test('remove asks first, says what goes, and never touches another space', () => {
    const dir = project({ auth: AUTH })
    editSpaces(dir, { create: { parent: ['auth', 'login'], name: 'Copy' } })
    const asked = editSpaces(dir, { remove: { path: ['auth', 'login'] } })
    expect(asked.outcome).toBe('confirm')
    expect(asked.why).toContain('the 1 space under it')
    expect(ids(spaceTree(dir))).toEqual([['auth', [['login', [['copy', []]]], ['signup', []]]]])
    expect(editSpaces(dir, { remove: { path: ['auth', 'login'], confirm: true } }).outcome).toBe('changed')
    expect(ids(spaceTree(dir))).toEqual([['auth', [['signup', []]]]])
    expect(editSpaces(dir, { remove: { path: ['nope'], confirm: true } }).outcome).toBe('no-such-space')
  })

  test('a request body names exactly one edit', () => {
    expect(spaceEditIn({ create: { parent: ['a'], name: 'x' } })).toEqual({ create: { parent: ['a'], name: 'x', id: undefined, after: undefined } })
    expect(spaceEditIn({ create: {}, rename: {} })).toBeNull()
    expect(spaceEditIn({ remove: { path: [] } })).toBeNull()
  })
})

describe('the subject: a space, and epic and parts still', () => {
  function withProject(): { db: Database; id: number } {
    const db = openDb(':memory:')
    const dir = project({ auth: AUTH })
    const added = addProject(db, dir, undefined, true)
    if (!added.ok) throw new Error(added.why)
    return { db, id: added.project.id }
  }

  test('a deep space is kept beside the epic and part it maps to', () => {
    const { db, id } = withProject()
    const now = setSubject(db, id, { space: { ids: ['auth', 'login', 'errors', 'copy'] } })!
    expect(now.epic).toBe('auth')
    expect(now.parts).toEqual(['login'])
    expect(now.space).toEqual({ ids: ['auth', 'login', 'errors', 'copy'], picked: [] })
    expect(readSubject(db, id)).toEqual(now)
  })

  test('what epic and parts can say is said by them alone, exactly as before', () => {
    const { db, id } = withProject()
    expect(setSubject(db, id, { space: { ids: ['auth', 'login'] } })).toEqual({ epic: 'auth', parts: ['login'], selection: [] })
    expect(setSubject(db, id, { space: { ids: ['auth'], picked: ['login', 'signup'] } })).toEqual({ epic: 'auth', parts: ['login', 'signup'], selection: [] })
    expect(setSubject(db, id, { space: { ids: ['auth'], picked: ['login'] } })).toEqual({ epic: 'auth', parts: ['login'], selection: [] })
  })

  test('naming an epic or parts leaves a deep space; an older host that moved the project drops it', () => {
    const { db, id } = withProject()
    setSubject(db, id, { space: { ids: ['auth', 'login', 'errors'] } })
    expect(setSubject(db, id, { selection: ['gh#1'] })!.space).toEqual({ ids: ['auth', 'login', 'errors'], picked: [] })
    expect(setSubject(db, id, { parts: ['signup'] })!.space).toBeUndefined()
    setSubject(db, id, { space: { ids: ['auth', 'login', 'errors'] } })
    /* An older host writes only the columns it knows. */
    db.query("update projects set parts = '[\"signup\"]' where id = ?").run(id)
    expect(readSubject(db, id)!.space).toBeUndefined()
    expect(spaceOfSubject(readSubject(db, id)!)).toEqual({ ids: ['auth', 'signup'], picked: [] })
  })

  test('the page agrees with the server', () => {
    const was = { epic: null, parts: [], selection: [] }
    expect(edited(was, { space: { ids: ['auth', 'login', 'errors'] } })).toEqual({
      epic: 'auth',
      parts: ['login'],
      selection: [],
      space: { ids: ['auth', 'login', 'errors'], picked: [] },
    })
    expect(standIn(['auth'], ['login'])).toEqual({ epic: 'auth', parts: ['login'] })
  })

  test('the personal view file keeps a deep space, and an older one reads as before', () => {
    const subject = { epic: 'auth', parts: ['login'], selection: [], space: { ids: ['auth', 'login', 'errors'], picked: [] } }
    const text = serializeView({ subject, kehikot: new Map() })
    expect(parseView(text)!.subject).toEqual(subject)
    const older = serializeView({ subject: { epic: 'auth', parts: ['login'], selection: [] }, kehikot: new Map() })
    expect(older).not.toContain('space')
  })
})

describe('what a module is told', () => {
  const tree: SpaceNode[] = [
    { id: 'auth', name: 'Auth', children: [{ id: 'login', name: 'Login', children: [{ id: 'errors', name: 'Errors', children: [] }] }] },
  ]

  test('context.space, and epic and parts by the mapping, on any kehikko at any depth', () => {
    const about = { epic: 'auth', parts: ['login'], selection: [], space: { ids: ['auth', 'login', 'errors'], picked: [] } }
    const space = spaceHere(tree, about)
    for (const kehikko of [{ id: 1, name: 'Writing', key: 'aaaa1111' }, { id: 2, name: 'Review', key: 'bbbb2222' }]) {
      const ctx = toWireContext({ epic: 'auth', project: null, space }, 'light', [], kehikko)
      expect(ctx.space?.path.map((step) => step.name)).toEqual(['Auth', 'Login', 'Errors'])
      expect(ctx.epic).toBe('auth')
      expect(ctx.kehikko?.key).toBe(kehikko.key)
      expect(epicPartsOf(ctx.space)).toEqual({ epic: 'auth', parts: ['login'] })
      expect(spaceWithin(ctx.space, ['auth', 'login', 'errors', 'deeper'])).toBe(true)
    }
  })

  test('no space for an older caller, and none on All spaces', () => {
    expect(toWireContext({ epic: 'auth', project: null }, 'light').space).toBeNull()
    expect(toWireContext({ epic: null, scope: 'project', project: null, space: spaceHere(tree, { epic: 'auth', parts: [] }) }, 'light').space).toBeNull()
  })
})
