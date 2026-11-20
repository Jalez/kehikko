import type { ToolName } from './names.ts'
import { listing, type Tool, type ToolSchema } from './tool.ts'
import { kehikkoSkills } from './tools/kehikkoSkills.ts'
import { messageTools } from './tools/messages.ts'
import { moduleSettings } from './tools/moduleSettings.ts'
import { myPlaceTool, setMyPlaceTool } from './tools/myPlace.ts'
import { readCanvas } from './tools/readCanvas.ts'
import { readInbox } from './tools/readInbox.ts'
import { readLogsTool } from './tools/readLogs.ts'
import { storage } from './tools/storage.ts'

/**
 * The tools that live in a module of their own under `tools/`, one module per tool or per small
 * group: each says its name, what `tools/list` says of it, and what answers a call. `call` in
 * `server/mcp.ts` runs a tool found here; the rest of the door's tools are still answered there.
 */
const REGISTERED: readonly Tool[] = [
  myPlaceTool,
  setMyPlaceTool,
  storage,
  readLogsTool,
  moduleSettings,
  kehikkoSkills,
  readCanvas,
  readInbox,
  ...messageTools,
]

const BY_NAME: ReadonlyMap<string, Tool> = new Map(REGISTERED.map((tool) => [tool.name, tool]))

/** The registered tool of that name, if it is one. */
export function registered(name: string): Tool | undefined {
  return BY_NAME.get(name)
}

/** A registered tool as `tools/list` lists it. Throws for a name that is not registered: a wiring mistake. */
export function listed(name: ToolName): { name: ToolName } & ToolSchema {
  const tool = BY_NAME.get(name)
  if (!tool) throw new Error(`${name} is not a registered tool`)
  return listing(tool)
}
