import type { Canvas } from '../canvases.ts'
import type { Answer, Door, Placed } from './door.ts'
import type { ToolName } from './names.ts'

/**
 * One tool of the host's door: its name, what `tools/list` says of it, and what answers a call.
 *
 * A tool is one of two kinds, and the kind decides what it is handed. A door tool (`doorTool`) is
 * about the machine, the conversation or the page on screen and names no kehikko, so it is handed
 * the door alone. A kehikko tool (`kehikkoTool`) acts on one kehikko, and is called only once
 * `decide` (`where.ts`) has settled which — a call it refuses is answered with that refusal and the
 * tool never runs — so it is handed the kehikko and the words that say how it was decided.
 */

/**
 * What `tools/list` says of a tool, after its name, as it is written — the order of its keys
 * included, because the list is sent as written and agents (and a test) read it byte for byte.
 */
export interface ToolSchema {
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

type Args = Record<string, unknown>

/** What a door tool is handed. */
export interface DoorCall {
  door: Door
}

/** What a kehikko tool is handed: the door, the kehikko `decide` settled on, and how it decided. */
export interface KehikkoCall extends DoorCall {
  canvas: Canvas
  how: string
  /** The conversation's place and what the person is looking at, read when it is asked for. */
  placed(): Placed | undefined
}

export interface DoorTool {
  name: ToolName
  where: 'door'
  schema: ToolSchema
  run(call: DoorCall, args: Args): Answer | Promise<Answer>
}

export interface KehikkoTool {
  name: ToolName
  where: 'kehikko'
  schema: ToolSchema
  run(call: KehikkoCall, args: Args): Answer | Promise<Answer>
}

export type Tool = DoorTool | KehikkoTool

export const doorTool = (tool: Omit<DoorTool, 'where'>): DoorTool => ({ ...tool, where: 'door' })
export const kehikkoTool = (tool: Omit<KehikkoTool, 'where'>): KehikkoTool => ({ ...tool, where: 'kehikko' })

/** A tool as `tools/list` lists it: its name, then its schema as written. */
export const listing = (tool: Tool): { name: ToolName } & ToolSchema => ({ name: tool.name, ...tool.schema })
