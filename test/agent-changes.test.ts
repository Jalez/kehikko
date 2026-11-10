import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CHANGED_SINCE_HEAD, placeDoorsSchema, sessionNotes, type NotesTold } from 'kehikot-module-protocol'

import { changesOfCopy, hostChanges } from '../server/agentChanges.ts'
import { createCanvas, editCanvas, open, type Canvas } from '../server/canvases.ts'
import { createEpic } from '../server/holdings.ts'
import { modulesOn, placeDesk, type ModuleAbout } from '../server/placeRoutes.ts'
import { addProject, type Project } from '../server/projects.ts'

/**
 * What changed for agent sessions (protocol 2.61.0): each module's version and its releases' "For
 * agents" lines, read from the copy it runs, and Kehikot's own from FOR_AGENTS.md, handed beside the
 * modules on a session's kehikko so its next prompt after an update is told them, once.
 */

const ROOT = join(import.meta.dir, '..')

let copy: string
beforeEach(() => {
  copy = realpathSync(mkdtempSync(join(tmpdir(), 'agent-changes-')))
})
afterEach(() => rmSync(copy, { recursive: true, force: true }))

const release = (version: string, notes: Record<string, string>) => {
  writeFileSync(join(copy, 'package.json'), JSON.stringify({ name: 'm', version }))
  mkdirSync(join(copy, 'notes'), { recursive: true })
  for (const [file, text] of Object.entries(notes)) writeFileSync(join(copy, 'notes', file), text)
}

describe('a copy', () => {
  test('its version, and its releases up to it that say something to agents, newest first', () => {
    release('1.3.0', {
      '1.1.0.md': '- People.\n\n## For agents\n- one-one',
      '1.2.0.md': '- People only.',
      '1.3.0.md': '- People.\n\nFor agents: `queue_wait` waits.',
      'README.md': '## For agents\n- not a release',
    })
    expect(changesOfCopy(copy)).toEqual({ version: '1.3.0', changes: [{ version: '1.3.0', lines: ['`queue_wait` waits.'] }, { version: '1.1.0', lines: ['one-one'] }] })
  })

  test('read again when it is updated, not before', () => {
    release('1.0.0', { '1.0.0.md': '## For agents\n- first' })
    const first = changesOfCopy(copy)
    expect(changesOfCopy(copy)).toBe(first)
    release('1.1.0', { '1.1.0.md': '## For agents\n- second' })
    const later = new Date(Date.now() + 5000)
    utimesSync(join(copy, 'package.json'), later, later)
    expect(changesOfCopy(copy).version).toBe('1.1.0')
    expect(changesOfCopy(copy).changes.map((one) => one.version)).toEqual(['1.1.0', '1.0.0'])
  })

  test('a folder without a version, or none at all, says nothing', () => {
    expect(changesOfCopy(copy)).toEqual({ version: null, changes: [] })
    expect(changesOfCopy(null)).toEqual({ version: null, changes: [] })
    writeFileSync(join(copy, 'package.json'), '{"version":"next"}')
    expect(changesOfCopy(copy).version).toBeNull()
    writeFileSync(join(copy, 'package.json'), '{"version":"2.0.0"}')
    utimesSync(join(copy, 'package.json'), new Date(Date.now() + 9000), new Date(Date.now() + 9000))
    expect(changesOfCopy(copy)).toEqual({ version: '2.0.0', changes: [] })
  })
})

