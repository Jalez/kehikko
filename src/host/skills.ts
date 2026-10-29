import { needSaid, type SkillNeed } from 'kehikot-module-protocol'

import { LOADED_SOMEWHERE } from './providers.ts'

/**
 * The words and the pure parts of the Skills window (protocol 2.5.0), shared by
 * the page (`src/canvas/Skills.tsx`) and the server (`server/skills.ts`).
 */

/**
 * Kehikot's own skills: offered by the host itself, not a module
 * (`server/ownSkills.ts` serves them). Filed under the host's id, which is
 * `HOST_ID` in `server/kehikot.ts`, so the Settings sync, the Skills window and
 * the markers treat them as the host's like any module's are the module's.
 */
export const OWN_SKILLS_MODULE = 'kehikko'

export const OWN_SKILLS = [
  {
    name: 'kehikot-module',
    summary: 'Type /kehikot-module: build a module of your own, from the first question to its first release, step by step.',
  },
  {
    name: 'kehikko-jump',
    summary: 'Lets your agent take you to a project, kehikko, epic, part or step when you ask, marked on the kehikko with Go back.',
  },
] as const

/** Where to read how a module is built: the guide in the protocol's repository. */
export const BUILD_A_MODULE_GUIDE = 'https://github.com/Jalez/kehikko-protocol/blob/main/docs/building-a-module.md'

/**
 * Where one offered skill stands on this machine.
 *
 * - `absent`: not installed.
 * - `installed`: installed by Kehikot from this module, untouched, the module's current text.
 * - `outdated`: installed and untouched, and the module now serves a different text.
 * - `edited`: installed by Kehikot from this module, and changed since by hand. Never overwritten.
 * - `taken`: a skill of that name is there and is not this module's. Never overwritten.
 * - `bound`: kehikko-bound (protocol 2.12.0, `needs`) and not installed for every conversation,
 *   which is where it stays: a module that runs agent sessions and loads skills (protocol 2.21.0,
 *   `declares.agentSessions`) loads it into a conversation whose kehikko meets its needs. Never
 *   installed user-wide.
 * - `agent`: offered by a module that installs skills itself, for the agent it runs (protocol
 *   2.23.0, `declares.agentSessions.installsSkills`): written for that agent, so never installed
 *   in the personal skills folder here. The module keeps it where its agent reads skills.
 */
export type SkillStatus = 'absent' | 'installed' | 'outdated' | 'edited' | 'taken' | 'bound' | 'agent'

export const SKILL_STATUS_SAYS: Record<SkillStatus, string> = {
  absent: 'Not installed',
  installed: 'Installed',
  outdated: 'Outdated',
  edited: 'Changed by you',
  taken: 'Name taken',
  bound: 'On a kehikko only',
  agent: 'Kept by its module',
}

/**
 * Where a skill of a module that installs skills itself (protocol 2.23.0) is, in words: that module
 * keeps it for its own agent, and Kehikot does not install it in the personal skills folder.
 */
export function agentSays(name: string): string {
  return `${name} installs this skill itself, where its own agent reads skills, so Kehikot does not install it in your personal skills folder`
}

