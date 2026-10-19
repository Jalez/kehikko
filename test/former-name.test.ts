import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL, WELL_KNOWN } from 'kehikot-module-protocol'

import { open } from '../server/canvases.ts'
import { look } from '../server/discover.ts'
import { forgetFormerName, migrateRegistrations } from '../server/formerName.ts'
import { ensureInbox } from '../server/inbox.ts'
import { ensureKnown } from '../server/known.ts'
import { readRegistrations } from '../server/registrations.ts'
import { attention } from '../src/host/moduleMenu.ts'

/**
 * The once-at-start clean-up of what was stored under the app's former name
 * (`server/formerName.ts`). Every location is a scratch directory handed in
 * through `env`; nothing here reads the real registry or the real home.
 */

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'kehikko-former-'))
  const registry = join(root, 'modules')
  const home = join(root, 'home')
  mkdirSync(registry, { recursive: true })
  mkdirSync(home, { recursive: true })
  return { root, registry, home, env: { KEHIKOT_MODULES_DIR: registry, HOME: home } }
}

function put(file: string, body: string, secondsAgo: number) {
  writeFileSync(file, body)
  const t = Date.now() / 1000 - secondsAgo
  utimesSync(file, t, t)
}

const silent = () => {}

describe('registrations', () => {
  test('an old file with no twin becomes the new one, and is set aside as .migrated', async () => {
    const { registry, env } = scratch()
    put(join(registry, 'roadmap.checklist.json'), '{"port":7860}', 100)
    const lines: string[] = []
    migrateRegistrations(env, (l) => lines.push(l))
    expect(readFileSync(join(registry, 'kehikot.checklist.json'), 'utf8')).toBe('{"port":7860}')
    expect(existsSync(join(registry, 'roadmap.checklist.json'))).toBe(false)
    expect(existsSync(join(registry, 'roadmap.checklist.json.migrated'))).toBe(true)
    expect(lines).toEqual(['renamed registration roadmap.checklist → kehikot.checklist'])
    const read = await readRegistrations(registry)
    expect(read.registrations.map((r) => r.id)).toEqual(['kehikot.checklist'])
  })

  test('a newer twin is kept', () => {
    const { registry, env } = scratch()
    put(join(registry, 'roadmap.notes.json'), '{"port":1}', 500)
    put(join(registry, 'kehikot.notes.json'), '{"port":2}', 10)
    migrateRegistrations(env, silent)
    expect(readFileSync(join(registry, 'kehikot.notes.json'), 'utf8')).toBe('{"port":2}')
    expect(existsSync(join(registry, 'roadmap.notes.json.migrated'))).toBe(true)
    expect(readdirSync(registry).filter((n) => n.endsWith('.replaced'))).toEqual([])
  })

  test('an older twin is replaced by the newer old file, and set aside rather than lost', () => {
    const { registry, env } = scratch()
    put(join(registry, 'roadmap.notes.json'), '{"port":1}', 10)
    put(join(registry, 'kehikot.notes.json'), '{"port":2}', 500)
    migrateRegistrations(env, silent)
    expect(readFileSync(join(registry, 'kehikot.notes.json'), 'utf8')).toBe('{"port":1}')
    expect(readFileSync(join(registry, 'kehikot.notes.json.replaced'), 'utf8')).toBe('{"port":2}')
    expect(existsSync(join(registry, 'roadmap.notes.json.migrated'))).toBe(true)
  })

  test('yaml keeps its extension and its body', () => {
    const { registry, env } = scratch()
    put(join(registry, 'roadmap.paper.yaml'), 'port: 7812\ndir: /somewhere\n', 100)
    migrateRegistrations(env, silent)
    expect(readFileSync(join(registry, 'kehikot.paper.yaml'), 'utf8')).toBe('port: 7812\ndir: /somewhere\n')
    expect(existsSync(join(registry, 'roadmap.paper.yaml.migrated'))).toBe(true)
  })

  test('a second run finds nothing to do', () => {
    const { registry, env } = scratch()
    put(join(registry, 'roadmap.checklist.json'), '{"port":7860}', 100)
    migrateRegistrations(env, silent)
    const before = readdirSync(registry).sort()
    const lines: string[] = []
    migrateRegistrations(env, (l) => lines.push(l))
    expect(lines).toEqual([])
    expect(readdirSync(registry).sort()).toEqual(before)
  })

  test('an old checkout writing its old file again is migrated again, harmlessly', () => {
    const { registry, env } = scratch()
    put(join(registry, 'roadmap.checklist.json'), '{"port":7860}', 100)
    migrateRegistrations(env, silent)
    put(join(registry, 'roadmap.checklist.json'), '{"port":7861}', 0)
    migrateRegistrations(env, silent)
    expect(readFileSync(join(registry, 'kehikot.checklist.json'), 'utf8')).toBe('{"port":7861}')
    expect(existsSync(join(registry, 'roadmap.checklist.json'))).toBe(false)
    expect(readdirSync(registry).filter((n) => n.startsWith('roadmap.checklist.json.migrated'))).toHaveLength(2)
  })

  test('~/.roadmap/modules is copied from and left untouched, once', () => {
    const { registry, home, env } = scratch()
    const former = join(home, '.roadmap', 'modules')
    mkdirSync(former, { recursive: true })
    put(join(former, 'roadmap.history.json'), '{"port":7870}', 100)
    const lines: string[] = []
    migrateRegistrations(env, (l) => lines.push(l))
    expect(readFileSync(join(registry, 'kehikot.history.json'), 'utf8')).toBe('{"port":7870}')
    expect(readdirSync(former)).toEqual(['roadmap.history.json'])
    expect(lines).toHaveLength(1)
    migrateRegistrations(env, (l) => lines.push(l))
    expect(lines).toHaveLength(1)
  })
})

