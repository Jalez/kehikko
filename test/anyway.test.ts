import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { aim, anywayDesk, armedSentence, Arms, ARMED_FOR_MS, keptSentence, stopAnyway, type AnywayWorld, type Came } from '../server/anyway.ts'
import { own, refusal } from '../server/guard.ts'
import { Nursery, TERM_GRACE_MS, type Runnable, type Startable } from '../server/launch.ts'
import { mcp } from '../server/mcp.ts'
import type { Registration } from '../server/registrations.ts'
import type { Processes } from '../server/takeover.ts'

/**
 * "Restart anyway": a module whose registration says to keep it, restarted
 * because a person pressed twice. No process is created or signalled — the
 * operating system and the signals are fakes, and every signal sent is
 * recorded so that "nothing else was signalled" is an assertion.
 */

const ID = 'kehikot.terminal'
const PAGE = 'http://127.0.0.1:4181'

const made: string[] = []
function dir(name = 'mod'): string {
  const path = join(tmpdir(), `kehikko-anyway-${process.pid}-${made.length}-${name}`)
  rmSync(path, { recursive: true, force: true })
  mkdirSync(path, { recursive: true })
  made.push(path)
  return path
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

const runnable = (root: string, port: number | null = 7920): Runnable => ({
  dir: root,
  script: join(root, 'run.sh'),
  port,
  url: `http://127.0.0.1:${port ?? ''}`,
  command: 'run.sh',
})

interface Machine {
  /** What listens on the port, read each time it is asked. */
  listener: number | null
  /** What the listener becomes after the manifest has been asked for. */
  listenerAfterManifest?: number | null
  cwds: Record<number, string>
  groups: Record<number, number>
  /** What the program on the port says it is. */
  says: string | null
  /** Which signal frees the port; null means only SIGKILL does. */
  freesOn: NodeJS.Signals | null
  /** Every signal sent to a group through the operating system. */
  signals: Array<[number, NodeJS.Signals]>
}

/** An operating system holding one inherited listener, and a world built on it with no process of this host's own. */
function machine(over: Partial<Machine> = {}): { world: AnywayWorld; os: Processes; m: Machine; ours: Array<[number, NodeJS.Signals | 0]> } {
  const m: Machine = { listener: null, cwds: {}, groups: {}, says: ID, freesOn: 'SIGTERM', signals: [], ...over }
  const os: Processes = {
    async listenerOf() {
      return m.listener
    },
    async cwdOf(pid) {
      return m.cwds[pid] ?? null
    },
    async groupOf(pid) {
      return m.groups[pid] ?? null
    },
    signalGroup(pgid, signal) {
      m.signals.push([pgid, signal])
      if (signal === m.freesOn || signal === 'SIGKILL') m.listener = null
    },
    async portFree() {
      return m.listener === null
    },
    async ownGroup() {
      return 500
    },
    async sleep() {},
  }
  const ours: Array<[number, NodeJS.Signals | 0]> = []
  const world: AnywayWorld = {
    ours: () => null,
    stopOurs: () => 'not-ours',
    os,
    async answersAs() {
      const said = m.says
      if (m.listenerAfterManifest !== undefined) m.listener = m.listenerAfterManifest
      return said
    },
  }
  return { world, os, m, ours }
}

/** A module this host started: a nursery over a fake child, with its signals and its timer recorded. */
function nursed(pid: number, stubborn: boolean) {
  const signals: Array<[number, NodeJS.Signals | 0]> = []
  const timers: Array<{ ms: number; run: () => void }> = []
  let alive = true
  const nursery = new Nursery(
    (to, signal) => {
      signals.push([to, signal])
      if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !stubborn)) alive = false
    },
    (ms, run) => {
      timers.push({ ms, run })
    },
  )
  nursery.keep(ID, { child: { pid, alive: () => alive }, at: 1, url: 'http://127.0.0.1:7920' })
  return { nursery, signals, timers, alive: () => alive }
}

