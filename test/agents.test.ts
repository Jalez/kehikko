import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { agentConfigFile, agentKnows, awarenessOf, scopeOf } from '../server/agents.ts'

/**
 * Whether the agent has been told about a module's tools.
 *
 * The quietest failure in the system: a module running perfectly, serving an
 * MCP door, and an agent that has never heard of it. Nothing errors; the tools
 * are simply absent from a conversation happening elsewhere. So the three
 * answers have to be kept apart, and that is what is tested here.
 */

const files: string[] = []
function config(contents: unknown): string {
  const path = join(tmpdir(), `kehikko-agent-${process.pid}-${files.length}.json`)
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
  files.push(path)
  return path
}
afterEach(() => {
  for (const path of files.splice(0)) rmSync(path, { force: true })
})

describe('reading what the agent has been told', () => {
  test('global servers', () => {
    const known = agentKnows(config({ mcpServers: { one: { url: 'http://127.0.0.1:7860/mcp' } } }))
    expect([...known.keys()]).toEqual(['one'])
  })

  test('project servers too, because which scope is not this host’s opinion', () => {
    const known = agentKnows(
      config({
        mcpServers: { global: { url: 'http://a/mcp' } },
        projects: { '/somewhere': { mcpServers: { local: { url: 'http://b/mcp' } } } },
      }),
    )
    expect([...known.keys()].sort()).toEqual(['global', 'local'])
  })

  test('no config at all is nothing known, not an error', () => {
    /* An agent that has never been configured is an ordinary state, and the
       sentence a person needs is the same either way. */
    expect(agentKnows(join(tmpdir(), 'kehikko-agent-absent.json')).size).toBe(0)
  })

  test('a config that is not JSON is nothing known', () => {
    expect(agentKnows(config('{ not json')).size).toBe(0)
    expect(agentKnows(config('"a string"')).size).toBe(0)
  })
})

describe('the three answers, kept apart', () => {
  const door = 'http://127.0.0.1:7860/mcp'

  test('a module with no MCP door is not a problem and must not be drawn as one', () => {
    expect(awarenessOf(null, 'roadmap.mapmaker', new Map())).toEqual({ kind: 'none' })
  })

  test('nothing configured is untold', () => {
    expect(awarenessOf(door, 'roadmap.checklist', new Map())).toEqual({ kind: 'untold' })
  })

  test('a server pointing here is told, whatever it is called', () => {
    /* The url decides whether a request arrives; the name is a label somebody
       chose. So a match on url counts however it was named. */
    const known = new Map<string, unknown>([['whatever-they-called-it', { url: door }]])
    expect(awarenessOf(door, 'roadmap.checklist', known)).toEqual({
      kind: 'told',
      as: 'whatever-they-called-it',
    })
  })

  test('a trailing slash is not a difference anybody means', () => {
    const known = new Map<string, unknown>([['x', { url: `${door}/` }]])
    expect(awarenessOf(door, 'roadmap.checklist', known).kind).toBe('told')
  })

  test('this module’s name pointing somewhere else is the interesting failure', () => {
    /* Almost always a module that has moved port. The agent reaches the old
       address, gets nothing, and it looks like a broken module rather than a
       stale line in a config file. */
    const known = new Map<string, unknown>([['roadmap.checklist', { url: 'http://127.0.0.1:7999/mcp' }]])
    expect(awarenessOf(door, 'roadmap.checklist', known)).toEqual({
      kind: 'elsewhere',
      as: 'roadmap.checklist',
      pointsAt: 'http://127.0.0.1:7999/mcp',
    })
  })

  test('the short name counts too, since that is what `claude mcp add` is usually given', () => {
    const known = new Map<string, unknown>([['checklist', { url: 'http://127.0.0.1:7999/mcp' }]])
    expect(awarenessOf(door, 'roadmap.checklist', known).kind).toBe('elsewhere')
  })

  test('a server named for something else entirely leaves this module untold', () => {
    const known = new Map<string, unknown>([['unrelated', { url: 'http://elsewhere/mcp' }]])
    expect(awarenessOf(door, 'roadmap.checklist', known)).toEqual({ kind: 'untold' })
  })

  test('a configured server with no url cannot be a match', () => {
    /* A stdio server — a command, no url. It cannot be pointing at this door
       and it cannot be pointing anywhere else either. */
    const known = new Map<string, unknown>([['roadmap.checklist', { command: 'bun', args: ['x'] }]])
    expect(awarenessOf(door, 'roadmap.checklist', known)).toEqual({ kind: 'untold' })
  })
})

describe('where the config is', () => {
  test('the environment can move it, which is what makes this testable', () => {
    expect(agentConfigFile({ CLAUDE_CONFIG: '/tmp/x.json' })).toBe('/tmp/x.json')
    expect(agentConfigFile({})).toMatch(/\.claude\.json$/)
  })
})

/**
 * The un-flattening.
 *
 * Reading flattens the scopes on purpose — "has the agent been told" has one
 * answer whichever scope it was arranged in. A button that WRITES cannot be
 * equally relaxed: it puts the entry somewhere specific, and a person letting a
 * host edit their agent's configuration is owed the where before the press.
 */
describe('which scope a configured server actually sits in', () => {
  test('the root mcpServers is user scope', () => {
    const file = config({ mcpServers: { checklist: { url: 'http://a/mcp' } } })
    expect(scopeOf('checklist', file)).toEqual({ scope: 'user' })
  })

  test('a project’s own servers are local scope, and the project is named', () => {
    const file = config({ projects: { '/here': { mcpServers: { paper: { url: 'http://b/mcp' } } } } })
    expect(scopeOf('paper', file)).toEqual({ scope: 'local', project: '/here' })
  })

  test('global wins when a name is in both, in the order agentKnows reads them', () => {
    /* Otherwise the scope reported would be whichever this happened to look at
       second, which is a different answer from the one reading gave. */
    const file = config({
      mcpServers: { paper: { url: 'http://a/mcp' } },
      projects: { '/here': { mcpServers: { paper: { url: 'http://b/mcp' } } } },
    })
    expect(scopeOf('paper', file)).toEqual({ scope: 'user' })
  })

  test('a name that is configured nowhere is null, not a guess', () => {
    expect(scopeOf('checklist', config({ mcpServers: {} }))).toBeNull()
    expect(scopeOf('checklist', config('{ not json'))).toBeNull()
  })

  test('a name that only exists on Object.prototype is not configured', () => {
    /* `constructor` and `toString` are ordinary lowercase words and a module
       could plausibly be called either. `in` would answer true for both on a
       plain object, and the host would report a scope for a server nobody has. */
    const file = config({ mcpServers: {} })
    expect(scopeOf('constructor', file)).toBeNull()
    expect(scopeOf('toString', file)).toBeNull()
  })
})
