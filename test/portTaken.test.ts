import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { answersAs, judge, movedLine, newPort, repoint } from '../server/portTaken.ts'
import { proveListener, systemProcesses, type Proof } from '../server/takeover.ts'
import type { Runnable } from '../server/launch.ts'

/**
 * "start it" on a module whose port another program holds: which listener is
 * moved away from, which is stopped and started again, and which is refused.
 * Nothing here signals a process; the one real server is this test's own.
 */

const made: string[] = []
function dir(name: string): string {
  const path = join(tmpdir(), `kehikko-port-taken-${process.pid}-${made.length}-${name}`)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  made.push(path)
  return path
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

const unproven = (because: Extract<Proof, { kind: 'unproven' }>['because']): Proof => ({ kind: 'unproven', detail: 'x', because })

describe('judge', () => {
  test('a program serving no manifest, from somewhere else, is moved away from', () => {
    expect(judge('kehikot.paper', unproven('elsewhere'), null)).toEqual({ kind: 'foreign' })
  })

  test('another module on the port is moved away from', () => {
    expect(judge('kehikot.paper', unproven('elsewhere'), 'kehikot.notes')).toEqual({ kind: 'foreign' })
  })

  test('a listener the host could not look up, serving no manifest of this module, is moved away from', () => {
    expect(judge('kehikot.paper', unproven('unasked'), null)).toEqual({ kind: 'foreign' })
  })

  test('the module, running from its own directory without a pid here, is the host’s own copy', () => {
    const proven: Proof = { kind: 'proven', pid: 1234, pgid: 1200 }
    /* Healthy or broken (an orphan serving a page instead of its manifest), it is stopped and started again. */
    expect(judge('kehikot.paper', proven, 'kehikot.paper')).toEqual({ kind: 'ours' })
    expect(judge('kehikot.paper', proven, null)).toEqual({ kind: 'ours' })
  })

  test('the module answering from another folder — somebody’s own dev server — is refused as before', () => {
    expect(judge('kehikot.paper', unproven('elsewhere'), 'kehikot.paper')).toEqual({ kind: 'held' })
    expect(judge('kehikot.paper', unproven('elsewhere'), 'roadmap.paper')).toEqual({ kind: 'held' })
  })

  test('a listener in the module’s directory but a group the host will not signal is refused', () => {
    expect(judge('kehikot.paper', unproven('group'), null)).toEqual({ kind: 'held' })
    expect(judge('kehikot.paper', unproven('no-port'), null)).toEqual({ kind: 'held' })
  })

  test('nothing listening starts normally', () => {
    expect(judge('kehikot.paper', { kind: 'nothing' }, null)).toEqual({ kind: 'free' })
  })
})

describe('newPort', () => {
  const probes = (busy: number[], strangers = busy) => ({
    free: async (port: number) => !busy.includes(port),
    identify: async (port: number) =>
      strangers.includes(port) ? ({ at: 'stranger', why: 'something is serving a non-JSON document' } as const) : ({ at: 'free' } as const),
  })

  test('the module’s first port, when it is free', async () => {
    const registry = dir('registry')
    expect(await newPort({ id: 'kehikot.paper', taken: 8020, first: 8010, registry, probes: probes([8020]) })).toEqual({
      ok: true,
      port: 8010,
      url: 'http://127.0.0.1:8010',
    })
  })

  test('the next free one after the taken port, skipping ports other registrations name', async () => {
    const registry = dir('registry')
    writeFileSync(join(registry, 'kehikot.notes.json'), JSON.stringify({ url: 'http://127.0.0.1:8021' }))
    expect(await newPort({ id: 'kehikot.paper', taken: 8020, first: null, registry, probes: probes([8020]) })).toEqual({
      ok: true,
      port: 8022,
      url: 'http://127.0.0.1:8022',
    })
  })

  test('no free port at all is said, not guessed', async () => {
    const registry = dir('registry')
    const all = Array.from({ length: 100 }, (_, i) => 8000 + i)
    const got = await newPort({ id: 'kehikot.paper', taken: 8020, first: null, registry, probes: probes(all) })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.why).toContain('Port 8020 is taken by another program')
  })
})

describe('repoint', () => {
  test('rewrites url and keeps every other key', () => {
    const registry = dir('registry')
    const file = join(registry, 'kehikot.paper.json')
    writeFileSync(file, JSON.stringify({ url: 'http://127.0.0.1:8020', dir: '/somewhere', keep: true, port: 8020 }))
    expect(repoint(file, 'http://127.0.0.1:8021')).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ url: 'http://127.0.0.1:8021', dir: '/somewhere', keep: true })
  })

  test('a YAML registration is left for its author', () => {
    const registry = dir('registry')
    const file = join(registry, 'kehikot.paper.yaml')
    writeFileSync(file, 'url: http://127.0.0.1:8020\n')
    expect(repoint(file, 'http://127.0.0.1:8021').ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('url: http://127.0.0.1:8020\n')
  })
})

test('the sentence names ports and the module, and nothing to do', () => {
  expect(movedLine('Paper', 8020, 8021)).toBe('Port 8020 was taken by another program; Paper now runs on 8021.')
})

describe('a real program holding the port', () => {
  let server: ReturnType<typeof Bun.serve> | null = null
  afterEach(() => {
    server?.stop(true)
    server = null
  })

  test('a page server on the module’s port is judged foreign, and the module is given another port', async () => {
    /* The stranger: answers every path, the well-known one included, with a page. */
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><p>hello</p>', { headers: { 'content-type': 'text/html' } }) })
    const port = server.port as number
    const url = `http://127.0.0.1:${port}`
    const moduleDir = dir('installed-module')
    const run: Runnable = { dir: moduleDir, script: join(moduleDir, 'run.sh'), port, url, command: '' }

    const said = await answersAs(url)
    expect(said).toBeNull()
    const proof = await proveListener(run, systemProcesses)
    /* This test's process runs from the repository, not from the module's directory. */
    expect(proof.kind).toBe('unproven')
    expect(judge('kehikot.paper', proof, said)).toEqual({ kind: 'foreign' })

    const registry = dir('registry')
    const to = await newPort({ id: 'kehikot.paper', taken: port, first: null, registry })
    expect(to.ok).toBe(true)
    if (to.ok) expect(to.port).toBeGreaterThan(port)
  })

  test('the same program answering as the module from another folder is refused, not moved', async () => {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ kind: 'kehikot.module', id: 'kehikot.paper' }),
    })
    const port = server.port as number
    const url = `http://127.0.0.1:${port}`
    const moduleDir = dir('installed-module')
    const run: Runnable = { dir: moduleDir, script: join(moduleDir, 'run.sh'), port, url, command: '' }
    expect(judge('kehikot.paper', await proveListener(run, systemProcesses), await answersAs(url))).toEqual({ kind: 'held' })
  })

  test('a listener in the host’s own process group is never the host’s to stop', async () => {
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('nope') })
    const port = server.port as number
    const url = `http://127.0.0.1:${port}`
    /* The module's directory is where this process runs, so only the group stands in the way. */
    const run: Runnable = { dir: process.cwd(), script: join(process.cwd(), 'run.sh'), port, url, command: '' }
    const proof = await proveListener(run, systemProcesses)
    expect(proof.kind).toBe('unproven')
    if (proof.kind === 'unproven') expect(proof.because).toBe('group')
    expect(judge('kehikot.paper', proof, await answersAs(url))).toEqual({ kind: 'held' })
  })
})
