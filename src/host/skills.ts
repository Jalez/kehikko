/**
 * The words and the pure parts of the Skills window (protocol 2.5.0), shared by
 * the page (`src/canvas/Skills.tsx`) and the server (`server/skills.ts`).
 */

/**
 * Where one offered skill stands on this machine.
 *
 * - `absent`: not installed.
 * - `installed`: installed by Kehikot from this module, untouched, the module's current text.
 * - `outdated`: installed and untouched, and the module now serves a different text.
 * - `edited`: installed by Kehikot from this module, and changed since by hand. Never overwritten.
 * - `taken`: a skill of that name is there and is not this module's. Never overwritten.
 */
export type SkillStatus = 'absent' | 'installed' | 'outdated' | 'edited' | 'taken'

export const SKILL_STATUS_SAYS: Record<SkillStatus, string> = {
  absent: 'Not installed',
  installed: 'Installed',
  outdated: 'Outdated',
  edited: 'Changed by you',
  taken: 'Name taken',
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
}

/** The one press a row offers, if any. */
export function pressFor(row: Pick<SkillRow, 'status' | 'text'>): 'install' | 'update' | null {
  if (row.status === 'absent' && row.text !== null) return 'install'
  if (row.status === 'outdated' && row.text !== null) return 'update'
  return null
}

/** Whether a row can be removed: an untouched install of this module's. */
export const removable = (row: Pick<SkillRow, 'status'>) => row.status === 'installed' || row.status === 'outdated'

/** What the row says under the name when nothing can be pressed for it. */
export function whyNot(row: SkillRow): string | null {
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
    hint: `${name} offers ${count} for Claude Code. Open this to read them and to install, update or remove them in your own Claude Code.`,
  }
}

/** Said in the window before and after a press, like the Tools window's sentence. */
export const NEXT_SESSION_SKILLS =
  'A skill applies to Claude Code sessions started after it is installed. A session that is already running will not see it, or an update to it.'
