import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SERVER = join(import.meta.dir, '..', 'server')

/**
 * The source of the host's own MCP door, whole: `server/mcp.ts` and every file under `server/mcp/`
 * (its tools, their shared words and the reading of a canvas). A test that asserts what the door
 * says, or that no tool of it reaches something, reads this — never `mcp.ts` alone, which would miss
 * a tool in a module of its own.
 */
export function doorSource(): string {
  const files = [
    join(SERVER, 'mcp.ts'),
    ...readdirSync(join(SERVER, 'mcp'), { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => join(SERVER, 'mcp', name)),
  ]
  return files.map((file) => readFileSync(file, 'utf8')).join('\n')
}
