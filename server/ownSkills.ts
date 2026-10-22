import { createHash } from 'node:crypto'

import { skillPath, skillTextIssue, type ModuleSkill } from 'kehikot-module-protocol'

import kehikotModule from '../skills/kehikot-module/SKILL.md' with { type: 'text' }
import { OWN_SKILLS, OWN_SKILLS_MODULE } from '../src/host/skills.ts'

/**
 * Kehikot's own skills: Claude Code skills the HOST offers, not a module.
 *
 * Each is one file, `skills/<name>/SKILL.md` in this repository, imported as
 * text so the bundled app carries it. They are declared and served the way a
 * module's are (protocol 2.5.0): `declares`-shaped entries for the host's row
 * in the Settings sync (`seenOf` in server.ts), and the text at
 * `skillPath(name)` on this host's own origin, which is where `fetchSkillText`
 * reads it from. So installing, updating, keeping and leaving an edited copy
 * alone all go through `syncSkill` and its rules, unchanged.
 *
 * The text names no origin: a development host and the app share the person's
 * skills folder, and the same text from both never fights over one install.
 * The version is the first twelve hex digits of the text's sha256.
 */

const TEXTS: Readonly<Record<string, string>> = { 'kehikot-module': kehikotModule }

const sha12 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)

/** What the host declares: each skill's name, summary and version. */
export function ownSkillDeclarations(): ModuleSkill[] {
  return OWN_SKILLS.map((one) => ({ name: one.name, summary: one.summary, version: sha12(TEXTS[one.name]!) }))
}

/** The text a path asks for, or null for a path that is not one of the host's skills. */
export function ownSkillAt(pathname: string): string | null {
  for (const one of OWN_SKILLS) {
    if (skillPath(one.name) !== pathname) continue
    const text = TEXTS[one.name]
    return text !== undefined && skillTextIssue(text, one.name) === null ? text : null
  }
  return null
}

/**
 * The registry as the Settings sync's tidying reads it, with the host in it:
 * the host is never "no longer registered", so its own skills are never
 * removed as a gone module's would be (`tidySkills`). Null stays null: nothing
 * is tidied when the registry could not be read.
 */
export function withHost(registry: ReadonlySet<string> | null): ReadonlySet<string> | null {
  return registry ? new Set([...registry, OWN_SKILLS_MODULE]) : null
}