function database(root: string) {
  const db = open(join(root, 'frame.sqlite'))
  ensureKnown(db)
  ensureInbox(db)
  return db
}

describe('the canvases database', () => {
  test('every module id column is respelled, and a row already there under the new name wins', () => {
    const { root, env } = scratch()
    const db = database(root)
    db.run("insert into projects (name, path, rank) values ('p', ?, 0)", [join(root, 'nowhere')])
    db.run("insert into canvases (id, name, rank) values (1, 'one', 0)")
    const place = (module: string, x: number, promptFor: string | null = null) =>
      db.run('insert into placements (canvas, module, x, y, w, h, prompt_for) values (1, ?, ?, 0, 1, 1, ?)', [module, x, promptFor])
    place('roadmap.checklist', 1, 'roadmap.notes')
    place('roadmap.notes', 2)
    place('kehikot.notes', 3)
    db.run("insert into module_state (module, state) values ('roadmap.checklist', 'old'), ('roadmap.notes', 'old'), ('kehikot.notes', 'new')")
    db.run("insert into known_modules (id, name, seen) values ('roadmap.checklist', 'Checklist', 1)")
    db.run(
      "insert into inbox_items (project, module, id, state, label, entered, opened, touched) values (1, 'roadmap.checklist', 'a', 'open', 'L', 1, 1, 1)",
    )
    db.run("insert into inbox_moves (project, module, id, state, at, label) values (1, 'roadmap.checklist', 'a', 'open', 1, 'L')")

    const lines = forgetFormerName(db, env, silent)
    expect(lines.length).toBeGreaterThan(0)
    const rows = db.query<{ module: string; x: number; prompt_for: string | null }, []>(
      'select module, x, prompt_for from placements order by module',
    ).all()
    expect(rows).toEqual([
      { module: 'kehikot.checklist', x: 1, prompt_for: 'kehikot.notes' },
      { module: 'kehikot.notes', x: 3, prompt_for: null },
    ])
    expect(db.query('select module, state from module_state order by module').all()).toEqual([
      { module: 'kehikot.checklist', state: 'old' },
      { module: 'kehikot.notes', state: 'new' },
    ])
    expect(db.query('select id from known_modules').all()).toEqual([{ id: 'kehikot.checklist' }])
    expect(db.query('select module from inbox_items').all()).toEqual([{ module: 'kehikot.checklist' }])
    expect(db.query('select module from inbox_moves').all()).toEqual([{ module: 'kehikot.checklist' }])

    expect(forgetFormerName(db, env, silent)).toEqual([])
  })

  test('a database with nothing old in it is not touched', () => {
    const { root, env } = scratch()
    const db = database(root)
    expect(forgetFormerName(db, env, silent)).toEqual([])
  })
})

