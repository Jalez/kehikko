import { LIMITS, MODULE_ID, PACKAGE_VERSION } from 'kehikot-module-protocol'
import { z } from 'zod'

import listed from '../modules.json'

/**
 * The official module list: the modules this host vouches for.
 *
 * ## What it is, and what it changes
 *
 * `modules.json`, in this repository. A host used to know only what somebody
 * had registered on their own machine, so a module that was not on the machine
 * could not be found from the app at all: a person had to know its repository
 * existed, clone it, install it, register it and reload. The list is the one
 * place that says which modules are first-party and maintained, and
 * `installs.ts` is what turns an entry into a registered module without a
 * terminal.
 *
 * ## Where a host gets it
 *
 * Two places, merged. The copy imported here is the list this host was BUILT
 * with, so the host compiled into the desktop app always has one, offline and
 * on its first start. The CURRENT list is the same file as published on this
 * repository's `main`, read at run time by `officialSource.ts` — which is what
 * lets a module be published for an app that is already released. That file
 * has the merge rule, the cache, when it asks, and who is trusted.
 *
 * ## What an entry is not
 *
 * Not a manifest and not a registration. A module still describes itself, and
 * what it says when it answers wins over what is written here. The `summary`
 * and `tags` are the host's own words for a module that is not on the machine
 * to ask; `port` is where it is first registered, which its own start script
 * moves if the port is taken.
 */

/** `owner/repo` of this host: where the published list is read from, and where proposals and feedback on the host go. */
export const HOST_REPO = 'Jalez/kehikko'

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
  /* The oldest protocol PACKAGE the module can be run by, `major.minor.patch`.
     Optional, so every entry written before it stays valid. It is a string and
     not a pattern on purpose: a requirement written in a way this host cannot
     read must not fail the whole list — it is a requirement this host does not
     meet (`meetsProtocol`). */
  protocol: z.string().min(1).max(32).optional(),
  /* The icon the module is drawn with before it has answered here (protocol
     2.14.0): a key of `MODULE_ICONS`, which the module's own manifest should
     declare too and which wins over this. Optional, and a value this host
     cannot use is dropped rather than failing the list (`moduleIconFor` draws
     only a key it knows). Held unique across the list by a test. */
  icon: z.string().max(64).optional().catch(undefined),
  /* What the module's manifest reacts to, for the one thing a host needs it for before the module has
     ever answered here: `address` means it shows pages, so an address handed to a kehikko waits for it
     while it starts. Its own manifest wins once it answers. Optional; a value this host cannot read is
     dropped rather than failing the list. */
  reacts: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).max(16).optional().catch(undefined),
})
/* `z.object` drops keys it does not know, so a field a later list adds is
   ignored by this host rather than refusing the list. Held by a test. */

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

/* The list this host was built with. Parsed where it is imported, so a list
   no host can use fails the start rather than the first press of Install. */
export const OFFICIAL: readonly Official[] = readOfficial(listed)

function triple(version: string): [number, number, number] | null {
  const match = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * Whether this host can run a module whose entry asks for `need`.
 *
 * No requirement is met by every host. One this host cannot read — a range, a
 * pre-release, whatever a later list writes — is NOT met: the entry is saying
 * something about what it needs, and guessing "fine" would install a module
 * this host then refuses.
 */
export function meetsProtocol(need: string | undefined, have: string = PACKAGE_VERSION): boolean {
  if (need === undefined) return true
  const wanted = triple(need)
  const got = triple(have)
  if (!wanted || !got) return false
  for (let i = 0; i < 3; i++) {
    if (got[i]! !== wanted[i]!) return got[i]! > wanted[i]!
  }
  return true
}

/** The entry for a module id, in either spelling of it, or null when it is not on the list. */
export function officialOf(id: string, list: readonly Official[] = OFFICIAL): Official | null {
  const canonical = id
  return list.find((entry) => entry.id === canonical) ?? null
}