/** "A", "A and B", "A, B and C": module names joined for a sentence. */
export function namesSaid(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A module's name when nothing better is known: `kehikot.review` → "Review". */
export function nameFromId(id: string): string {
  const last = id.split('.').pop() || id
  return last.charAt(0).toUpperCase() + last.slice(1)
}

/**
 * Where a kehikko-bound skill works, in the words the Skills window and Settings › Skills show:
 * what it needs — a module by name, or (protocol 2.21.0) a kind of module, "a module that keeps an
 * epic’s steps" — then the one offering it. `nameOf` names a module id.
 */
export function boundSays(own: string, needs: readonly SkillNeed[], nameOf: (id: string) => string): string {
  const names = [...new Set([...needs.filter((need) => need !== own).map((need) => needSaid(need, nameOf)), nameOf(own)])]
  return `Available in conversations on a kehikko that also has ${namesSaid(names)}`
}

/** One row of `GET /host/skills`. */
export interface SkillRow {
  name: string
  summary: string
  /** The module's version of the skill now. */
  version: string
  status: SkillStatus
  says: string
  /** The version the marker recorded, for an installed skill. */
  installedVersion: string | null
  /** The module's current SKILL.md, or null when it could not be read (`unreadable` says why). */
  text: string | null
  sha256: string | null
  unreadable: string | null
  /** The SKILL.md on disk, sent for a diff when it differs from `text` or is not this module's. */
  installedText: string | null
  /** Where it is (or would be) installed. */
  path: string
  /** For `taken`: whose it is. */
  who?: string
  /**
   * For a kehikko-bound skill (`needs`, protocol 2.12.0): where it works, in words
   * (`boundSays`). Such a skill is never installed for every conversation, so a row with
   * this offers no Install and no Update.
   */
  bound?: string
  /**
   * For a kehikko-bound skill: where it is loaded, in words (`loadedWhere` in `providers.ts`) —
   * the modules that run agent sessions and load skills, by name. Absent: said generally.
   */
  loaded?: string
  /**
   * For a skill of a module that installs skills itself (protocol 2.23.0): that it does, in words
   * (`agentSays`). Never installed in the personal skills folder, so a row with this offers no Install and no Update.
   */
  agent?: string
}

/** The one press a row offers, if any. */
export function pressFor(row: Pick<SkillRow, 'status' | 'text' | 'bound' | 'agent'>): 'install' | 'update' | null {
  if (row.bound || row.agent) return null
  if (row.status === 'absent' && row.text !== null) return 'install'
  if (row.status === 'outdated' && row.text !== null) return 'update'
  return null
}

/** Whether a row can be removed: an untouched install of this module's. */
export const removable = (row: Pick<SkillRow, 'status'>) => row.status === 'installed' || row.status === 'outdated'

/** What the row says under the name when nothing can be pressed for it. */
export function whyNot(row: SkillRow): string | null {
  if (row.agent && row.status === 'agent') return `${row.agent}.`
  if (row.bound) {
    if (row.status === 'edited') {
      return `${row.path} is in every conversation, and you changed it, so Kehikot leaves it there. ${row.bound}; to have it only there, move or delete that folder yourself.`
    }
    if (row.status === 'installed' || row.status === 'outdated') {
      return `${row.path} puts it in every conversation. ${row.bound}, so Kehikot removes it from there.`
    }
    return `${row.bound}, ${row.loaded ?? LOADED_SOMEWHERE}, so it is not installed for every conversation.`
  }
  if (row.status === 'edited') {
    return `${row.path} has been changed since it was installed. Kehikot leaves your changes alone: to take the module’s text, move or delete that folder yourself.`
  }
  if (row.status === 'taken') {
    return `${row.path} is ${row.who ?? 'another skill'}. Kehikot will not write over it.`
  }
  if (row.text === null && row.unreadable) return row.unreadable
  return null
}

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

/**
 * A line diff from `before` to `after`, by longest common subsequence. Plain and
 * quadratic: a SKILL.md is at most 64 KB, and this runs when somebody opens one.
 * Beyond `LIMIT` lines on either side it falls back to all-removed, all-added.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const LIMIT = 2000
  if (a.length > LIMIT || b.length > LIMIT) {
    return [...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text }))]
  }
  const n = a.length
  const m = b.length
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: 'removed', text: a[i++]! })
    } else {
      out.push({ kind: 'added', text: b[j++]! })
    }
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++]! })
  while (j < m) out.push({ kind: 'added', text: b[j++]! })
  return out
}

/** What the Frame menu's Skills row says: `null` for a module that offers none. */
export function skillsSaying(skills: readonly { name: string }[] | undefined, name: string): { state: string; hint: string } | null {
  if (!skills || skills.length === 0) return null
  const count = skills.length === 1 ? '1 skill' : `${skills.length} skills`
  return {
    state: `${count} offered`,
    hint: `${name} offers ${count} for your agent. Open this to read them and to install, update or remove them in your agent’s personal skills folder.`,
  }
}

/** Said in the window before and after a press, like the Tools window's sentence. */
export const NEXT_SESSION_SKILLS =
  'A skill applies to agent sessions started after it is installed. In a session that is already running, type /reload-skills to pick it up, or an update to it.'
