import { JOURNEYS_MODULE, loadsSkills, providesOf, type ProvidingManifest } from 'kehikot-module-protocol'

/**
 * What a module provides, and whether it loads skills into the agent sessions it runs, as this host
 * reads a manifest (protocol 2.21.0). Pure, shared by the server and the page.
 *
 * A manifest says both itself (`declares.provides`, `declares.agentSessions.loadsSkills`), and this
 * host routes by what is said, never by a module's id. Two modules did both before there was a way to
 * say so, and each is read as saying it while its manifest is from before 2.21.0 and says nothing:
 *
 * - **Journeys** provides an epic's steps: this host reads its old file as a steps provider until it
 *   publishes a `steps.json` (`server/plans.ts`).
 * - **Claude** runs agent sessions and loads the kehikko-bound skills into them.
 *
 * Both go when those modules declare it themselves, and from the table in protocol 3.0. Nothing else
 * may be added to `BEFORE_2_21`: a module of today says what it does.
 */

/** A manifest as these readers look at it: what `missingNeeds` reads, and the protocol package it was built with. */
export interface ReadManifest extends ProvidingManifest {
  build?: { protocol?: string } | null
}

/** The claude module's id: the one that loaded skills before a module could say it does. */
export const SESSIONS_BEFORE_2_21 = 'kehikot.claude'

const BEFORE_2_21: Record<string, { provides?: readonly string[]; loadsSkills?: true }> = {
  [JOURNEYS_MODULE]: { provides: ['steps'] },
  [SESSIONS_BEFORE_2_21]: { loadsSkills: true },
}

/** Whether a manifest was built with a protocol package before 2.21.0, or does not say. */
export function builtBefore221(manifest: Pick<ReadManifest, 'build'>): boolean {
  const version = /^(\d+)\.(\d+)\./.exec(manifest.build?.protocol ?? '')
  if (!version) return true
  const [major, minor] = [Number(version[1]), Number(version[2])]
  return major < 2 || (major === 2 && minor < 21)
}

/** The table's entry for a module that predates 2.21.0, or null. */
function before(manifest: ReadManifest) {
  return Object.hasOwn(BEFORE_2_21, manifest.id) && builtBefore221(manifest) ? BEFORE_2_21[manifest.id]! : null
}

/** What a module provides: what its manifest says, or — for the two modules above, saying nothing from before 2.21.0 — what they did. */
export function providesHere(manifest: ReadManifest): readonly string[] {
  const said = providesOf(manifest)
  if (said.length || manifest.declares?.provides !== undefined) return said
  return before(manifest)?.provides ?? []
}

/** Whether a module loads skills into the agent sessions it runs, read the same way. */
export function loadsSkillsHere(manifest: ReadManifest): boolean {
  if (loadsSkills(manifest)) return true
  if (manifest.declares?.agentSessions !== undefined && manifest.declares?.agentSessions !== null) return false
  return before(manifest)?.loadsSkills === true
}

/** A manifest with what it provides filled in as `providesHere` reads it: what `missingNeeds` is given. */
export function asRead(manifest: ReadManifest): ReadManifest {
  const provides = providesHere(manifest)
  return { ...manifest, declares: { ...(manifest.declares ?? {}), provides } }
}

/** The modules among these that load skills into their agent sessions, in order. */
export function skillLoaders(manifests: readonly ReadManifest[]): string[] {
  return manifests.filter(loadsSkillsHere).map((manifest) => manifest.id)
}

/** "Claude", "Claude or Codex", "Claude, Codex or Pi". */
function orSaid(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
}

/** Where a kehikko-bound skill is loaded, said without knowing which modules are installed. */
export const LOADED_SOMEWHERE = 'where a module that runs agent sessions loads it'

/**
 * Where a kehikko-bound skill is loaded, in words that follow `boundSays`: "where Claude loads it",
 * or, with no module that loads skills installed, that none does yet.
 */
export function loadedWhere(loaderNames: readonly string[]): string {
  return loaderNames.length
    ? `where ${orSaid(loaderNames)} loads it`
    : 'where a module that runs agent sessions loads it; none installed here does yet'
}
