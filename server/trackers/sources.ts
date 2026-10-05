import { readFileSync } from 'node:fs'
import { LIMITS, TRACKERS, moduleFile, readTrackerRef, type Tracker } from 'kehikot-module-protocol'
import { z } from 'zod'

import type { Runner } from '../feedback.ts'
import { HOST_ID } from '../kehikot.ts'

/**
 * Which places a project's trackers are read from.
 *
 * ## Defaulting from the remotes, and the file that says otherwise
 *
 * A project with a GitHub `origin` reads that repository, and nobody should
 * have to write that down. So the sources start as the project's git remotes —
 * `origin` first — each on a host this can tell is GitHub or GitLab.
 *
 * What the remotes cannot say is written in `<project>/.kehikot/kehikko/trackers.json`,
 * beside `kehikot.json`, spelled with `moduleFile` like everything else this
 * host keeps for a project. It is a person's choice about the project, so it
 * travels with the repository:
 *
 * ```json
 * {
 *   "version": 1,
 *   "sources": [
 *     { "tracker": "gitlab", "host": "gitlab.example.org", "repo": "group/project", "default": true },
 *     { "tracker": "github", "repo": "owner/mcp-server" }
 *   ],
 *   "remotes": true,
 *   "every": 15
 * }
 * ```
 *
 * `sources` add to the remotes (or replace them, with `"remotes": false`), and
 * an entry naming a remote's repository overrides its flags. `default` says
 * which repository a short spelling — `gh#41`, `#12`, `!7` — means; `list`
 * whether its recent issues and changes are listed beyond the refs somebody
 * named (on by default for a remote, off for an extra). `every` is how many
 * minutes apart the host reads on its own while somebody is looking at the
 * project; `0` turns the schedule off.
 *
 * A repository a ref names outright — `gh:owner/repo#12` — is read without
 * being listed here: naming it is enough. That is how a GitLab project's epics
 * can point at the GitHub repositories its MCP servers live in.
 */

export interface Source {
  tracker: Tracker
  host: string
  repo: string
  /** Short spellings of this tracker resolve here. At most one per tracker. */
  default: boolean
  /** Its recent issues and changes are read, beyond the refs somebody named. */
  listed: boolean
}

/** The file, named once. */
const FILE_NAME = 'trackers'

/** Minutes between scheduled reads when the file does not say. */
export const EVERY_DEFAULT = 15

const NAME = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/
const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/

const entrySchema = z.object({
  tracker: z.enum(TRACKERS),
  host: z.string().regex(HOST).max(LIMITS.TRACKER_HOST).optional(),
  repo: z.string().regex(NAME).max(LIMITS.TRACKER_REPO),
  default: z.boolean().optional(),
  list: z.boolean().optional(),
})

const fileSchema = z.object({
  version: z.literal(1),
  sources: z.array(entrySchema).max(LIMITS.TRACKER_SOURCES).default([]),
  remotes: z.boolean().default(true),
  every: z.number().int().min(0).max(24 * 60).default(EVERY_DEFAULT),
})
export type TrackerConfig = z.infer<typeof fileSchema>

export function configFile(projectPath: string | null | undefined): string | null {
  return moduleFile(projectPath, HOST_ID, FILE_NAME)
}

export type ConfigRead = { ok: true; config: TrackerConfig } | { ok: false; file: string; why: string }

/** The project's tracker file, or the defaults when there is none. A broken file says why. */
export function readConfig(projectPath: string): ConfigRead {
  const file = configFile(projectPath)
  const defaults = fileSchema.parse({ version: 1 })
  if (!file) return { ok: true, config: defaults }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: true, config: defaults }
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text))
    if (parsed.success) return { ok: true, config: parsed.data }
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'the file'
    return { ok: false, file, why: `${where}: ${issue?.message ?? 'not the shape this host reads'}` }
  } catch {
    return { ok: false, file, why: 'it is not JSON' }
  }
}

/**
 * A remote URL as a tracker source, or null.
 *
 * GitHub by its host name; GitLab by a host name with `gitlab` in it, which is
 * every GitLab this was written against (gitlab.com, gitlab.<company>). A
 * GitLab on a host called something else is written in `trackers.json`.
 */
