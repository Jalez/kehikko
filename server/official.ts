import { canonicalModuleId, LIMITS, MODULE_ID } from 'kehikot-module-protocol'
import { z } from 'zod'

import listed from '../modules.json'

/**
 * The official module list: the modules this release of the host vouches for.
 *
 * ## What it is, and what it changes
 *
 * `modules.json`, in this repository, versioned with the host. A host used to
 * know only what somebody had registered on their own machine, so a module
 * that was not on the machine could not be found from the app at all: a person
 * had to know its repository existed, clone it, install it, register it and
 * reload. The list is the one place that says which modules are first-party
 * and maintained, and `installs.ts` is what turns an entry into a registered
 * module without a terminal.
 *
 * It is imported rather than read at run time, so the host compiled into the
 * desktop app carries the list it was built with.
 *
 * ## What an entry is not
 *
 * Not a manifest and not a registration. A module still describes itself, and
 * what it says when it answers wins over what is written here. The `summary`
 * and `tags` are the host's own words for a module that is not on the machine
 * to ask; `port` is where it is first registered, which its own start script
 * moves if the port is taken.
 */

/* `owner/name` on GitHub, and nothing that could be read as a path or a flag. */
const repo = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/)

const entrySchema = z.object({
  /* The id names a directory when the module is installed, so one that starts
     with a dot is refused as well as one that is not a module id. */
  id: z.string().regex(MODULE_ID).refine((id) => !id.startsWith('.')),
  name: z.string().min(1).max(LIMITS.NAME),
  repo,
  port: z.number().int().min(1024).max(65535),
  summary: z.string().max(LIMITS.SUMMARY),
  tags: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,23}$/)).max(5),
})

export type Official = z.infer<typeof entrySchema>

/** Read a list, refusing a duplicate id: two entries for one module is two answers to "where is it". */
export function readOfficial(raw: unknown): Official[] {
  const entries = z.object({ modules: z.array(entrySchema) }).parse(raw).modules
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`modules.json lists ${entry.id} twice`)
    seen.add(entry.id)
  }
  return entries
}

/* Parsed where it is imported, so a list no host can use fails the start
   rather than the first press of Install. */
export const OFFICIAL: readonly Official[] = readOfficial(listed)

/** The entry for a module id, in either spelling of it, or null when it is not on the list. */
export function officialOf(id: string, list: readonly Official[] = OFFICIAL): Official | null {
  const canonical = canonicalModuleId(id)
  return list.find((entry) => entry.id === canonical) ?? null
}
