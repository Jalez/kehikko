import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { manifestSchema } from 'kehikot-module-protocol'
import { doorsFetch, establishBuild } from 'kehikot-module-protocol/serve'

import { ANY_PORT_SINCE, answersAs, atLeast, installedProtocol, takesAnyPort } from '../server/anyPort.ts'

/** Phase 4: a module that reads `PORT=0` as any free port is started so, and found where it registers. */

describe('which modules take any port', () => {
  test('versions compare as numbers', () => {
    expect(ANY_PORT_SINCE).toBe('2.65.0')
    expect(atLeast('2.65.0', '2.65.0')).toBe(true)
    expect(atLeast('2.65.1', '2.65.0')).toBe(true)
    expect(atLeast('2.100.0', '2.65.0')).toBe(true)
    expect(atLeast('3.0.0', '2.65.0')).toBe(true)
    expect(atLeast('2.64.9', '2.65.0')).toBe(false)
    expect(atLeast('nonsense', '2.65.0')).toBe(false)
  })

  function checkout(version: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'kehikot-anyport-'))
    if (version !== null) {
      mkdirSync(join(dir, 'node_modules', 'kehikot-module-protocol'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'kehikot-module-protocol', 'package.json'), JSON.stringify({ name: 'kehikot-module-protocol', version }))
    }
    return dir
  }

  test('read from the checkout that will run: 2.65.0 and newer, nothing else', () => {
    expect(installedProtocol(checkout('2.65.0'))).toBe('2.65.0')
    expect(takesAnyPort(checkout('2.65.0'))).toBe(true)
    expect(takesAnyPort(checkout('2.66.2'))).toBe(true)
    /* Older: it reads PORT=0 as no port and keeps its preferred port and the drift rules. 2.63 and
       2.64 were released before the protocol read PORT=0 as any free port. */
    expect(takesAnyPort(checkout('2.64.2'))).toBe(false)
    expect(takesAnyPort(checkout('2.63.0'))).toBe(false)
    expect(takesAnyPort(checkout('2.62.0'))).toBe(false)
    /* No protocol package at all: a module that may bind 0 without saying where. */
    expect(takesAnyPort(checkout(null))).toBe(false)
    expect(takesAnyPort(undefined)).toBe(false)
  })
})

describe('found where it registered, as the process this host started', () => {
  const TOKEN = 'd'.repeat(32)
  let server: ReturnType<typeof Bun.serve>
  let origin = ''
  beforeAll(() => {
    const manifest = manifestSchema.parse({
      kind: 'kehikot.module',
      protocol: 2,
      id: 'kehikot.example',
      name: 'Example',
      version: '1.0.0',
      entry: '/app',
      modes: [{ id: 'main', label: 'Main' }],
      partless: 'An example with nothing in it that belongs to a part.',
    })
    const doors = doorsFetch({ manifest, build: establishBuild({ version: '1', commit: null, start: TOKEN }), page: { title: 'x' }, answer: () => null })
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => (await doors(request)) ?? new Response('', { status: 404 }) })
    origin = `http://127.0.0.1:${server.port}`
  })
  afterAll(() => server.stop(true))

  test('its id and its token: yes', async () => expect(await answersAs(origin, 'kehikot.example', TOKEN)).toBe(true))
  test('another token, the process before or a copy: no', async () => expect(await answersAs(origin, 'kehikot.example', 'e'.repeat(32))).toBe(false))
  test('another id: no', async () => expect(await answersAs(origin, 'kehikot.other', TOKEN)).toBe(false))
  test('nothing there: no', async () => {
    const gone = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const at = `http://127.0.0.1:${gone.port}`
    gone.stop(true)
    expect(await answersAs(at, 'kehikot.example', TOKEN)).toBe(false)
  })
})
