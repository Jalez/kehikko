import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PAGE_ONLY } from '../server/guard.ts'
import { Nursery, start, startable, type Runnable } from '../server/launch.ts'
import { toStart, toWarm, type Standing } from '../server/lifecycle.ts'
import { StoppedByPerson, STARTED_OUTSIDE, stopModuleDesk } from '../server/stopModule.ts'
import type { Registration } from '../server/registrations.ts'

/*
 * "Stop" on a module's row: the held child, by its handle, and nothing else; refused for a module
 * started outside Kehikot; and what it stopped stays stopped until a person presses Start.
 * Scratch processes only, as restart-module.test.ts does.
 */

const ID = 'kehikot.scratch'
const made: string[] = []
const nursery = new Nursery()
const bystanders: Array<ReturnType<typeof Bun.spawn>> = []
afterEach(() => {
  nursery.stop(ID)
  for (const one of bystanders.splice(0)) one.kill()
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

function module(over: Partial<Registration> = {}): { root: string; registration: Registration } {
  const root = join(tmpdir(), `kehikko-stop-module-${process.pid}-${made.length}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  made.push(root)
  writeFileSync(join(root, 'run.sh'), `#!/bin/sh\necho $$ >> "${root}/pids"\nexec sleep 300\n`)
  chmodSync(join(root, 'run.sh'), 0o755)
  return { root, registration: { id: ID, url: 'http://127.0.0.1:7991', file: join(root, 'reg.json'), dir: root, ...over } }
}
const pids = (root: string) => (existsSync(join(root, 'pids')) ? readFileSync(join(root, 'pids'), 'utf8').trim().split('\n').map(Number) : [])
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((wake) => setTimeout(wake, 20))
}
const press = (desk: ReturnType<typeof stopModuleDesk>, module = ID) =>
  desk.route(
    new Request('http://host/host/stop-module', { method: 'POST', body: JSON.stringify({ module }) }),
    new URL('http://host/host/stop-module'),
  ) as Promise<Response>

function desk(registration: Registration | null, over: { reached?: boolean; busy?: boolean } = {}) {
  const stopped = new StoppedByPerson()
  const calls: string[] = []
  const door = stopModuleDesk({
    registration: async () => registration,
    busy: () => over.busy === true,
    held: (id) => nursery.holds(id),
    reached: async () => over.reached === true,
    stop: async (id) => {
      stopped.stop(id)
      calls.push(`stop ${nursery.stop(id)}`)
    },
  })
  return { door, stopped, calls }
}

describe('Stop', () => {
  test('it is the page’s alone: the route is in PAGE_ONLY', () => {
    expect(PAGE_ONLY).toContain('/host/stop-module')
  })

  test('stops the child the host holds, by its handle, and leaves every other process alone', async () => {
    const { root, registration } = module()
    const ran = start((startable(registration) as { run: Runnable }).run)
    nursery.keep(ID, { child: ran.child!, at: Date.now(), url: registration.url })
    const bystander = Bun.spawn(['sleep', '300'])
    bystanders.push(bystander)
    await until(() => pids(root).length > 0)
    const pid = pids(root)[0]!
    const { door, stopped, calls } = desk(registration, { reached: true })
    const answer = await press(door)
    expect(answer.status).toBe(200)
    expect(((await answer.json()) as { ok: boolean }).ok).toBe(true)
    expect(calls).toEqual(['stop stopped'])
    expect(stopped.has(ID)).toBe(true)
    await until(() => !alive(pid))
    expect(alive(pid)).toBe(false)
    expect(alive(bystander.pid)).toBe(true)
  })

  test('refuses a module started outside Kehikot, with the reason, and signals nothing', async () => {
    const { registration } = module()
    const { door, stopped, calls } = desk(registration, { reached: true })
    const answer = await press(door)
    expect(answer.status).toBe(409)
    expect(((await answer.json()) as { why: string }).why).toBe(STARTED_OUTSIDE)
    expect(STARTED_OUTSIDE).toBe('Started outside Kehikot: stop it where it runs')
    expect(calls).toEqual([])
    expect(stopped.has(ID)).toBe(false)
  })

  test('refuses one with no directory, one that is busy, and one that is kept', async () => {
    const outside = desk(module({ dir: undefined }).registration)
    expect(((await (await press(outside.door)).json()) as { why: string }).why).toBe(STARTED_OUTSIDE)
    const busy = desk(module().registration, { busy: true })
    expect((await press(busy.door)).status).toBe(409)
    const kept = desk(module({ keep: true }).registration)
    expect(((await (await press(kept.door)).json()) as { kept?: boolean }).kept).toBe(true)
    expect([...outside.calls, ...busy.calls, ...kept.calls]).toEqual([])
  })

  test('one that is not running is remembered as stopped, and nothing is signalled', async () => {
    const { door, stopped } = desk(module().registration, { reached: false })
    expect((await press(door)).status).toBe(200)
    expect(stopped.has(ID)).toBe(true)
  })

  test('a malformed press is refused', async () => {
    const { door } = desk(module().registration)
    const bad = await door.route(new Request('http://host/host/stop-module', { method: 'POST', body: '{}' }), new URL('http://host/host/stop-module'))
    expect(bad!.status).toBe(400)
  })
})

describe('what a person stopped stays stopped', () => {
  const standing = (id: string, stopped: StoppedByPerson, over: Partial<Standing> = {}): Standing => ({
    id,
    needed: true,
    warm: null,
    answering: false,
    startable: true,
    ours: false,
    keep: false,
    idleSince: null,
    starting: false,
    /* As `standings` in server.ts builds it. */
    failed: stopped.has(id),
    ...over,
  })

  test('the host’s own rules do not start it, needed or warm, until Start is pressed', () => {
    const stopped = new StoppedByPerson()
    expect(toStart([standing('a', stopped)])).toEqual(['a'])
    stopped.stop('a')
    expect(toStart([standing('a', stopped)])).toEqual([])
    expect(toWarm([standing('a', stopped, { needed: false, warm: 0 })])).toEqual([])
    stopped.pressed('a')
    expect(toStart([standing('a', stopped)])).toEqual(['a'])
    expect(toWarm([standing('a', stopped, { needed: false, warm: 0 })])).toEqual(['a'])
  })

  test('it is forgotten for a module that is no longer registered, and held only in memory', () => {
    const stopped = new StoppedByPerson()
    stopped.stop('a')
    stopped.stop('b')
    stopped.forgetAllBut(new Set(['a']))
    expect([stopped.has('a'), stopped.has('b')]).toEqual([true, false])
    /* A new host starts with nothing stopped. */
    expect(new StoppedByPerson().has('a')).toBe(false)
  })

  test('the host wires it: its own start refuses a stopped module, and a press on Start or Restart clears it', () => {
    const source = readFileSync(join(import.meta.dir, '../server/server.ts'), 'utf8')
    expect(source).toContain('failed: failures.has(presence.id) || stoppedByPerson.has(presence.id)')
    expect(source).toMatch(/function begin\(id: string(?:, why = [^)]*)?\): void \{[\s\S]*?if \(stoppedByPerson\.has\(id\)\) return/)
    expect(source).toContain('stoppedByPerson.pressed(named)')
    expect(source).toContain('stoppedByPerson.pressed(id)')
  })
})