describe('the sentences', () => {
  test('before any press, it does not send anybody to where they started it', () => {
    const said = keptSentence(ID, 'http://127.0.0.1:7920')
    expect(said).toBe(
      'kehikot.terminal is running at http://127.0.0.1:7920, and its registration says to keep it, so this host has not stopped it — '
      + 'that flag exists so nothing reaps a program holding live work.',
    )
    expect(said).not.toContain('where you started it')
  })

  test('armed, it says what ends and which process, and never that nothing is running', () => {
    const run = runnable('/mods/terminal')
    const ours = armedSentence(ID, run, { whose: 'ours', pid: 4321 })
    expect(ours).toBe(
      'Restarting kehikot.terminal ends whatever it is running. It is holding work this host cannot see — '
      + 'in a terminal, the open shells and everything running in them. '
      + 'This host started it (process 4321) and will stop that and start it again. Press again to do it.',
    )
    const inherited = armedSentence(ID, run, { whose: 'inherited', pid: 1234, pgid: 1200 })
    expect(inherited).toContain('This host did not start it: the program on port 7920 (process 1234) answers as kehikot.terminal from /mods/terminal')
    for (const one of [ours, inherited]) {
      expect(one).toContain('ends whatever it is running')
      expect(one).not.toMatch(/nothing is running|no shells?/i)
    }
  })
})

describe('which process would be stopped', () => {
  test('one this host started is its own child, and the operating system is not asked', async () => {
    const { world, m } = machine({ listener: 999, says: 'somebody.else' })
    const aimed = await aim(ID, runnable(dir()), { ...world, ours: () => 4321 })
    expect(aimed).toEqual({ ok: true, target: { whose: 'ours', pid: 4321 } })
    expect(m.signals).toEqual([])
  })

  test('an inherited one is proven: it answers the manifest as the registered id, from the registered directory', async () => {
    const root = dir()
    const { world, m } = machine({ listener: 1234, cwds: { 1234: root, 1200: root }, groups: { 1234: 1200 } })
    expect(await aim(ID, runnable(root), world)).toEqual({ ok: true, target: { whose: 'inherited', pid: 1234, pgid: 1200 } })
    /* Looking is not signalling. */
    expect(m.signals).toEqual([])
  })

  test('a pre-rename id in the manifest is the same module', async () => {
    const root = dir()
    const { world } = machine({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 1234 }, says: 'roadmap.terminal' })
    expect((await aim(ID, runnable(root), world)).ok).toBe(true)
  })

  const refusals: Array<[string, (root: string) => Partial<Machine>, RegExp]> = [
    ['nothing listens on the port', () => ({ listener: null }), /nothing is listening on port 7920 any more/],
    ['the listener answers as another module', (root) => ({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 1234 }, says: 'kehikot.notes' }), /answers as kehikot\.notes, not as kehikot\.terminal/],
    ['the listener serves no manifest', (root) => ({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 1234 }, says: null }), /did not answer .* with a manifest/],
    ['the listener runs from somewhere else', () => ({ listener: 1234, cwds: { 1234: '/somewhere/else' }, groups: { 1234: 1234 } }), /is not running from/],
    ['its working directory cannot be read', () => ({ listener: 1234, cwds: {}, groups: { 1234: 1234 } }), /is not running from/],
    ['it is in this host’s own process group', (root) => ({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 500 } }), /shares a process group this host will not signal/],
    ['its group leader runs from elsewhere', (root) => ({ listener: 1234, cwds: { 1234: root, 1200: '/Users/somebody' }, groups: { 1234: 1200 } }), /shares a process group with something not running from/],
    ['another program took the port while it was asked', (root) => ({ listener: 1234, listenerAfterManifest: 5678, cwds: { 1234: root, 5678: root }, groups: { 1234: 1234, 5678: 5678 } }), /changed while this host was asking what it is/],
  ]
  for (const [name, world, why] of refusals) {
    test(`refused, with nothing signalled, when ${name}`, async () => {
      const root = dir()
      const { world: w, m } = machine(world(root))
      const aimed = await aim(ID, runnable(root), w)
      expect(aimed.ok).toBe(false)
      if (aimed.ok) return
      expect(aimed.why).toMatch(why)
      expect(aimed.why).toContain('nothing was stopped')
      /* And the stop refuses the same way: there is no second path to a signal. */
      expect((await stopAnyway(ID, runnable(root), 1234, w)).ok).toBe(false)
      expect(m.signals).toEqual([])
    })
  }

  test('a registration with no port names nothing to find', async () => {
    const { world, m } = machine({ listener: 1234 })
    const aimed = await aim(ID, runnable(dir(), null), world)
    expect(aimed.ok).toBe(false)
    expect(m.signals).toEqual([])
  })

  test('an operating system that cannot be asked is a refusal', async () => {
    const root = dir()
    const { world, m } = machine({ listener: 1234 })
    world.os.listenerOf = async () => {
      throw new Error('no lsof')
    }
    const aimed = await aim(ID, runnable(root), world)
    expect(aimed.ok ? '' : aimed.why).toContain('could not ask which program is listening on port 7920')
    expect(m.signals).toEqual([])
  })
})

