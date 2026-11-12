import { describe, expect, test } from 'bun:test'

import { open } from '../server/canvases.ts'
import { mcp, type Door } from '../server/mcp.ts'

/**
 * What agents read of this host's door says spaces. A project holds a tree of
 * spaces; "epic" and "parts" are the older names of its top-level spaces and
 * their direct sub-spaces, still accepted as arguments and kept as tool names
 * (create_epic, set_parts) so no agent breaks. So wherever a description or the
 * door's instructions say epic or part, the same sentence says it is the older
 * name — never the concept an agent is taught first.
 */

type Tool = { name: string; description: string; inputSchema: { properties?: Record<string, { description?: string }> } }

const door = (): Door =>
  ({ db: open(':memory:'), which: () => ({ ok: false, why: 'none' }), wake: () => {}, epicsChanged: () => {}, dispositionsChanged: () => {}, seen: async () => [] }) as unknown as Door

async function read(): Promise<{ instructions: string; tools: Tool[] }> {
  const about = { name: 'kehikko', version: '0' }
  const hello = await mcp({ id: 1, method: 'initialize' }, door(), about)
  const listed = await mcp({ id: 2, method: 'tools/list' }, door(), about)
  return {
    instructions: (hello.body as { result: { instructions: string } }).result.instructions,
    tools: (listed.body as { result: { tools: Tool[] } }).result.tools,
  }
}

/** Every description an agent reads: the door's instructions, each tool's, each argument's (nested too). */
function texts(instructions: string, tools: Tool[]): { where: string; text: string }[] {
  const out = [{ where: 'instructions', text: instructions }]
  const walk = (where: string, value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'description' && typeof inner === 'string') out.push({ where, text: inner })
      else walk(`${where}.${key}`, inner)
    }
  }
  for (const tool of tools) walk(tool.name, tool)
  return out
}

const OLD = /\b(epics?|parts?)\b/i
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/)

describe('what agents read of the door says spaces', () => {
  test('the instructions and the tools that are about places teach spaces', async () => {
    const { instructions, tools } = await read()
    expect(instructions).toMatch(/\bspaces?\b/)
    for (const name of ['my_place', 'set_my_place', 'read_canvas', 'jump', 'offer_jump', 'edit_space', 'create_epic', 'set_parts', 'propose_adoption']) {
      const tool = tools.find((one) => one.name === name)!
      expect(tool.description, name).toMatch(/\bspaces?\b/)
    }
  })

  test('"epic" and "part" appear only where the same sentence calls them the older name', async () => {
    const { instructions, tools } = await read()
    const primary = texts(instructions, tools)
      .flatMap(({ where, text }) => sentences(text).map((sentence) => ({ where, sentence })))
      /* Tool names and file paths are spellings, not the concept. */
      .filter(({ sentence }) => OLD.test(sentence.replace(/\b(create_epic|set_parts)\b|\S*\/\S*/g, '')) && !/\bolder\b/i.test(sentence))
    expect(primary).toEqual([])
  })

  test('a tool that takes space lists it before the older epic and parts, and those say they are older names', async () => {
    const { tools } = await read()
    const taking = tools.filter((tool) => tool.inputSchema.properties?.space)
    expect(taking.map((tool) => tool.name).sort()).toEqual(['jump', 'offer_jump', 'set_my_place'])
    for (const tool of taking) {
      const keys = Object.keys(tool.inputSchema.properties!)
      expect(keys.indexOf('space'), tool.name).toBeLessThan(keys.indexOf('epic'))
      expect(tool.inputSchema.properties!.epic!.description, tool.name).toStartWith('Older name, still accepted')
      expect(tool.inputSchema.properties!.parts!.description, tool.name).toStartWith('Older name, still accepted')
    }
  })

  test('the tools named for epics and parts keep their names and point to edit_space', async () => {
    const { tools } = await read()
    const names = tools.map((tool) => tool.name)
    for (const name of ['create_epic', 'set_parts', 'edit_space']) expect(names).toContain(name)
    for (const name of ['create_epic', 'set_parts']) {
      const said = tools.find((tool) => tool.name === name)!.description
      expect(said, name).toContain('edit_space')
      expect(said, name).toMatch(/preferred/)
    }
  })
})