export function sourceOfRemote(remote: string): Omit<Source, 'default' | 'listed'> | null {
  const url = remote.trim()
  const forms = [
    /^[A-Za-z0-9_.-]+@([A-Za-z0-9.-]+):(?:\/)?(.+?)(?:\.git)?\/?$/, // git@host:owner/repo.git
    /^ssh:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/,
    /^https?:\/\/(?:[^@/]+@)?([A-Za-z0-9.-]+(?::\d+)?)\/(.+?)(?:\.git)?\/?$/,
  ]
  for (const form of forms) {
    const match = form.exec(url)
    if (!match) continue
    const host = match[1]!.toLowerCase()
    const repo = match[2]!
    if (!NAME.test(repo) || repo.length > LIMITS.TRACKER_REPO) return null
    const bare = host.replace(/:\d+$/, '')
    if (bare === 'github.com') return { tracker: 'github', host: 'github.com', repo }
    if (bare.split('.').some((part) => part === 'gitlab' || part.startsWith('gitlab'))) {
      return { tracker: 'gitlab', host: bare, repo }
    }
    return null
  }
  return null
}

/** The fetch URLs of a project's remotes, `origin` first. Nothing when it is not a repository. */
export async function remotesOf(projectPath: string, run: Runner): Promise<string[]> {
  const ran = await run(['git', '-C', projectPath, 'remote', '-v'], { timeout: 5_000 })
  if (ran.code !== 0) return []
  const seen = new Map<string, string>()
  for (const line of ran.out.split('\n')) {
    const [name, url, kind] = line.split(/\s+/)
    if (!name || !url || kind !== '(fetch)' || seen.has(name)) continue
    seen.set(name, url)
  }
  const names = [...seen.keys()].sort((a, b) => (a === 'origin' ? -1 : b === 'origin' ? 1 : a.localeCompare(b)))
  return names.map((name) => seen.get(name)!)
}

const same = (a: Pick<Source, 'tracker' | 'host' | 'repo'>, b: Pick<Source, 'tracker' | 'host' | 'repo'>) =>
  a.tracker === b.tracker && a.host.toLowerCase() === b.host.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()

/**
 * The sources a project reads: its remotes, then the file's entries, then
 * every repository its refs name outright. Pure, given the remotes, so the
 * rules are testable without a repository.
 */
export function sourcesOf(config: TrackerConfig, remotes: readonly string[], namedRefs: readonly string[] = []): Source[] {
  const out: Source[] = []
  const add = (one: Source) => {
    const at = out.findIndex((s) => same(s, one))
    if (at === -1) out.push(one)
    else out[at] = { ...out[at]!, ...one }
  }
  if (config.remotes) {
    for (const remote of remotes) {
      const found = sourceOfRemote(remote)
      if (found && !out.some((s) => same(s, found))) add({ ...found, default: false, listed: true })
    }
  }
  for (const entry of config.sources) {
    const host = entry.host ?? (entry.tracker === 'github' ? 'github.com' : 'gitlab.com')
    const before = out.find((s) => same(s, { tracker: entry.tracker, host, repo: entry.repo }))
    add({
      tracker: entry.tracker,
      host,
      repo: entry.repo,
      default: entry.default ?? before?.default ?? false,
      listed: entry.list ?? before?.listed ?? false,
    })
  }
  /* One default per tracker: the file's choice, or else the first source of
     that tracker (which is `origin` when origin is one). */
  for (const tracker of TRACKERS) {
    const mine = out.filter((s) => s.tracker === tracker)
    const chosen = mine.find((s) => s.default) ?? mine[0]
    for (const s of mine) s.default = s === chosen
  }
  /* Repositories refs name outright, read but not listed. A GitLab one is on
     the host of the project's default GitLab, which is the only GitLab host a
     bare `gl:group/project` can sensibly mean. */
  const glHost = out.find((s) => s.tracker === 'gitlab' && s.default)?.host ?? 'gitlab.com'
  for (const ref of namedRefs) {
    const name = readTrackerRef(ref)
    if (!name?.repo) continue
    const host = name.tracker === 'github' ? 'github.com' : glHost
    const one = { tracker: name.tracker, host, repo: name.repo }
    if (!out.some((s) => same(s, one))) out.push({ ...one, default: false, listed: false })
  }
  return out.slice(0, LIMITS.TRACKER_SOURCES)
}

/** The source a ref spelling names, among these, or null. */
export function sourceFor(sources: readonly Source[], ref: string): Source | null {
  const name = readTrackerRef(ref)
  if (!name) return null
  if (name.repo === null) return sources.find((s) => s.tracker === name.tracker && s.default) ?? null
  return sources.find((s) => s.tracker === name.tracker && s.repo.toLowerCase() === name.repo!.toLowerCase()) ?? null
}

export const sourceKey = (s: Pick<Source, 'tracker' | 'host' | 'repo'>) => `${s.tracker}|${s.host.toLowerCase()}|${s.repo.toLowerCase()}`
