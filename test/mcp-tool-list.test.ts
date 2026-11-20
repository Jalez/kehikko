import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { open } from '../server/canvases.ts'
import { mcp, TOOL_NAMES, type Door } from '../server/mcp.ts'

/**
 * The host door's tool list, byte for byte.
 *
 * Agents learn every tool from this list — its names, its descriptions, its argument schemas and
 * their order — and tests across the suite assert on pieces of it. `test/fixtures/mcp-tool-list.json`
 * is the list as `tools/list` answered before the tools were split into a registry
 * (`server/mcp/tools/`); a change to a tool's wording or schema is a change to that file too, made
 * on purpose and seen in review, never a side effect of moving code.
 */

const FIXTURE = join(import.meta.dir, 'fixtures', 'mcp-tool-list.json')

const door = (): Door =>
  ({ db: open(':memory:'), which: () => ({ ok: false, why: 'none' }), wake: () => {}, epicsChanged: () => {}, dispositionsChanged: () => {}, seen: async () => [] }) as unknown as Door

async function listed(): Promise<{ instructions: string; tools: unknown[] }> {
  const about = { name: 'kehikko', version: '0' }
  const hello = await mcp({ id: 1, method: 'initialize' }, door(), about)
  const tools = await mcp({ id: 2, method: 'tools/list' }, door(), about)
  return {
    instructions: (hello.body as { result: { instructions: string } }).result.instructions,
    tools: (tools.body as { result: { tools: unknown[] } }).result.tools,
  }
}

describe('the host door’s tool list', () => {
  test('is exactly the list agents were given: names, descriptions, schemas, annotations and order', async () => {
    const now = await listed()
    expect(`${JSON.stringify(now, null, 2)}\n`).toBe(readFileSync(FIXTURE, 'utf8'))
  })

  test('lists every tool the door answers, and only those', async () => {
    const names = ((await listed()).tools as { name: string }[]).map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual([...TOOL_NAMES].sort())
  })
})
