import { AGENT_ROUTES } from './agentRoutes.ts'
import { AGENT_SETTINGS_ROUTES } from './agentSettings.ts'
import { ANYWAY_ROUTES } from './anyway.ts'
import { ARRANGING_ROUTES } from './arranging.ts'
import { CALL_ROUTES } from './callRoutes.ts'
import { CANVAS_ROUTES } from './canvasRoutes.ts'
import { SOUND_ROUTES } from './chime.ts'
import { DEVELOPMENT_ROUTES } from './developmentRoutes.ts'
import { HEADER_ROUTES } from './headers.ts'
import { HOST_ROUTES } from './hostRoutes.ts'
import { INBOX_ROUTES } from './inboxRoutes.ts'
import { KEHIKKO_ROUTES } from './kehikkoRoutes.ts'
import { LOG_ROUTES } from './logRoutes.ts'
import { MCP_ROUTES } from './mcpRoutes.ts'
import { MESSAGE_ROUTES } from './messageRoutes.ts'
import { MODULE_ROUTES } from './moduleRoutes.ts'
import { MINE_ROUTES } from './myModules.ts'
import { PERSON_ROUTES } from './personRoutes.ts'
import { VISIT_ROUTES } from './pickerOrder.ts'
import { PROJECT_ROUTES } from './projectRoutes.ts'
import { RESTART_MODULE_ROUTES } from './restartModule.ts'
import { RESTART_ROUTES } from './restartRoutes.ts'
import type { RouteTable } from './routes.ts'
import { SERVER_ASK_ROUTES } from './serverAsk.ts'
import { SETTINGS_ROUTES } from './settingsRoutes.ts'
import { SKILL_ROUTES } from './skills.ts'
import { SPACE_ROUTES } from './spaceRoutes.ts'
import { STOP_MODULE_ROUTES } from './stopModule.ts'
import { TRACKER_ROUTES } from './trackerRoutes.ts'
import { UPDATE_ROUTES } from './updateRoutes.ts'

/**
 * Every desk's route table (`routes.ts`), by name: what each desk matches a request on. `PAGE_ONLY`
 * in `guard.ts` is built from the routes these declare `pageOnly` (and from `ADOPT_ROUTES`, the
 * adopt desk's own list of the paths it takes), so a desk that adds a route says here, on the route,
 * whether only this host's page may write to it.
 */
export const ROUTE_TABLES: Readonly<Record<string, RouteTable>> = {
  AGENT_ROUTES,
  AGENT_SETTINGS_ROUTES,
  ANYWAY_ROUTES,
  ARRANGING_ROUTES,
  CALL_ROUTES,
  CANVAS_ROUTES,
  DEVELOPMENT_ROUTES,
  HEADER_ROUTES,
  HOST_ROUTES,
  INBOX_ROUTES,
  KEHIKKO_ROUTES,
  LOG_ROUTES,
  MCP_ROUTES,
  MESSAGE_ROUTES,
  MINE_ROUTES,
  MODULE_ROUTES,
  PERSON_ROUTES,
  PROJECT_ROUTES,
  RESTART_MODULE_ROUTES,
  RESTART_ROUTES,
  SERVER_ASK_ROUTES,
  SETTINGS_ROUTES,
  SKILL_ROUTES,
  SOUND_ROUTES,
  SPACE_ROUTES,
  STOP_MODULE_ROUTES,
  TRACKER_ROUTES,
  UPDATE_ROUTES,
  VISIT_ROUTES,
}