describe('the first press, as the server holds it', () => {
  test('a token is good once, for its module, while it stands', () => {
    let now = 1000
    let n = 0
    const arms = new Arms(() => now, () => `t${++n}`)
    const token = arms.arm(ID, 77)
    expect(arms.take('kehikot.notes', token)).toBeNull()
    expect(arms.take(ID, token)).toBe(77)
    /* Spent. */
    expect(arms.take(ID, token)).toBeNull()

    const wrong = arms.arm(ID, 78)
    expect(arms.take(ID, 'not-it')).toBeNull()
    /* A wrong guess spends the arm too. */
    expect(arms.take(ID, wrong)).toBeNull()

    const late = arms.arm(ID, 79)
    now += ARMED_FOR_MS + 1
    expect(arms.take(ID, late)).toBeNull()

    const first = arms.arm(ID, 80)
    const second = arms.arm(ID, 81)
    expect(arms.take(ID, first)).toBeNull()
    arms.arm(ID, 81)
    expect(second).not.toBe(first)
  })
})

describe('stopping, then starting', () => {
  test('a process this host started that ignores SIGTERM is killed, and nothing else is signalled', async () => {
    const root = dir()
    const mine = nursed(4321, true)
    /* Something else is listening on the machine too; it is never looked at. */
    const { world, m } = machine({ listener: 999, cwds: { 999: '/elsewhere' }, groups: { 999: 999 } })
    const w: AnywayWorld = { ...world, ours: (id) => mine.nursery.pidOf(id), stopOurs: (id) => mine.nursery.stop(id) }
    const events: string[] = []

    const stopped = await stopAnyway(ID, runnable(root), 4321, w)
    events.push(`stopped:${stopped.ok}`)
    expect(stopped).toEqual({ ok: true, target: { whose: 'ours', pid: 4321 }, killed: false })
    /* SIGTERM to its own group, and the nursery no longer holds it. */
    expect(mine.signals).toEqual([[-4321, 'SIGTERM']])
    expect(mine.nursery.holds(ID)).toBe(false)
    expect(mine.alive()).toBe(true)
    /* The bounded wait, then SIGKILL for what is left — the same group. */
    expect(mine.timers.map((timer) => timer.ms)).toEqual([TERM_GRACE_MS])
    mine.timers[0]!.run()
    expect(mine.signals).toEqual([[-4321, 'SIGTERM'], [-4321, 'SIGKILL']])
    expect(mine.alive()).toBe(false)
    events.push('start')
    expect(events).toEqual(['stopped:true', 'start'])
    /* Nothing went to the other listener, or to anything through the operating system. */
    expect(m.signals).toEqual([])
  })

  test('one that leaves on SIGTERM is not killed', async () => {
    const mine = nursed(4321, false)
    const { world } = machine()
    const w: AnywayWorld = { ...world, ours: (id) => mine.nursery.pidOf(id), stopOurs: (id) => mine.nursery.stop(id) }
    expect((await stopAnyway(ID, runnable(dir()), 4321, w)).ok).toBe(true)
    mine.timers[0]!.run()
    expect(mine.signals).toEqual([[-4321, 'SIGTERM']])
  })

  test('an inherited process that ignores SIGTERM is killed by its own group, and nothing else is signalled', async () => {
    const root = dir()
    const { world, m } = machine({ listener: 1234, cwds: { 1234: root, 1200: root }, groups: { 1234: 1200 }, freesOn: null })
    const stopped = await stopAnyway(ID, runnable(root), 1234, world)
    expect(stopped).toEqual({ ok: true, target: { whose: 'inherited', pid: 1234, pgid: 1200 }, killed: true })
    expect(m.signals).toEqual([[1200, 'SIGTERM'], [1200, 'SIGKILL']])
  })

  test('the process named by the first press has been replaced: nothing is stopped', async () => {
    const root = dir()
    const { world, m } = machine({ listener: 2222, cwds: { 2222: root }, groups: { 2222: 2222 } })
    const stopped = await stopAnyway(ID, runnable(root), 1234, world)
    expect(stopped.ok).toBe(false)
    expect(stopped.ok ? '' : stopped.why).toContain('the first press named process 1234, and what is running as kehikot.terminal now is process 2222')
    expect(m.signals).toEqual([])

    const mine = nursed(4321, true)
    const w: AnywayWorld = { ...world, ours: (id) => mine.nursery.pidOf(id), stopOurs: (id) => mine.nursery.stop(id) }
    expect((await stopAnyway(ID, runnable(root), 1234, w)).ok).toBe(false)
    expect(mine.signals).toEqual([])
    expect(mine.nursery.holds(ID)).toBe(true)
  })

  test('something else takes the port while the old one is stopping: it is not killed', async () => {
    const root = dir()
    const { world, m } = machine({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 1234 }, freesOn: null })
    const signalGroup = world.os.signalGroup
    world.os.signalGroup = (pgid, signal) => {
      signalGroup(pgid, signal)
      /* The old one leaves and a stranger binds the port at once. */
      if (signal === 'SIGTERM') {
        m.listener = 9000
        m.groups[9000] = 9000
      }
    }
    const stopped = await stopAnyway(ID, runnable(root), 1234, world)
    expect(stopped.ok).toBe(false)
    expect(m.signals).toEqual([[1234, 'SIGTERM']])
  })
})

