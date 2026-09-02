import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentKnows, awarenessOf, scopeOf } from '../server/agents.ts'
import { HOST_ID } from '../server/kehikot.ts'
import { addArgs, connect, hostDoor, repoint, serverName, type Runner } from '../server/register.ts'

/**
 * The host's own door, and the plug on the host's strip that connects it.
 *
 * Every module's container header had a plug; the host's strip had none, and
 * the host is the one door an agent most needs — `read_canvas` is how it finds
 * out which containers a person has picked out. The fix reuses the module
 * path end to end, so what is worth testing is that the host really does go
 * through it: the same name derivation, the same awareness reader, the same
 * three states, the same press. And, above all, the one invariant `agents.ts`
 * states and this branch must not weaken: nothing writes to the agent's
 * configuration except an explicit press.
 */

const made: string[] = []
function scratch(name: string): string {
  const path = join(tmpdir(), `kehikko-host-door-${process.pid}-${made.length}-${name}`)
  rmSync(path, { recursive: true, force: true })
  made.push(path)
  return path
}
function config(contents: unknown): string {
  const path = scratch('claude.json')
  writeFileSync(path, JSON.stringify(contents, null, 2))
  return path
}
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A runner that records and never spawns. The same shape `register.test.ts` uses. */
function recording() {
  const calls: string[][] = []
  const run: Runner = async (args) => {
    calls.push(args)
    return { ok: true, said: 'Added' }
  }
  return { calls, run }
}

describe('what the host’s door is called, and where it is', () => {
  test('the server name is HOST_ID, so the config, the door’s serverInfo and the folder on disk are one word', () => {
    const door = hostDoor(4180)
    expect(door.module).toBe(HOST_ID)
    expect(door.as).toBe(HOST_ID)
    expect(door.as).toBe('kehikko')
    expect(door.url).toBe('http://127.0.0.1:4180/mcp')
    expect(door.transport).toBe('http')
  })

  test('the name is stable across ports; only the address moves', () => {
    expect(hostDoor(4182).as).toBe(hostDoor(4180).as)
    expect(hostDoor(4182).url).not.toBe(hostDoor(4180).url)
  })

  test('the reader’s tail match agrees with the writer’s name, as it does for every module', () => {
    /* `awarenessOf` matches a stale entry on the id's last segment. A host
       whose name had a dot in it would register under one name and be read
       back under another, and `elsewhere` would never be reported for it. */
    expect(serverName(HOST_ID)).toBe(HOST_ID)
  })

  test('the press for the host runs exactly what the press for a module runs', async () => {
    const door = hostDoor(4180)
    expect(addArgs(door)).toEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      '--transport',
      'http',
      'kehikko',
      'http://127.0.0.1:4180/mcp',
    ])
    const { calls, run } = recording()
    const said = await connect(door, run)
    expect(said.ok).toBe(true)
    expect(calls).toEqual([addArgs(door)])
  })
})

describe('the same three states the module plug has', () => {
  test('untold: nothing configured', () => {
    const file = config({ mcpServers: {} })
    expect(awarenessOf(hostDoor(4180).url, HOST_ID, agentKnows(file))).toEqual({ kind: 'untold' })
  })

  test('told: something points at the door, whatever it is called', () => {
    /* Matched on url first. The person who wrote this entry by hand called it
       what they liked, and it is still the agent having been told. */
    const file = config({ mcpServers: { 'my-canvas': { type: 'http', url: 'http://127.0.0.1:4180/mcp/' } } })
    expect(awarenessOf(hostDoor(4180).url, HOST_ID, agentKnows(file))).toEqual({
      kind: 'told',
      as: 'my-canvas',
    })
  })

  test('elsewhere: the host moved port and the entry did not — which is what repoint is for', async () => {
    /* `run.sh` takes PORT and `claim.ts` moves on when 4180 is taken. An entry
       written against 4180 while the host is on 4182 is stale in exactly the
       way a module that moved port is stale, and it is read the same way. */
    const file = config({ mcpServers: { kehikko: { type: 'http', url: 'http://127.0.0.1:4180/mcp' } } })
    const door = hostDoor(4182)
    const agent = awarenessOf(door.url, HOST_ID, agentKnows(file))
    expect(agent).toEqual({ kind: 'elsewhere', as: 'kehikko', pointsAt: 'http://127.0.0.1:4180/mcp' })
    expect(scopeOf('kehikko', file)).toEqual({ scope: 'user' })

    const { calls, run } = recording()
    const said = await repoint('kehikko', door, run)
    expect(said.ok).toBe(true)
    expect(calls).toEqual([['mcp', 'remove', 'kehikko'], addArgs(door)])
  })

  test('a stale entry in local scope is found and its scope is named before anything is rewritten', () => {
    const file = config({
      mcpServers: {},
      projects: { '/somewhere': { mcpServers: { kehikko: { type: 'http', url: 'http://127.0.0.1:4180/mcp' } } } },
    })
    expect(awarenessOf(hostDoor(4182).url, HOST_ID, agentKnows(file)).kind).toBe('elsewhere')
    expect(scopeOf('kehikko', file)).toEqual({ scope: 'local', project: '/somewhere' })
  })
})