describe('Kehikot’s own', () => {
  test('numbered sections, newest number as the version', () => {
    expect(hostChanges('# For agents\n\nIntro.\n\n## 3\n- three\n\n## 2\n\n## 1\n- one\n- one more')).toEqual({
      version: '3.0.0',
      changes: [
        { version: '3.0.0', lines: ['three'] },
        { version: '1.0.0', lines: ['one', 'one more'] },
      ],
    })
    expect(hostChanges('# For agents\n\nNothing yet.')).toBeNull()
  })

  test('FOR_AGENTS.md parses, and every number in it is said to agents', () => {
    const text = readFileSync(join(ROOT, 'FOR_AGENTS.md'), 'utf8')
    const read = hostChanges(text)
    expect(read).not.toBeNull()
    const numbers = [...text.matchAll(/^## (\d+)\s*$/gm)].map((match) => `${match[1]}.0.0`)
    expect(read!.changes.map((one) => one.version)).toEqual(numbers)
    expect(hostChanges()).toEqual(read)
  })
})

describe('a session’s place answer', () => {
  const canvas = { placements: [{ i: 'kehikot.queue', x: 0, y: 0, w: 6, h: 10 }] } as unknown as Canvas
  const about: ModuleAbout[] = [
    { id: 'kehikot.queue', name: 'Test runs', summary: 'Runs tests.', skills: [], version: '1.3.0', changes: [{ version: '1.3.0', lines: ['queue_wait waits.'] }] },
    { id: 'kehikot.other', name: 'Other', summary: 'Elsewhere.', skills: [], version: '2.0.0', changes: [{ version: '2.0.0', lines: ['not here'] }] },
  ]

  test('each module on the kehikko carries its version and changes; one not placed is not listed', () => {
    const on = modulesOn(canvas, about, [])
    expect(on).toHaveLength(1)
    expect(on[0]!.version).toBe('1.3.0')
    expect(on[0]!.changes).toEqual([{ version: '1.3.0', lines: ['queue_wait waits.'] }])
    expect(modulesOn(canvas, [{ id: 'kehikot.queue', name: 'Test runs', skills: [] }], [])[0]).not.toHaveProperty('version')
  })

  describe('through the route', () => {
    let db: Database
    let folder: string
    let project: Project
    let writing: Canvas
    beforeEach(() => {
      db = open(':memory:')
      folder = realpathSync(mkdtempSync(join(tmpdir(), 'agent-changes-place-')))
      const added = addProject(db, folder, 'thesis')
      if (!added.ok) throw new Error(added.why)
      project = added.project
      createEpic(folder, { title: 'Methods', slug: 'methods' })
      writing = createCanvas(db, 'writing', project.id)
      editCanvas(db, writing.id, { placements: [{ i: 'kehikot.queue', x: 0, y: 0, w: 6, h: 10 }] })
    })
    afterEach(() => {
      db.close()
      rmSync(folder, { recursive: true, force: true })
    })

    test('with Kehikot’s own, and a session started before an update is told once at its next prompt', async () => {
      let modules = about
      let host = { version: '1.0.0', changes: [] as { version: string; lines: string[] }[] }
      const desk = placeDesk({
        db,
        hostUrl: () => 'http://127.0.0.1:4180/mcp',
        doors: async () => [],
        modules: async () => modules,
        host: () => host,
        known: () => new Map(),
        open: () => null,
        changed: () => {},
        originOf: async () => null,
        fetch: (async () => new Response('{}')) as unknown as typeof fetch,
      })
      const ask = async () => {
        const reply = await desk.route(
          new Request('http://127.0.0.1:4180/host/place', { method: 'POST', body: JSON.stringify({ module: 'kehikot.claude', token: 'a'.repeat(32), project: folder, kehikko: writing.key }) }),
          new URL('http://127.0.0.1:4180/host/place'),
        )
        return placeDoorsSchema.parse(await reply!.json())
      }
      const notes = (answer: Awaited<ReturnType<typeof ask>>, event: 'start' | 'prompt', told: NotesTold | null) =>
        sessionNotes(
          {
            place: { project: folder, epic: 'methods', parts: [], kehikko: { key: writing.key } },
            modules: answer.modules ?? null,
            absent: answer.absent ?? null,
            host: answer.host ?? null,
            self: { module: 'kehikot.claude', name: 'Agent', door: 'agent' },
          },
          event,
          told,
        )

      const first = await ask()
      expect(first.host).toEqual({ version: '1.0.0', changes: [] })
      const start = notes(first, 'start', null)
      expect(start.told.versions).toEqual({ 'kehikot.queue': '1.3.0' })

      modules = [{ ...about[0]!, version: '1.4.0', changes: [{ version: '1.4.0', lines: ['queue_run checks first.'] }, ...about[0]!.changes!] }]
      host = { version: '2.0.0', changes: [{ version: '2.0.0', lines: ['A new rule.'] }] }
      const after = notes(await ask(), 'prompt', start.told)
      expect(after.text).toContain(CHANGED_SINCE_HEAD)
      expect(after.text).toContain('- Kehikot: "A new rule."')
      expect(after.text).toContain('- Test runs 1.4.0: "queue_run checks first."')
      expect(after.text).not.toContain('queue_wait waits.')
      expect(notes(await ask(), 'prompt', after.told).text).toBeNull()
    })
  })
})
