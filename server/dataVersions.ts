import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalModuleId, LIMITS, MODULE_ID, moduleFile } from 'kehikot-module-protocol'

import { HOST_ID } from './kehikot.ts'

/**
 * The data guard: which format each module's data in a project has been written in.
 *
 * ## Why the host keeps this
 *
 * A module keeps its data under `<project>/.kehikot/<module>/`, and every
 * version of that module running against the project shares it — that is the
 * decision on issue #30, "data stays shared". A newer release may migrate those
 * files into a format an older release cannot read, and an older release
 * reading them anyway does not fail loudly: it misreads, and then it writes
 * back what it misread.
 *
 * So each module declares `dataVersion` in its manifest (the protocol's
 * `manifest.ts`; absent means 1), and the host records, per project and
 * module, the highest one it has framed there. A version declaring a LOWER
 * number is refused for that project, with the sentence `refusal` writes.
 *
 * ## Where
 *
 * `<project>/.kehikot/kehikko/data-versions.json`, beside the host's
 * `kehikot.json`: it is a fact about the project's data, so it travels with
 * the project, and a clone of the project on another machine refuses the same
 * downgrade. One object, module id to integer.
 *
 * ## What it is not
 *
 * Not a lock and not a migration. It never lowers a number — a person who
 * really wants to go back restores their data and deletes the line, which is a
 * decision this host should not make for them.
 */

const FILE_NAME = 'data-versions'

export type DataVersions = Record<string, number>

export function dataVersionsFile(projectPath: string): string | null {
  return moduleFile(projectPath, HOST_ID, FILE_NAME)
}

/** What the project's file says, keeping only entries that are a module id and a positive integer. */
export function readDataVersions(projectPath: string): DataVersions {
  const file = dataVersionsFile(projectPath)
  if (!file) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  const out: DataVersions = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!MODULE_ID.test(id)) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > LIMITS.DATA_VERSION) continue
    out[canonicalModuleId(id)] = value
  }
  return out
}

/**
 * Note that `module` ran here with data format `dataVersion`. Only ever raises
 * the number. Returns whether the file changed.
 */
export function recordDataVersion(projectPath: string, module: string, dataVersion: number): boolean {
  if (!Number.isInteger(dataVersion) || dataVersion < 1 || dataVersion > LIMITS.DATA_VERSION) return false
  const file = dataVersionsFile(projectPath)
  if (!file) return false
  const now = readDataVersions(projectPath)
  const id = canonicalModuleId(module)
  if (Object.hasOwn(now, id) && now[id]! >= dataVersion) return false
  now[id] = dataVersion
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(now, null, 2)}\n`)
  renameSync(tmp, file)
  return true
}

/** The highest format recorded for a module in a project, or null when none has run there. */
export function recordedFor(versions: DataVersions, module: string): number | null {
  const id = canonicalModuleId(module)
  return Object.hasOwn(versions, id) ? versions[id]! : null
}

/**
 * Why a version may not run against this project's data, or null when it may.
 *
 * `candidate` null means the version's format is not known yet — it has not
 * been prepared and its manifest could not be read. That is not a refusal:
 * the host finds out when it prepares the version, and refuses then, before
 * any container is pointed at it.
 */
export function refusal(
  name: string,
  tag: string,
  candidate: number | null,
  recorded: number | null,
): string | null {
  if (candidate === null || recorded === null || candidate >= recorded) return null
  return (
    `${name} ${tag} writes its data in format ${candidate}, and this project's ${name} data has already been `
    + `written in format ${recorded} by a newer version. ${tag} might misread it and write it back wrong, so it `
    + `is not run here. (Recorded in .kehikot/kehikko/data-versions.json.)`
  )
}
