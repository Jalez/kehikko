import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCanvas, editCanvas, open as openDb } from '../server/canvases.ts'
import type { Presence } from '../server/discover.ts'
import { Pins } from '../server/pins.ts'
import { addProject } from '../server/projects.ts'
import { FactsStore, type Instance, type VersionRuns } from '../server/versionRuns.ts'
import { TagLister } from '../server/versions.ts'

/*
 * `/host/modules` answers with what every pinned container is doing (`Pins.views`), and the page
 * reads it on every look — every 1.5 s while anything is in flight. Each running version used to be
 * asked for its manifest on each of those; Monitor's record showed every one fetched about every
 * twenty seconds under "the page reads the modules". A version's manifest is now kept, as a
 * registered module's is, until it stops running or a person presses.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-pins-views-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function world() {
  const db = openDb(':memory:')
  const added = addProject(db, root, undefined, false)
  if (!added.ok) throw new Error(added.why)
  const canvas = createCanvas(db, 'one', added.project.id)
  editCanvas(db, canvas.id, {
    placements: [
      { i: 'kehikot.notes', x: 0, y: 0, w: 4, h: 10, version: 'v1.0.0' },
      { i: 'kehikot.slides', x: 4, y: 0, w: 4, h: 10, version: 'v2.0.0' },
    ],
  })
  const state: { running: boolean } = { running: true }
  const instance = (id: string, tag: string, port: number): Instance => ({
    key: `${id}@${tag}`,
    id,
    tag,
    state: state.running ? 'running' : 'starting',
    step: null,
    port,
    origin: `http://127.0.0.1:${port}`,
    why: null,
    neededAt: 0,
  })
  const runs = {
    get: (id: string, tag: string) => instance(id, tag, id === 'kehikot.notes' ? 7801 : 7802),
  } as unknown as VersionRuns
  const asked: string[] = []
  let now = 1_000
  const pins = new Pins(
    {
      db,
      runs,
      facts: new FactsStore(join(root, 'facts')),
      tags: new TagLister(async () => ({ ok: true, out: '' })),
      materialiser: {} as never,
      runner: async () => ({ ok: false, why: 'no' }),
      registration: async () => null,
      latest: () => null,
      look: async (id, origin) => {
        asked.push(`${id} ${origin}`)
        return { id, at: origin, condition: 'ready', line: '', reached: true, name: id, module: { version: '1.0.0', dataVersion: 1 } } as Presence
      },
      wake: () => {},
      keep: () => {},
    },
    { now: () => now },
  )
  return { pins, asked, state, open: new Set([canvas.id]), later: (ms: number) => (now += ms) }
}

describe("the pinned versions' manifests", () => {
  test('are asked once, however many looks read the pins', async () => {
    const { pins, asked, open } = world()
    for (let i = 0; i < 20; i++) {
      const views = await pins.views(open)
      expect(views.map((one) => one.state)).toEqual(['ready', 'ready'])
    }
    expect(asked).toEqual(['kehikot.notes http://127.0.0.1:7801', 'kehikot.slides http://127.0.0.1:7802'])
  })

  test('a press asks every running version again', async () => {
    const { pins, asked, open } = world()
    await pins.views(open)
    await pins.views(open, true)
    expect(asked.length).toBe(4)
  })

  test('again after the freshness, like a registered module', async () => {
    const { pins, asked, open, later } = world()
    await pins.views(open)
    later(60_001)
    await pins.views(open)
    expect(asked.length).toBe(4)
  })

  test('a version that stopped running is asked again when it runs', async () => {
    const { pins, asked, open, state } = world()
    await pins.views(open)
    state.running = false
    expect((await pins.views(open)).map((one) => one.state)).toEqual(['starting', 'starting'])
    state.running = true
    await pins.views(open)
    expect(asked.length).toBe(4)
  })
})
