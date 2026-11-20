import type { Database } from 'bun:sqlite'
import { AGENT_SETUP_CARRIED_PATH, LIMITS, SETTINGS_PASS_PATH } from 'kehikot-module-protocol'

import { carriedValues, isSetupKey, refreshChoice, type SetupDeps } from './agentSetup.ts'
import type { moduleSettingsDesk } from './moduleSettings.ts'
import type { PersonGrants } from './personGrants.ts'
import { projectById } from './projects.ts'
import { json, moduleIn, routes, type Desk, type RouteTable } from './routes.ts'
import type { storageDesk } from './storage.ts'

/**
 * The storage overview and a module's settings:
 *
 *  - `POST /host/storage` — every project's `.kehikot/` and this machine's data. The page's alone.
 *  - `POST /host/module-settings`, `/list`, `/file`, `/set` — a module's settings. The page's alone.
 *  - `GET  SETTINGS_PASS_PATH` — whether a pass is one this host minted, for a module's server.
 *  - `GET  AGENT_SETUP_CARRIED_PATH` — the agent setup choice this host once held, for the agent module.
 */
export const SETTINGS_ROUTES = {
  storage: { method: 'POST', path: '/host/storage', pageOnly: true },
  settings: { method: 'POST', path: '/host/module-settings', pageOnly: true },
  settingsList: { method: 'POST', path: '/host/module-settings/list', pageOnly: true },
  settingsFile: { method: 'POST', path: '/host/module-settings/file', pageOnly: true },
  settingsSet: { method: 'POST', path: '/host/module-settings/set', pageOnly: true },
  settingsPass: { method: 'GET', path: SETTINGS_PASS_PATH },
  setupCarried: { method: 'GET', path: AGENT_SETUP_CARRIED_PATH },
} as const satisfies RouteTable

export interface SettingsRouteDeps {
  db: Database
  storage: Pick<ReturnType<typeof storageDesk>, 'read'>
  /** Every module this host sees, as the settings list shows it. */
  settingsListed(): Promise<unknown>
  moduleSettings: Pick<ReturnType<typeof moduleSettingsDesk>, 'read' | 'file' | 'set' | 'vouch'>
  personGrants: Pick<PersonGrants, 'saw'>
  /** What the agent setup choice is read with (`agentSetup.ts`). */
  setupDeps: SetupDeps
  agentSync: { poke(): void }
}

export function settingsRouteDesk(deps: SettingsRouteDeps): Desk {
  const { db, storage, settingsListed, moduleSettings, personGrants, setupDeps, agentSync } = deps

  /*
   * A module's settings (protocol 2.15.0). Every one of these is the page's alone (`PAGE_ONLY`):
   * the list and the read so the page draws the form, the change because it is the one place a
   * person's PASS is minted (`moduleSettings.ts`), and the file because it shows a project's file.
   * An agent reads settings through the door's `module_settings`, and changes one only at the
   * module's own door — never here. `project` is a project's id, resolved out of this host's table.
   *
   * Asked for every POST under `/host/module-settings`, as it always was: a path that names none of
   * the four is still read for a module and a project, and is then left to the routes after it.
   */
  async function moduleSettingsAnswer(request: Request, url: URL): Promise<Response | null> {
    const body = ((await request.json().catch(() => null)) ?? {}) as { module?: unknown; project?: unknown; key?: unknown; value?: unknown }
    const project = typeof body.project === 'number' ? projectById(db, body.project) : null
    if (url.pathname === '/host/module-settings/list') {
      return json({ ok: true, modules: await settingsListed() })
    }
    const module = moduleIn(body.module)
    if (!module) return json({ ok: false, why: 'Which module.' }, 400)
    if (body.project !== undefined && body.project !== null && !project) return json({ ok: false, why: 'There is no project with that id.' }, 404)
    const path = project?.path ?? null
    if (url.pathname === '/host/module-settings') return json(await moduleSettings.read(module, path))
    if (url.pathname === '/host/module-settings/file') return json(await moduleSettings.file(module, path))
    if (url.pathname === '/host/module-settings/set') {
      if (typeof body.key !== 'string' || body.key.length > LIMITS.SETTING_KEY) return json({ ok: false, why: 'Which setting.' }, 400)
      const changed = await moduleSettings.set(module, path, body.key, body.value)
      /* The person's change, relayed from this page and saved by the module:
         the one way a grant to send messages as them is recorded (protocol
         2.50.0, `personGrants.ts`). */
      if ('outcome' in changed && changed.outcome === 'saved') personGrants.saw(module, body.key, body.value)
      /* The agent setup choice is the agent module's own setting (`agentSetup.ts`): the sync reads it again. */
      if ('outcome' in changed && changed.outcome === 'saved' && isSetupKey(body.key)) {
        await refreshChoice(setupDeps).catch(() => null)
        agentSync.poke()
      }
      return json(changed)
    }
    return null
  }

  const table = routes(SETTINGS_ROUTES, {
    /*
     * The storage overview, for the page's Storage view: every project's
     * `.kehikot/` by module, and this machine's Kehikot data. The page's alone
     * (`PAGE_ONLY`) — a POST so that rule can hold it; it changes nothing.
     * `fresh: true` measures again rather than answering from the last few
     * seconds' report.
     */
    storage: async (request) => {
      const body = (await request.json().catch(() => null)) as { fresh?: unknown } | null
      return json(await storage.read(body?.fresh === true))
    },

    settings: moduleSettingsAnswer,
    settingsList: moduleSettingsAnswer,
    settingsFile: moduleSettingsAnswer,
    settingsSet: moduleSettingsAnswer,

    /*
     * Whether a pass is one this host minted for a person's change of a module's setting, asked by
     * that module's server (`SETTINGS_PASS_PATH`, protocol 2.15.0). Answered to programs on this
     * machine, like `/host/is-project`; the answer spends the pass.
     */
    settingsPass: (_request, url) => json(moduleSettings.vouch(url.searchParams)),

    /*
     * The agent setup choice this host held itself before protocol 2.91.0, as settings values, for the
     * agent module that holds it now to carry over once (`AGENT_SETUP_CARRIED_PATH`, `agentSetup.ts`).
     * Answered to programs on this machine, like the pass above; read only.
     */
    setupCarried: () => json({ ok: true, values: carriedValues(db) }),
  })

  return {
    async route(request, url) {
      const answered = await table.route(request, url)
      if (answered) return answered
      if (url.pathname.startsWith('/host/module-settings') && request.method === 'POST') return moduleSettingsAnswer(request, url)
      return null
    },
  }
}