describe('project files', () => {
  test('kehikot.json: module ids respelled, every other character kept', () => {
    const { root, env } = scratch()
    const project = join(root, 'project')
    const dir = join(project, '.kehikot', 'host')
    mkdirSync(dir, { recursive: true })
    const text = [
      '{',
      '  "version": 2,',
      '  "kehikot": [',
      '    {',
      '      "key": "main",',
      '      "name": "roadmap.checklist stays in a name",',
      '      "containers": [',
      '        {"module":"roadmap.checklist","x":0,"y":0,"w":4,"h":4,"prompt":"see roadmap.notes","promptFor":"roadmap.notes"}',
      '      ]',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n')
    writeFileSync(join(dir, 'kehikot.json'), text)
    writeFileSync(join(dir, 'data-versions.json'), '{"roadmap.notes": 2, "kehikot.notes": 3, "kehikot.paper": 1}\n')
    const db = database(root)
    db.run("insert into projects (name, path, rank) values ('p', ?, 0)", [project])
    forgetFormerName(db, env, silent)
    expect(readFileSync(join(dir, 'kehikot.json'), 'utf8')).toBe(
      text.replace('"module":"roadmap.checklist"', '"module":"kehikot.checklist"').replace('"promptFor":"roadmap.notes"', '"promptFor":"kehikot.notes"'),
    )
    expect(JSON.parse(readFileSync(join(dir, 'data-versions.json'), 'utf8'))).toEqual({ 'kehikot.notes': 3, 'kehikot.paper': 1 })
  })

  test('kehikot.json holding a module under both names keeps the new one', () => {
    const { root, env } = scratch()
    const project = join(root, 'project')
    const dir = join(project, '.kehikot', 'host')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'kehikot.json'),
      JSON.stringify({
        version: 2,
        kehikot: [{ key: 'main', name: 'Main', containers: [{ module: 'roadmap.notes', x: 0 }, { module: 'kehikot.notes', x: 5 }] }],
      }),
    )
    const db = database(root)
    db.run("insert into projects (name, path, rank) values ('p', ?, 0)", [project])
    forgetFormerName(db, env, silent)
    const after = JSON.parse(readFileSync(join(dir, 'kehikot.json'), 'utf8'))
    expect(after.kehikot[0].containers).toEqual([{ module: 'kehikot.notes', x: 5 }])
  })

  test('.kehikot/roadmap/{epics,state} is copied when .kehikot/host has none', () => {
    const { root, env } = scratch()
    const project = join(root, 'project')
    mkdirSync(join(project, '.kehikot', 'roadmap', 'epics'), { recursive: true })
    writeFileSync(join(project, '.kehikot', 'roadmap', 'epics', 'one.json'), '{}')
    const db = database(root)
    db.run("insert into projects (name, path, rank) values ('p', ?, 0)", [project])
    forgetFormerName(db, env, silent)
    expect(readFileSync(join(project, '.kehikot', 'host', 'epics', 'one.json'), 'utf8')).toBe('{}')
    expect(existsSync(join(project, '.kehikot', 'roadmap', 'epics', 'one.json'))).toBe(true)
  })
})

describe('the sentence for an old registration file', () => {
  const AT = 'http://127.0.0.1:7860'
  const serving = (id: string) =>
    (async (input: string | URL) => {
      if (!String(input).endsWith(WELL_KNOWN)) return new Response('', { status: 404 })
      return new Response(
        JSON.stringify({
          kind: 'kehikot.module',
          protocol: PROTOCOL,
          id,
          name: 'Checklist',
          version: '1.0.0',
          summary: '',
          entry: '/',
          modes: [{ id: 'list', label: 'List' }],
          declares: { protocol: `>=${PROTOCOL}`, uses: [], storage: false },
          partless: 'A checklist is the whole epic.',
        }),
      )
    }) as unknown as typeof fetch

  test('names the file and how to fix it, and nothing about starting it again', async () => {
    const presence = await look(
      { id: 'roadmap.checklist', url: AT, file: '/reg/roadmap.checklist.json' },
      serving('kehikot.checklist'),
    )
    expect(presence.condition).toBe('silent')
    expect(presence.remedy).toBe(true)
    expect(presence.line).toBe(
      'The registration roadmap.checklist.json in /reg is from before Kehikot was renamed: the program at http://127.0.0.1:7860 is kehikot.checklist. '
        + 'Rename the file to kehikot.checklist.json; Kehikot also renames it the next time it starts.',
    )
    expect(attention(presence)).toBe(presence.line)
  })

  test('any other mismatch keeps the ordinary sentence', async () => {
    const presence = await look({ id: 'roadmap.checklist', url: AT, file: '/reg/roadmap.checklist.json' }, serving('kehikot.notes'))
    expect(presence.remedy).toBeUndefined()
    expect(presence.line).toContain('calls itself kehikot.notes')
  })
})