/**
 * The invariant that matters most: the host never writes to the agent's
 * configuration except on an explicit press.
 *
 * Two guards. The first is behavioural: everything that runs on a sweep or a
 * page load leaves the file byte-for-byte as it was. The second is structural,
 * read off the source: the only thing that can write is the `claude` CLI, the
 * only file that spawns it is `register.ts`, and the only place in the server
 * that calls into `register.ts`'s writers is the `/host/agent` route — the
 * press. A future sweep that "helpfully" connected a missing door would fail
 * here with the line number in the message.
 */
describe('nothing writes to the agent’s configuration except a press', () => {
  test('reading the host’s awareness leaves the file exactly as it was', () => {
    const file = config({ mcpServers: { kehikko: { type: 'http', url: 'http://127.0.0.1:4180/mcp' } } })
    const before = readFileSync(file, 'utf8')
    const mtime = statSync(file).mtimeMs

    /* Everything the sweep and the window do with this file, several times. */
    for (let i = 0; i < 3; i++) {
      const known = agentKnows(file)
      awarenessOf(hostDoor(4180).url, HOST_ID, known)
      awarenessOf(hostDoor(4182).url, HOST_ID, known)
      scopeOf('kehikko', file)
    }

    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(statSync(file).mtimeMs).toBe(mtime)
  })

  test('agents.ts can only read: it imports nothing that writes or spawns', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'server', 'agents.ts'), 'utf8')
    const imports = source.match(/^import .*$/gm) ?? []
    expect(imports.some((line) => line.includes("from 'node:fs'"))).toBe(true)
    for (const line of imports) {
      expect(line).not.toMatch(/writeFileSync|writeFile|appendFile|child_process|spawn|exec/)
    }
    expect(source).not.toMatch(/writeFileSync|child_process|spawn\(/)
  })

  test('only register.ts spawns `claude`', () => {
    /* Every file in the directory, read off the disk, so a new file that
       spawned the CLI could not be left off a list. */
    const dir = join(import.meta.dir, '..', 'server')
    const files = readdirSync(dir).filter((file) => file.endsWith('.ts'))
    expect(files).toContain('register.ts')
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8')
      const spawnsClaude = /spawn\(\s*['"]claude['"]/.test(source)
      expect(spawnsClaude, `${file} spawns claude`).toBe(file === 'register.ts')
    }
  })

  test('the server calls a writer from the /host/agent route and from nowhere else', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'server', 'server.ts'), 'utf8')

    const start = source.indexOf("url.pathname === '/host/agent'")
    expect(start).toBeGreaterThan(0)
    const end = source.indexOf('url.pathname ===', start + 1)
    expect(end).toBeGreaterThan(start)

    const writers = /\bawait (connect|disconnect|repoint)\(/g
    const found: { name: string; line: number; inside: boolean }[] = []
    for (const hit of source.matchAll(writers)) {
      const at = hit.index ?? -1
      found.push({
        name: hit[1]!,
        line: source.slice(0, at).split('\n').length,
        inside: at > start && at < end,
      })
    }
    /* All three presses exist, and every one of them is inside the route. */
    expect(new Set(found.map((f) => f.name))).toEqual(new Set(['connect', 'disconnect', 'repoint']))
    for (const call of found) {
      expect(call.inside, `${call.name} is called on line ${call.line}, outside the /host/agent route`).toBe(true)
    }

    /* And the sweep, specifically, names none of them. `survey` is where the
       host reads the agent's configuration once per sweep; it is the place a
       quiet write would be most tempting and most wrong. */
    const survey = source.slice(source.indexOf('async function survey('), source.indexOf('type Swept ='))
    expect(survey.length).toBeGreaterThan(0)
    expect(survey).not.toMatch(/\b(connect|disconnect|repoint|runClaude)\(/)
  })
})

