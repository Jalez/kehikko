import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PAGE_ONLY } from '../server/guard.ts'
import { Nursery, start, startable } from '../server/launch.ts'
import { NOT_STARTED_BY_US, restartModuleDesk, RESTART_WITHIN_MS, type Restarted } from '../server/restartModule.ts'
import type { Registration } from '../server/registrations.ts'

/**
 * "Restart module": the door in front of the host's one `restart`.
 *
 * Scratch module processes only: each is a `run.sh` in a temporary directory
 * that records its pid and sleeps, started the way the host starts a module
 * (`start`, detached, in a group of its own) and held by a real `Nursery`.
 * Nothing here touches the machine's modules, a port, or a process this test
 * did not start.
 */

const ID = 'kehikot.scratch'
const made: string[] = []
const nursery = new Nursery()
afterEach(() => {
  nursery.stop(ID)
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

function module(): { root: string; registration: Registration } {
  const root = join(tmpdir(), `kehikko-restart-module-${process.pid}-${made.length}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  made.push(root)
  writeFileSync(join(root, 'run.sh'), `#!/bin/sh\necho $$ >> "${root}/pids"\nexec sleep 300\n`)
  chmodSync(join(root, 'run.sh'), 0o755)
  return { root, registration: { id: ID, url: 'http://127.0.0.1:7990', file: join(root, 'reg.json'), dir: root } }
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

const press = (desk: ReturnType<typeof restartModuleDesk>, module = ID) =>
  desk.route(
    new Request('http://host/host/restart-module', { method: 'POST', body: JSON.stringify({ module }) }),
    new URL('http://host/host/restart-module'),
  ) as Promise<Response>

/** A `restart` built from the pieces the host's is built from: the nursery's stop by handle, then `start`. */
function realRestart(calls: string[]) {
  return async (id: string, _registration: Registration, run: import('../server/launch.ts').Runnable): Promise<Restarted> => {
    calls.push(id)
    const before = pids(run.dir).length
    nursery.stop(id)
    const ran = start(run)
    if (ran.child) nursery.keep(id, { child: ran.child, at: Date.now(), url: run.url })
    await until(() => pids(run.dir).length > before && alive(pids(run.dir).at(-1)!))
    return { ok: true, answered: true, detail: [], presence: null }
  }
}

describe('Restart module', () => {
  test('it is the page’s alone: the route is in PAGE_ONLY', () => {
    expect(PAGE_ONLY).toContain('/host/restart-module')
  })

  test('stops the process the host started, by its handle, and starts the module again', async () => {
    const { root, registration } = module()
    const calls: string[] = []
    /* A bystander in the same directory name space: a process of the same program that is NOT the module's. */
    const bystander = Bun.spawn(['sleep', '300'], { stdio: ['ignore', 'ignore', 'ignore'] })
    try {
      const first = start(startable(registration).ok ? (startable(registration) as { run: import('../server/launch.ts').Runnable }).run : (undefined as never))
      nursery.keep(ID, { child: first.child!, at: Date.now(), url: registration.url })
      await until(() => pids(root).length === 1)
      const [old] = pids(root)
      expect(nursery.pidOf(ID)).toBe(old!)

      const desk = restartModuleDesk({
        registration: async () => registration,
        startable,
        busy: () => false,
        restart: realRestart(calls),
      })
      const answer = await press(desk)
      expect(answer.status).toBe(200)
      expect(((await answer.json()) as { ok: boolean }).ok).toBe(true)

      const seen = pids(root)
      expect(seen).toHaveLength(2)
      const fresh = seen[1]!
      expect(fresh).not.toBe(old!)
      await until(() => !alive(old!))
      expect(alive(old!)).toBe(false)
      expect(alive(fresh)).toBe(true)
      expect(nursery.pidOf(ID)).toBe(fresh)
      expect(calls).toEqual([ID])
      /* Nothing else was signalled. */
      expect(alive(bystander.pid)).toBe(true)
    } finally {
      bystander.kill()
    }
  })

  test('a module this host did not start is refused with the sentence, and nothing is stopped or started', async () => {
    const calls: string[] = []
    const external: Registration = { id: ID, url: 'http://127.0.0.1:7991', file: '/x/reg.json' }
    const desk = restartModuleDesk({
      registration: async () => external,
      startable,
      busy: () => false,
      restart: realRestart(calls),
    })
    const answer = await press(desk)
    expect(answer.status).toBe(409)
    const body = (await answer.json()) as { ok: boolean; why: string; external?: boolean }
    expect(body).toEqual({ ok: false, external: true, why: NOT_STARTED_BY_US })
    expect(NOT_STARTED_BY_US).toBe("Kehikot didn't start this module, so it can't restart it.")
    expect(calls).toEqual([])
  })

  test('an unknown module, a body that names nothing, and a module in hand elsewhere do nothing', async () => {
    const { registration } = module()
    const calls: string[] = []
    const none = restartModuleDesk({ registration: async () => null, startable, busy: () => false, restart: realRestart(calls) })
    expect((await press(none)).status).toBe(409)
    const bad = await none.route(new Request('http://host/host/restart-module', { method: 'POST', body: '{}' }), new URL('http://host/host/restart-module'))
    expect(bad!.status).toBe(400)
    const hand = restartModuleDesk({ registration: async () => registration, startable, busy: () => true, restart: realRestart(calls) })
    const answer = await press(hand)
    expect(answer.status).toBe(409)
    expect(((await answer.json()) as { busy?: boolean }).busy).toBe(true)
    expect(calls).toEqual([])
  })

  test('a second press while one is in hand does nothing: one stop, one start', async () => {
    const { registration } = module()
    let release!: () => void
    const gate = new Promise<void>((wake) => (release = wake))
    let calls = 0
    const desk = restartModuleDesk({
      registration: async () => registration,
      startable,
      busy: () => false,
      restart: async () => {
        calls += 1
        await gate
        return { ok: true, answered: true, detail: [], presence: null }
      },
    })
    const a = press(desk)
    const b = press(desk)
    const c = press(desk)
    const refused = await Promise.all([b, c])
    expect(refused.map((r) => r.status)).toEqual([409, 409])
    expect(((await refused[0]!.json()) as { busy?: boolean }).busy).toBe(true)
    release()
    expect((await a).status).toBe(200)
    expect(calls).toBe(1)
    /* And when it is over, the next press is a new restart. */
    release()
    expect((await press(desk)).status).toBe(200)
    expect(calls).toBe(2)
  })

  test('a module that does not answer in time is said not to have come back, with what it printed', async () => {
    const { registration } = module()
    const desk = restartModuleDesk({
      registration: async () => registration,
      startable,
      busy: () => false,
      restart: async () => ({ ok: true, answered: false, detail: ['Error: EADDRINUSE', 'listen failed'], presence: null }),
    })
    const answer = await press(desk)
    expect(answer.status).toBe(409)
    const body = (await answer.json()) as { ok: boolean; timedOut?: boolean; why: string; detail: string[] }
    expect(body.ok).toBe(false)
    expect(body.timedOut).toBe(true)
    expect(body.why).toContain(`${RESTART_WITHIN_MS / 1000} seconds`)
    expect(body.detail).toEqual(['Error: EADDRINUSE', 'listen failed'])
  })

  test('a refusal from the host’s restart (a module that is kept) is passed on as it was said', async () => {
    const { registration } = module()
    const desk = restartModuleDesk({
      registration: async () => registration,
      startable,
      busy: () => false,
      restart: async () => ({ ok: false, why: 'kept, so not stopped', refused: true, kept: true }),
    })
    const body = (await (await press(desk)).json()) as { ok: boolean; why: string; kept?: boolean }
    expect(body).toMatchObject({ ok: false, why: 'kept, so not stopped', kept: true })
  })
})
