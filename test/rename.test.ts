import { describe, expect, test } from 'bun:test'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'
import { LEGACY_WELL_KNOWN, MESSAGE, PROTOCOL, WELL_KNOWN } from 'kehikot-module-protocol'

import { Conversation, type Answer } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { open } from '../server/canvases.ts'
import { look } from '../server/discover.ts'
import { parse, serialize } from '../server/kehikot.ts'
import { originEnv } from '../server/launch.ts'
import { readRegistration, readRegistrations } from '../server/registrations.ts'

/*
 * The app was called "roadmap" before it was Kehikot, and every module built
 * before the rename still speaks that name: `roadmap.module` at
 * `/.well-known/roadmap-module.json`, `roadmap.*` on the wire, `roadmap.x` ids.
 * These hold the host to treating such a module as exactly the module it was,
 * under its new canonical id `kehikot.x`.
 */

const AT = 'http://127.0.0.1:7940'

const oldManifest = {
  kind: 'roadmap.module',
  protocol: PROTOCOL,
  id: 'roadmap.notes',
  name: 'Notes',
  entry: '/app',
  modes: [{ id: 'notes', label: 'Notes' }],
  extensions: { emits: ['roadmap.notifications@1'], consumes: [] },
  declares: { protocol: `>=${PROTOCOL} <${PROTOCOL + 1}` },
}

/** A fetch that serves one document at one path and 404s everything else. */
function servingAt(path: string, document: unknown) {
  const asked: string[] = []
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    asked.push(new URL(url).pathname)
    if (!url.endsWith(path)) return new Response('not here', { status: 404 })
    return new Response(JSON.stringify(document), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, asked }
}

describe('an unchanged module is found', () => {
  test('at the old well-known path, under its old kind, as the same module', async () => {
    const { fetchImpl, asked } = servingAt(LEGACY_WELL_KNOWN, oldManifest)
    const presence = await look({ id: 'kehikot.notes', url: AT, file: '/r/roadmap.notes.json' }, fetchImpl)
    expect(asked).toEqual([WELL_KNOWN, LEGACY_WELL_KNOWN])
    expect(presence.condition).toBe('ready')
    expect(presence.module?.id).toBe('kehikot.notes')
    expect(presence.module?.dialect).toBe('roadmap')
    expect(presence.module?.extensions.emits).toEqual(['kehikot.notifications@1'])
  })

  test('a current module is asked once, at the current path, and speaks the current dialect', async () => {
    const { fetchImpl, asked } = servingAt(WELL_KNOWN, { ...oldManifest, kind: 'kehikot.module', id: 'kehikot.notes' })
    const presence = await look({ id: 'kehikot.notes', url: AT, file: '/r/kehikot.notes.json' }, fetchImpl)
    expect(asked).toEqual([WELL_KNOWN])
    expect(presence.module?.dialect).toBe('kehikot')
  })

  test('nothing at either path is still said about the current one', async () => {
    const { fetchImpl } = servingAt('/nowhere', {})
    const presence = await look({ id: 'kehikot.notes', url: AT, file: '/r/x.json' }, fetchImpl)
    expect(presence.condition).toBe('silent')
    expect(presence.line).toContain(WELL_KNOWN)
  })
})

describe('registrations', () => {
  test('roadmap.x.json registers kehikot.x', () => {
    const read = readRegistration('roadmap.history.json', '{"url":"http://127.0.0.1:7960"}')
    expect(read.ok && read.registration.id).toBe('kehikot.history')
  })

  test('one module under both spellings is one registration, the newest file winning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kehikot-rename-registry-'))
    writeFileSync(join(dir, 'roadmap.notes.json'), '{"url":"http://127.0.0.1:7940"}')
    writeFileSync(join(dir, 'kehikot.notes.json'), '{"url":"http://127.0.0.1:7941"}')
    utimesSync(join(dir, 'roadmap.notes.json'), new Date(2_000_000_000_000), new Date(2_000_000_000_000))
    utimesSync(join(dir, 'kehikot.notes.json'), new Date(1_000_000_000_000), new Date(1_000_000_000_000))
    const swept = await readRegistrations(dir)
    expect(swept.registrations.map((r) => [r.id, r.url])).toEqual([['kehikot.notes', 'http://127.0.0.1:7940']])
  })
})

describe('the canvases database', () => {
  test('old module ids are respelled on open, idempotently, keeping the new row where both exist', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'kehikot-rename-db-')), 'frame.sqlite')
    open(file).close()
    const raw = new Database(file)
    raw.exec(`
      insert into canvases (id, name, rank) values (1, 'one', 0);
      insert into placements (canvas, module, x, y, w, h, prompt_for) values (1, 'roadmap.notes', 0, 0, 6, 10, 'roadmap.paper');
      insert into placements (canvas, module, x, y, w, h) values (1, 'roadmap.paper', 6, 0, 6, 10);
      insert into placements (canvas, module, x, y, w, h) values (1, 'kehikot.paper', 0, 10, 6, 10);
      insert into placements (canvas, module, x, y, w, h) values (1, 'acme.charts', 0, 20, 6, 10);
      insert into module_state (module, state) values ('roadmap.notes', 'kept');
      create table if not exists known_modules (id text primary key, name text not null, seen integer not null);
      insert into known_modules (id, name, seen) values ('roadmap.paper', 'Paper', 1);
    `)
    raw.close()

    for (let i = 0; i < 2; i++) {
      const db = open(file)
      const rows = db.query<{ module: string; prompt_for: string | null; y: number }, []>(
        'select module, prompt_for, y from placements order by module',
      ).all()
      expect(rows).toEqual([
        { module: 'acme.charts', prompt_for: null, y: 20 },
        { module: 'kehikot.notes', prompt_for: 'kehikot.paper', y: 0 },
        { module: 'kehikot.paper', prompt_for: null, y: 10 },
      ])
      expect(db.query('select module, state from module_state').all()).toEqual([{ module: 'kehikot.notes', state: 'kept' }])
      expect(db.query('select id from known_modules').all()).toEqual([{ id: 'kehikot.paper' }])
      db.close()
    }
  })
})