/**
 * The server, actually running, against scratch everything.
 *
 * The rest of this file exercises the pieces; this exercises the seam — that
 * `/host/modules` carries the host's door, that `/host/tools` answers for
 * `HOST_ID` from the host's own port rather than from the registry, that the
 * host can ask its own door what it offers, and that a page load and a window
 * opening write nothing. It does not press Connect, because a real press runs
 * the real `claude` CLI, and no test suite should edit the config of whoever
 * ran it — see `register.test.ts`. It does send the one press the server
 * refuses before running anything, to prove the POST route reaches the host's
 * door too.
 */
describe('the host’s server, running', () => {
  async function freePort(): Promise<number> {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
    const port = probe.port ?? 0
    probe.stop(true)
    expect(port).toBeGreaterThan(0)
    return port
  }

  test('a page load and a window opening reach the host’s door and write nothing', async () => {
    const port = await freePort()
    const file = config({ mcpServers: { kehikko: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } })
    const before = readFileSync(file, 'utf8')
    const modules = scratch('modules')
    mkdirSync(modules, { recursive: true })
    const project = scratch('project')
    mkdirSync(project, { recursive: true })

    const child = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', 'server', 'server.ts')], {
      cwd: join(import.meta.dir, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        CLAUDE_CONFIG: file,
        ROADMAP_FRAME_DB: scratch('frame.sqlite'),
        ROADMAP_MODULES_DIR: modules,
        KEHIKKO_ROADMAP_DIR: project,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      const api = `http://127.0.0.1:${port}`
      const deadline = Date.now() + 15000
      let registry: { host?: { id: string; as: string; url: string; agent: { kind: string; as?: string } } } | null = null
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${api}/host/modules`)
          if (response.ok) {
            registry = (await response.json()) as typeof registry
            break
          }
        } catch {
          /* Not up yet. */
        }
        await Bun.sleep(100)
      }
      expect(registry, 'the server did not come up').not.toBeNull()

      /* The sweep carries the host's own door, read against the scratch file. */
      expect(registry!.host).toEqual({
        id: 'kehikko',
        as: 'kehikko',
        url: `${api}/mcp`,
        agent: { kind: 'told', as: 'kehikko' },
      })

      /* The window: the host answers for its own id from its own port, and
         asks its own door what it offers. */
      const asked = await fetch(`${api}/host/tools?module=kehikko`)
      expect(asked.status).toBe(200)
      const door = (await asked.json()) as {
        ok: boolean
        about: string
        as: string
        url: string
        agent: { kind: string }
        tools: { ok: boolean; tools?: { name: string }[] }
      }
      expect(door.ok).toBe(true)
      expect(door.about).toBe('host')
      expect(door.as).toBe('kehikko')
      expect(door.url).toBe(`${api}/mcp`)
      expect(door.agent.kind).toBe('told')
      expect(door.tools.ok).toBe(true)
      expect(door.tools.tools?.map((t) => t.name).sort()).toEqual(['read_canvas', 'select_modules'])

      /* The POST route reaches the host's door too — refused here, before
         anything is run, because the agent has already been told. */
      const pressed = await fetch(`${api}/host/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ module: 'kehikko', press: 'connect' }),
      })
      expect(pressed.status).toBe(409)
      expect(((await pressed.json()) as { why: string }).why).toContain('already been told')

      /* And after all of that, the file is what it was. */
      expect(readFileSync(file, 'utf8')).toBe(before)
    } finally {
      child.kill()
      await child.exited
    }
  }, 30000)
})
