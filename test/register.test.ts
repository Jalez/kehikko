import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  addArgs,
  connect,
  disconnect,
  doorFor,
  overTheWire,
  removeArgs,
  repoint,
  SCOPE,
  serverName,
  type Door,
  type Runner,
} from '../server/register.ts'

/**
 * The press that writes to somebody's agent configuration.
 *
 * `agents.ts` reads that file and never touches it, and says the other half out
 * loud: doing something about it is a press, and a separate decision. This is
 * that decision, so the things worth testing are the ones that keep it from
 * becoming something larger — which arguments are actually run, that the module
 * id is looked up in the host's own registry rather than trusted, and that a
 * repoint cannot leave somebody with their old server deleted and nothing in
 * its place.
 *
 * Nothing here runs `claude`. The runner is a parameter for exactly that
 * reason, the way `launch.ts` keeps the spawn behind one small function: a test
 * suite that exercised this for real would edit the config of whoever ran it.
 */

/** A runner that records and answers, and never spawns anything. */
function recording(answer: (args: string[]) => { ok: boolean; said: string } = () => ({ ok: true, said: 'Added' })) {
  const calls: string[][] = []
  const run: Runner = async (args) => {
    calls.push(args)
    return answer(args)
  }
  return { calls, run }
}

const door: Door = {
  module: 'roadmap.checklist',
  as: 'checklist',
  url: 'http://127.0.0.1:7860/mcp',
  transport: 'http',
}

describe('what the host would run, before it runs it', () => {
  test('the name is the id’s last segment, which is what `claude mcp add` is usually given', () => {
    expect(serverName('roadmap.checklist')).toBe('checklist')
    expect(serverName('checklist')).toBe('checklist')
    expect(serverName('a.b.c')).toBe('c')
  })

  test('an add names the scope, because a write has to go somewhere specific', () => {
    /* `agentKnows` flattens scopes when it READS and that is right for the
       question it answers. A button cannot be equally relaxed. */
    expect(addArgs(door)).toEqual([
      'mcp',
      'add',
      '--scope',
      SCOPE,
      '--transport',
      'http',
      'checklist',
      'http://127.0.0.1:7860/mcp',
    ])
    expect(SCOPE).toBe('user')
  })

  test('a remove does NOT name a scope', () => {
    /* The entry being removed is one the host found by reading, and it may have
       been written by hand into a scope this host would never write to. A
       remove pinned to `user` would report success on a server it had not
       touched. */
    expect(removeArgs('checklist')).toEqual(['mcp', 'remove', 'checklist'])
  })

  test('a url is not a command line, so stdio is refused rather than invented', async () => {
    expect(overTheWire('http')).toBe(true)
    expect(overTheWire('sse')).toBe(true)
    expect(overTheWire('stdio')).toBe(false)

    const { calls, run } = recording()
    const said = await connect({ ...door, transport: 'stdio' }, run)
    expect(said.ok).toBe(false)
    expect(said.said).toContain('stdio')
    /* And nothing was run. A host that guessed a command line here would be the
       thing `launch.ts` refuses to let a registration be. */
    expect(calls).toEqual([])
  })
})

describe('connecting and disconnecting', () => {
  test('a connect runs the add and reports the line verbatim', async () => {
    const { calls, run } = recording()
    const said = await connect(door, run)
    expect(calls).toEqual([addArgs(door)])
    expect(said.ok).toBe(true)
    expect(said.command).toBe(`claude ${addArgs(door).join(' ')}`)
  })

  test('a failing CLI is reported with its own words and not this host’s', async () => {
    const { run } = recording(() => ({ ok: false, said: 'A server named checklist already exists' }))
    const said = await connect(door, run)
    expect(said.ok).toBe(false)
    expect(said.said).toContain('already exists')
  })

  test('a disconnect names the server that was found, and nothing else', async () => {
    const { calls, run } = recording()
    await disconnect('whatever-they-called-it', run)
    expect(calls).toEqual([['mcp', 'remove', 'whatever-they-called-it']])
  })
})

describe('repointing an entry that is not this host’s', () => {
  test('remove then add, in that order', async () => {
    /* `claude mcp add` refuses a name that is already taken, and it is right to:
       an add that silently replaced would be the quiet edit this whole design is
       arranged to avoid. So the replacement is two explicit steps. */
    const { calls, run } = recording()
    const said = await repoint('checklist', door, run)
    expect(calls).toEqual([['mcp', 'remove', 'checklist'], addArgs(door)])
    expect(said.ok).toBe(true)
  })

  test('a failed remove does not go on to add', async () => {
    /* The alternative is a host that deleted somebody's server and then failed
       to put anything in its place. */
    const { calls, run } = recording((args) =>
      args[1] === 'remove' ? { ok: false, said: 'no such server' } : { ok: true, said: 'Added' },
    )
    const said = await repoint('checklist', door, run)
    expect(calls).toEqual([['mcp', 'remove', 'checklist']])
    expect(said.ok).toBe(false)
    expect(said.said).toContain('nothing was changed')
  })

  test('a remove that worked and an add that did not says so, because something IS gone', async () => {
    const { run } = recording((args) =>
      args[1] === 'remove' ? { ok: true, said: 'Removed' } : { ok: false, said: 'refused' },
    )
    const said = await repoint('checklist', door, run)
    expect(said.ok).toBe(false)
    expect(said.said).toContain('was removed')
  })
})

/**
 * The lookup, which is the thing standing between this and an endpoint that
 * registers arbitrary MCP servers on somebody's machine.
 *
 * What arrives over the wire is a module id. The address comes from a
 * registration file on the person's own disk and from the manifest the module
 * itself served. Nothing else can name a url.
 */
describe('the door comes from the registry, never from a request', () => {
  const made: string[] = []
  function registry(): string {
    const path = join(tmpdir(), `kehikko-register-${process.pid}-${made.length}`)
    rmSync(path, { recursive: true, force: true })
    mkdirSync(path, { recursive: true })
    made.push(path)
    return path
  }
  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
    delete process.env.ROADMAP_MODULES_DIR
  })

  test('an unknown module id is refused, and the refusal says where it looked', async () => {
    const dir = registry()
    process.env.ROADMAP_MODULES_DIR = dir

    const found = await doorFor('roadmap.not-a-thing')
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.status).toBe(404)
    expect(found.why).toContain('roadmap.not-a-thing')
    expect(found.why).toContain(dir)
  })

  test('a url in the request cannot become a module id', async () => {
    /* There is no path from a string somebody POSTed to an address this host
       will register: the string is only ever matched against filenames in the
       registry directory. */
    const dir = registry()
    process.env.ROADMAP_MODULES_DIR = dir
    writeFileSync(join(dir, 'roadmap.checklist.json'), JSON.stringify({ url: 'http://127.0.0.1:7860' }))

    const found = await doorFor('http://evil.example/mcp')
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.status).toBe(404)
  })

  test('a registered module that is not answering cannot have a door read off it', async () => {
    /* Port 9 is discard: registered, loopback, and nothing there. The sentence
       has to be about the module not answering rather than about a missing
       manifest field, because those send a person to different places. */
    const dir = registry()
    process.env.ROADMAP_MODULES_DIR = dir
    writeFileSync(join(dir, 'roadmap.quiet.json'), JSON.stringify({ url: 'http://127.0.0.1:9' }))

    const found = await doorFor('roadmap.quiet')
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.status).toBe(409)
    expect(found.why).toContain('not answering')
  })
})
