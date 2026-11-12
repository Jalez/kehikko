import type { Database } from 'bun:sqlite'

import { AGENT_SETUP_KEYS, agentSetupChoice, agentSetupSchema, agentSetupValues } from 'kehikot-module-protocol'

import { carriedChoice, choiceSettings, type SetupHolder } from '../src/host/agentSettings.ts'
import { readSettings, writeSettings } from './agentSettings.ts'

/**
 * Whose choice the sync acts on (protocol 2.91.0, `agent.setup`): the agent module that sets up the
 * program this host's writers write for. The module owns the choice — four `machine` settings of its
 * own (`AGENT_SETUP_KEYS`) — and this file reads it at the module's settings door into the copy in
 * `frame.sqlite` (`readSettings`), which the sync acts on, also while the module sleeps. The host never
 * writes the module's settings: a change is the person's press in a form, through the one route that
 * mints a person's pass (`/host/module-settings/set`).
 *
 * ## Carrying an earlier choice over
 *
 * Before 2.91.0 the host held the choice itself, in that same row. The module asks for it once, before
 * it has a choice of its own (`AGENT_SETUP_CARRIED_PATH`, answered by `carriedValues`), and keeps it as
 * its own: on only where the sync acted on its own (`carriedChoice`). A module that could not carry it
 * over says so (`problem` in `settings.get`), and then nothing is read from it: its defaults (off)
 * never replace what the person chose. With no holder answering, the row stands as it is.
 *
 * ## The one-time question
 *
 * Gone: an answer given is carried over (above), and an unanswered one was "nothing automatic", which
 * is the module's default. The person turns it on in the module's settings.
 */

/**
 * The command whose user-wide configuration this host's writers set up (`register.ts` runs it, and
 * `skills.ts` writes its skills folder). A holder whose descriptor names another command is not one
 * this host can act for.
 */
export const WRITES_FOR = 'claude'

export interface HolderSeen {
  module: string
  /** Its registered name. */
  name: string
  descriptor: unknown
}

export interface SetupDeps {
  db: Database
  /** The modules answering now that provide `agent.setup`, with their descriptors. */
  providers(): readonly HolderSeen[]
  /** `settings.get` at a module's door, for no project; `problem` when it could not read its own. */
  read(module: string): Promise<{ ok: true; values: Record<string, unknown>; problem?: string | null } | { ok: false; why: string }>
}

/** The holder this host acts for: the first answering provider whose descriptor parses and names `WRITES_FOR`. */
export function holderOf(providers: readonly HolderSeen[]): SetupHolder | null {
  for (const one of providers) {
    const read = agentSetupSchema.safeParse(one.descriptor)
    if (read.success && read.data.cli === WRITES_FOR) return { module: one.module, name: one.name || read.data.name, program: read.data.program }
  }
  return null
}

/**
 * The holder's choice into the stored copy. `kept`: no holder answered, or it could not read its own
 * choice, and the copy stands; `read`: the copy is the module's.
 */
export async function refreshChoice(deps: SetupDeps): Promise<'kept' | 'read'> {
  const holder = holderOf(deps.providers())
  if (!holder) return 'kept'
  const read = await deps.read(holder.module)
  if (!read.ok || read.problem) return 'kept'
  writeSettings(deps.db, choiceSettings(agentSetupChoice(read.values)))
  return 'read'
}

/** What `AGENT_SETUP_CARRIED_PATH` answers: the copy's meaning, as the module's settings values. */
export function carriedValues(db: Database): Record<string, boolean | string[]> {
  return agentSetupValues(carriedChoice(readSettings(db)))
}

/** Whether a setting is one of the choice's, so a change to it is a reason to run the sync. */
export function isSetupKey(key: unknown): boolean {
  return typeof key === 'string' && (Object.values(AGENT_SETUP_KEYS) as string[]).includes(key)
}
