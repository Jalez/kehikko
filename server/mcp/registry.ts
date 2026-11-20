import { listing, type Tool, type ToolSchema } from './tool.ts'
import { arrangeModules } from './tools/arrangeModules.ts'
import { createKehikko } from './tools/createKehikko.ts'
import { createEpicTool, editSpace, setParts } from './tools/editSpace.ts'
import { foldModules } from './tools/foldModules.ts'
import { jump, offerJump } from './tools/jump.ts'
import { kehikkoSkills } from './tools/kehikkoSkills.ts'
import { markDisposition } from './tools/markDisposition.ts'
import { messageTools } from './tools/messages.ts'
import { moduleSettings } from './tools/moduleSettings.ts'
import { myPlaceTool, setMyPlaceTool } from './tools/myPlace.ts'
import { openAddress } from './tools/openAddress.ts'
import { placeModules } from './tools/placeModules.ts'
import { pressItem } from './tools/pressItem.ts'
import { proposeAdoption } from './tools/proposeAdoption.ts'
import { readCanvas } from './tools/readCanvas.ts'
import { readInbox } from './tools/readInbox.ts'
import { readLogsTool } from './tools/readLogs.ts'
import { selectModules } from './tools/selectModules.ts'
import { storage } from './tools/storage.ts'
import { readTracker, setTrackerSource } from './tools/tracker.ts'
import { moduleVersions, pinVersion } from './tools/versions.ts'

/**
 * Every tool of the host's door, each in a module of its own under `tools/` (one per tool or per small
 * group) that says its name, what `tools/list` says of it, and what answers a call.
 *
 * The order is the order `tools/list` gives them in, which agents have always been given; a new tool
 * goes where it reads best, and `test/fixtures/mcp-tool-list.json` changes with it.
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
  pressItem,
  jump,
  offerJump,
  openAddress,
  selectModules,
  placeModules,
  createKehikko,
  editSpace,
  createEpicTool,
  setParts,
  markDisposition,
  proposeAdoption,
  readTracker,
  setTrackerSource,
  moduleVersions,
  pinVersion,
  foldModules,
  arrangeModules,
  /* Messages between agent sessions (protocol 2.95.0): here, for every conversation. `doorMessages.ts`. */
  ...messageTools,
]

const BY_NAME: ReadonlyMap<string, Tool> = new Map(REGISTERED.map((tool) => [tool.name, tool]))

/** The tool of that name, if this door has one. */
export function registered(name: string): Tool | undefined {
  return BY_NAME.get(name)
}

/** Every tool as `tools/list` lists it, in order. */
export function toolList(): ({ name: string } & ToolSchema)[] {
  return REGISTERED.map(listing)
}