describe('a project’s kehikot.json', () => {
  test('written before the rename, it reads as the new ids and is written back in them', () => {
    const text = JSON.stringify({
      version: 2,
      epic: null,
      selection: [],
      kehikot: [
        {
          key: 'abc',
          name: 'one',
          containers: [{ module: 'roadmap.journeys', x: 0, y: 0, w: 6, h: 10, promptFor: 'roadmap.notes' }],
        },
      ],
    })
    const read = parse(text)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.kehikot[0]?.containers[0]?.module).toBe('kehikot.journeys')
    expect(read.kehikot[0]?.containers[0]?.promptFor).toBe('kehikot.notes')
  })

  test('the same module under both spellings on one kehikko is one module twice, which is refused', () => {
    const read = parse(
      JSON.stringify({
        version: 2,
        kehikot: [
          {
            key: 'abc',
            name: 'one',
            containers: [
              { module: 'roadmap.notes', x: 0, y: 0, w: 6, h: 10 },
              { module: 'kehikot.notes', x: 6, y: 0, w: 6, h: 10 },
            ],
          },
        ],
      }),
    )
    expect(read.ok).toBe(false)
  })

  test('serialize writes only what it was given', () => {
    expect(serialize([])).toContain('"version": 2')
  })
})

function frameAndWindow() {
  const sent: Record<string, unknown>[] = []
  const contentWindow = {
    postMessage(message: unknown) {
      sent.push(message as Record<string, unknown>)
    },
  } as unknown as Window
  return { frame: { contentWindow }, contentWindow, sent }
}

const quiet = () => ({
  ready: () => {},
  silent: () => {},
  fault: () => {},
  height: () => {},
  filters: () => {},
  clearable: () => {},
  refreshable: () => {},
})

const nothing: Answer = { ok: true, data: null }

describe('talking to an unchanged module', () => {
  test('it is greeted, and told everything after, in its own dialect', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'kehikot.notes', null, async () => nothing, quiet(), {
      dialect: 'roadmap',
    })
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    conversation.sendClear()
    expect(sent.map((m) => m.type)).toEqual(['roadmap.hello', 'roadmap.clear'])
  })

  test('its old-spelled answers are understood, and its old id is not a fault', () => {
    const { frame, contentWindow } = frameAndWindow()
    const faults: string[] = []
    const ready: number[] = []
    const conversation = new Conversation(
      frame,
      'kehikot.notes',
      null,
      async () => nothing,
      { ...quiet(), fault: (line: string) => faults.push(line), ready: (p: number) => ready.push(p) },
      { dialect: 'roadmap' },
    )
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    expect(
      conversation.receive({ source: contentWindow, origin: 'null', data: { type: 'roadmap.ready', id: 'roadmap.notes', protocol: PROTOCOL } }),
    ).toBe(true)
    expect(ready).toEqual([PROTOCOL])
    expect(faults).toEqual([])
  })

  test('a current module is greeted in the current dialect', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'kehikot.notes', null, async () => nothing, quiet())
    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    expect(sent[0]?.type).toBe(MESSAGE.HELLO)
  })
})

describe('who may frame a module this host starts', () => {
  test('KEHIKOT_ORIGINS lists the dev page, the app page, the desktop window and this page', () => {
    const env = originEnv({}, ['http://127.0.0.1:4291'])
    const list = env.KEHIKOT_ORIGINS!.split(' ')
    for (const origin of ['http://127.0.0.1:4181', 'http://127.0.0.1:4170', 'tauri://localhost', 'http://127.0.0.1:4291']) {
      expect(list).toContain(origin)
    }
    /* The single names carry the same list: every module from before the
       rename puts them straight into `frame-ancestors`. */
    expect(env.KEHIKOT_ORIGIN).toBe(env.KEHIKOT_ORIGINS)
    expect(env.ROADMAP_ORIGIN).toBe(env.KEHIKOT_ORIGINS)
  })

  test('the origins the host was started with come first, and nothing is lost', () => {
    const env = originEnv({ ROADMAP_ORIGIN: 'tauri://localhost http://tauri.localhost' }, [])
    expect(env.KEHIKOT_ORIGINS!.startsWith('tauri://localhost http://tauri.localhost ')).toBe(true)
    expect(env.KEHIKOT_ORIGINS!.split(' ')).toContain('http://127.0.0.1:4181')
    expect(env.ROADMAP_ORIGIN).toBe(env.KEHIKOT_ORIGINS)
  })

  test('a list the host was given is kept, first', () => {
    const env = originEnv({ KEHIKOT_ORIGINS: 'http://a http://b' }, [])
    expect(env.KEHIKOT_ORIGINS!.startsWith('http://a http://b ')).toBe(true)
  })
})