describe('the route', () => {
  const kept = (root: string, more: Partial<Registration> = {}): Registration => ({
    id: ID,
    url: 'http://127.0.0.1:7920',
    dir: root,
    keep: true,
    file: join(root, 'kehikot.terminal.json'),
    ...more,
  })

  function desk(registration: Registration | null, over: Partial<Machine> = {}, more: { busy?: boolean; reached?: boolean } = {}) {
    const root = registration?.dir ?? dir()
    const { world, m } = machine({ listener: 1234, cwds: { 1234: root }, groups: { 1234: 1234 }, ...over })
    const restarts: Array<{ id: string; armed: number }> = []
    const events: string[] = []
    let now = 1000
    const built = anywayDesk({
      registration: async () => registration,
      startable: (one): Startable => (one?.dir ? { ok: true, run: runnable(one.dir) } : { ok: false, why: 'There is no registration for that module.' }),
      busy: () => more.busy === true,
      reached: async () => more.reached !== false,
      world,
      arms: new Arms(() => now),
      async restart(id, _registration, run, armed): Promise<Came> {
        restarts.push({ id, armed })
        const stopped = await stopAnyway(id, run, armed, world)
        if (!stopped.ok) return { ok: false, why: stopped.why }
        events.push(...m.signals.map(([pgid, signal]) => `${signal}:${pgid}`), 'start')
        return { ok: true, answered: true, detail: [], presence: { condition: 'ready' } }
      },
    })
    const post = async (body: unknown, headers: Record<string, string> = { origin: PAGE, 'content-type': 'application/json' }) => {
      const request = new Request('http://127.0.0.1:4180/host/restart-anyway', { method: 'POST', headers, body: JSON.stringify(body) })
      /* As the server does: where the request came from is decided once, before the route (`guard.ts`). */
      const refused = refusal({ method: 'POST', pathname: '/host/restart-anyway', headers: request.headers }, own({}, 4180, [PAGE, 'http://localhost:4181']))
      if (refused) return { status: refused.status, body: { ok: false, why: refused.why } as { ok: boolean; why?: string; kept?: boolean; armed?: { token: string; sentence: string; forMs: number }; presence?: unknown } }
      const response = (await built.route(request, new URL(request.url)))!
      return { status: response.status, body: (await response.json()) as { ok: boolean; why?: string; kept?: boolean; armed?: { token: string; sentence: string; forMs: number }; presence?: unknown } }
    }
    return { post, m, restarts, events, later: (ms: number) => (now += ms), route: built.route }
  }

  test('any other path or method is not this route’s', async () => {
    const { route } = desk(kept(dir()))
    for (const [method, path] of [['GET', '/host/restart-anyway'], ['POST', '/host/start'], ['POST', '/host/restart']] as const) {
      const request = new Request(`http://127.0.0.1:4180${path}`, { method })
      expect(await route(request, new URL(request.url))).toBeNull()
    }
  })

  test('a request that is not a press in this host’s page is refused before anything is read', async () => {
    const { post, m, restarts } = desk(kept(dir()))
    const body = { module: ID, press: 'arm' }
    const outside: Array<Record<string, string>> = [
      /* No browser said where it came from: a script, or an agent with a shell. */
      { 'content-type': 'application/json' },
      /* A module's own frame, and any other site. */
      { origin: 'http://127.0.0.1:7920', 'content-type': 'application/json' },
      { origin: 'https://example.com', 'content-type': 'application/json' },
      { origin: 'null', 'content-type': 'application/json' },
      /* What another origin can send without asking first. */
      { origin: PAGE, 'content-type': 'text/plain' },
      { origin: PAGE },
    ]
    for (const headers of outside) {
      const answered = await post(body, headers)
      expect(answered.status).toBe(403)
      expect(answered.body.why).toContain('Nothing was done.')
      expect(answered.body.armed).toBeUndefined()
    }
    expect(restarts).toEqual([])
    expect(m.signals).toEqual([])
    expect((await post(body, { origin: 'http://localhost:4181', 'content-type': 'application/json; charset=utf-8' })).status).toBe(200)
  })

  test('a module without keep is refused: its ordinary restart already restarts it', async () => {
    const root = dir()
    for (const registration of [kept(root, { keep: undefined }), kept(root, { keep: false })]) {
      const { post, m, restarts } = desk(registration)
      for (const body of [{ module: ID, press: 'arm' }, { module: ID, press: 'confirm', token: 'x' }]) {
        const answered = await post(body)
        expect(answered.status).toBe(409)
        expect(answered.body.why).toContain('does not say to keep it')
        expect(answered.body.kept).toBeUndefined()
      }
      expect(restarts).toEqual([])
      expect(m.signals).toEqual([])
    }
  })

  test('a module that is not registered, or a request that names nothing, is refused', async () => {
    expect((await desk(null).post({ module: ID, press: 'arm' })).status).toBe(409)
    const { post } = desk(kept(dir()))
    for (const body of [{}, { module: ID }, { module: ID, press: 'stop' }, { module: ID, press: 'confirm' }, { module: 'x'.repeat(65), press: 'arm' }, null]) {
      expect((await post(body)).status).toBe(400)
    }
  })

  test('one press is never enough: a confirm with no arm behind it stops nothing', async () => {
    const { post, m, restarts } = desk(kept(dir()))
    const answered = await post({ module: ID, press: 'confirm', token: 'made-up' })
    expect(answered.status).toBe(409)
    expect(answered.body.why).toContain('has no first press behind it')
    expect(answered.body.kept).toBe(true)
    expect(restarts).toEqual([])
    expect(m.signals).toEqual([])
  })

  test('the first press says what will be stopped and stops nothing; the second stops that process and starts the module', async () => {
    const root = dir()
    const { post, m, restarts, events } = desk(kept(root))
    const armed = await post({ module: 'roadmap.terminal', press: 'arm' })
    expect(armed.status).toBe(200)
    expect(armed.body.armed?.forMs).toBe(ARMED_FOR_MS)
    expect(armed.body.armed?.sentence).toContain('Restarting kehikot.terminal ends whatever it is running')
    expect(armed.body.armed?.sentence).toContain(`(process 1234) answers as kehikot.terminal from ${root}`)
    expect(m.signals).toEqual([])
    expect(restarts).toEqual([])

    const done = await post({ module: ID, press: 'confirm', token: armed.body.armed!.token })
    expect(done.status).toBe(200)
    expect(done.body.ok).toBe(true)
    expect(restarts).toEqual([{ id: ID, armed: 1234 }])
    /* Stopped first, then started; and one group only. */
    expect(events).toEqual(['SIGTERM:1234', 'start'])

    /* The token is spent: the same press again does nothing. */
    expect((await post({ module: ID, press: 'confirm', token: armed.body.armed!.token })).status).toBe(409)
    expect(restarts).toHaveLength(1)
  })

  test('an arm left alone comes down, and the late press stops nothing', async () => {
    const { post, m, restarts, later } = desk(kept(dir()))
    const armed = await post({ module: ID, press: 'arm' })
    later(ARMED_FOR_MS + 1)
    const late = await post({ module: ID, press: 'confirm', token: armed.body.armed!.token })
    expect(late.status).toBe(409)
    expect(restarts).toEqual([])
    expect(m.signals).toEqual([])
  })

  test('the first press is refused, with the sentence, when the listener cannot be shown to be the module', async () => {
    const { post, m } = desk(kept(dir()), { says: 'kehikot.notes' })
    const answered = await post({ module: ID, press: 'arm' })
    expect(answered.status).toBe(409)
    expect(answered.body.why).toBe(
      'kehikot.terminal was not restarted: the program on port 7920 answers as kehikot.notes, not as kehikot.terminal. '
      + 'This host only stops a program it can show is kehikot.terminal, and nothing was stopped.',
    )
    expect(answered.body.kept).toBe(true)
    expect(m.signals).toEqual([])
  })

  test('a module that is not running, or already being restarted, is not armed', async () => {
    const quiet = await desk(kept(dir()), {}, { reached: false }).post({ module: ID, press: 'arm' })
    expect(quiet.status).toBe(409)
    expect(quiet.body.why).toBe('kehikot.terminal is not running now, so there is nothing to stop. Try again starts it.')
    expect(quiet.body.kept).toBe(false)
    const busy = await desk(kept(dir()), {}, { busy: true }).post({ module: ID, press: 'arm' })
    expect(busy.status).toBe(409)
    expect(busy.body.why).toContain('already being restarted or updated')
  })
})

describe('an agent has no way to do it', () => {
  test('the host’s MCP door offers no tool that restarts or stops a module', async () => {
    const db = new Database(':memory:')
    const reply = await mcp(
      { id: 1, method: 'tools/list' },
      { db, which: () => [], wake: () => {}, epicsChanged: () => {}, dispositionsChanged: () => {}, seen: async () => [] } as never,
      { name: 'kehikko', version: '0.1.0' },
    )
    db.close()
    const tools = (reply.body as { result: { tools: { name: string; description?: string }[] } }).result.tools
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/restart|stop|kill|anyway|start/i)
      expect(tool.description ?? '').not.toMatch(/restart-anyway|Restart anyway/i)
    }
  })
})
