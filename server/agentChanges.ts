import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_CHANGES_MOST, agentChangesFrom, forAgentsOf, type AgentChange, type HostChanges } from 'kehikot-module-protocol'

import hostNotes from '../FOR_AGENTS.md' with { type: 'text' }

/**
 * What changed for agent sessions in what runs here (protocol 2.61.0), for the notes a session is
 * told at its next prompt after an update (`changedSince` in the protocol). Read, never asked of the
 * network:
 *
 *  - **A module**: the copy it runs from (its registration's folder). Its `package.json` version, and
 *    the "For agents" section of each `notes/<version>.md` up to it (`agentChangesFrom`). Kept per
 *    folder until `package.json` or `notes/` changes, which is what an update does.
 *  - **Kehikot itself**: `FOR_AGENTS.md` at the root of this repository, bundled with the host. Each
 *    change is a `## <n>` heading over one or two bullets, newest first, numbered in their own
 *    sequence (a host does not know which app it is in); `n` is said to the protocol as `n.0.0`.
 */

export interface CopyChanges {
  /** The version the copy runs, or null when its `package.json` does not say one. */
  version: string | null
  /** Its releases' lines for agents, newest first. */
  changes: AgentChange[]
}

const NONE: CopyChanges = { version: null, changes: [] }
const VERSION = /^\d+\.\d+\.\d+$/
const kept = new Map<string, { stamp: string; read: CopyChanges }>()

const mtime = (path: string): number => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** The version and lines for agents of the copy in `dir`. Never throws; a folder with neither is `NONE`. */
export function changesOfCopy(dir: string | null | undefined): CopyChanges {
  if (!dir) return NONE
  const stamp = `${mtime(join(dir, 'package.json'))}:${mtime(join(dir, 'notes'))}`
  const was = kept.get(dir)
  if (was && was.stamp === stamp) return was.read
  const read = readCopy(dir)
  kept.set(dir, { stamp, read })
  return read
}

function readCopy(dir: string): CopyChanges {
  let version: string | null = null
  try {
    const said = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version
    version = typeof said === 'string' && VERSION.test(said.trim()) ? said.trim() : null
  } catch {
    return NONE
  }
  if (!version) return NONE
  let files: string[] = []
  try {
    files = readdirSync(join(dir, 'notes')).filter((name) => /^v?\d+\.\d+\.\d+\.md$/.test(name))
  } catch {
    return { version, changes: [] }
  }
  const notes: { file: string; text: string }[] = []
  for (const file of files) {
    try {
      notes.push({ file, text: readFileSync(join(dir, 'notes', file), 'utf8') })
    } catch {
      /* One that cannot be read says nothing. */
    }
  }
  return { version, changes: agentChangesFrom(notes, version) }
}

/**
 * Kehikot's own changes for agents, from `FOR_AGENTS.md`'s text: the newest number as the version,
 * and the most recent changes. Null when it holds none.
 */
export function hostChanges(text: string = hostNotes): HostChanges | null {
  const changes: AgentChange[] = []
  let newest = 0
  const sections = text.replace(/\r\n?/g, '\n').split(/^##[ \t]+/m).slice(1)
  for (const section of sections) {
    const head = /^(\d{1,6})[ \t]*\n/.exec(section)
    if (!head) continue
    const n = Number(head[1])
    if (!(n > 0)) continue
    newest = Math.max(newest, n)
    const lines = forAgentsOf(`## For agents\n${section.slice(head[0].length)}`)
    if (lines.length) changes.push({ version: `${n}.0.0`, lines })
  }
  if (!newest) return null
  changes.sort((a, b) => Number.parseInt(b.version, 10) - Number.parseInt(a.version, 10))
  return { version: `${newest}.0.0`, changes: changes.slice(0, AGENT_CHANGES_MOST.releases) }
}
