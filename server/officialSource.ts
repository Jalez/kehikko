import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'


import { BUILT_IN_LAYOUTS, LAYOUT_VERSION, readBuiltInLayouts, type Layout } from '../src/host/layouts.ts'
import { HOST_REPO, readOfficial, readRetired, type Official, type Retired } from './official.ts'
import { because } from './traffic.ts'

/**
 * The CURRENT official module list, learned at run time.
 *
 * ## Why
 *
 * A host compiled into the desktop app used to offer exactly the modules it
 * was built with, so publishing a module meant releasing the app. Now the host
 * also reads `modules.json` as it stands on this repository's `main`, and a
 * module added there shows up in an app that is already installed.
 *
 * ## The merge
 *
 * What was fetched, laid over what the host was built with, by module id:
 *
 *  - in both: the fetched entry wins — it is the newer statement.
 *  - only fetched: added. This is the new module.
 *  - only built in: stays. Either nothing could be fetched, or the entry was
 *    taken off the published list; this release vouched for it and still
 *    offers it. A module is never taken away by the list — one that is
 *    installed is a registration on this machine, which nothing here touches.
 *
 * The built-in layouts (`layouts`, beside `modules`; `src/host/layouts.ts`)
 * are taken whole: a fetched list whose layouts read replaces the ones the host
 * was built with; one without them, or with any that does not read, leaves the
 * host's own. The module list is used either way.
 *
 * An entry that was only ever fetched and is later taken off the published
 * list stops being offered. If somebody installed it meanwhile it stays in
 * their list as the registered module it is, no longer marked official.
 *
 * ## It can only ever add to what the host has
 *
 * The fetched list goes through the same `readOfficial` as the built-in one,
 * bounded in bytes, in entries and in time. One that is unreachable, slow, too
 * big or does not parse is dropped WHOLE and the host carries on with what it
 * had: never a failed start, never an empty list, no error shown. The last
 * good one is kept on disk (`officialListFile`), so a start with no network
 * still knows the modules it saw before.
 *
 * ## When it asks
 *
 * On start, when somebody opens the module list, and when they check for
 * updates — and then at most once every few minutes (sooner after a failure,
 * so a laptop that started before its network did catches up). Never on a
 * timer: a host nobody is looking at asks nothing.
 *
 * ## Who is trusted
 *
 * The list names the repositories this app will clone and run when a person
 * presses Install, so whoever can change the list a host reads decides what
 * that button fetches. That used to be whoever cut the release the host was
 * built from. It is now WHOEVER CAN PUSH TO `main` OF THIS REPOSITORY, read
 * over HTTPS from GitHub's raw host, with redirects refused. Nothing else is
 * trusted: not the cache's location (it is re-validated when read, and written
 * only from a validated fetch), not the network path beyond TLS.
 *
 * What that trust cannot do is unchanged, and lives in `official.ts` and
 * `installs.ts`: a `repo` is `owner/name` on GitHub and nothing that reads as
 * a path or a flag; nothing is installed, updated or repointed because the
 * list changed — only a person's press installs, and only a module that is not
 * registered; a module already on the machine keeps the repository it came
 * from whatever the list says later.
 */

/** Where the published list is, unless the environment says otherwise. */
export const PUBLISHED_LIST = `https://raw.githubusercontent.com/${HOST_REPO}/main/modules.json`

/** More than any real list needs — today's is under 5 KB and nineteen entries. */
export const MAX_BYTES = 256 * 1024
export const MAX_ENTRIES = 200
export const FETCH_TIMEOUT_MS = 5_000
/** How long a good answer stands before the next ask, and how long a failed one does. */
export const REFRESH_EVERY_MS = 3 * 60_000
export const RETRY_AFTER_MS = 30_000

/**
 * Where to read the list from: `KEHIKOT_OFFICIAL_LIST` when it is set — a URL
 * (tests, scratch hosts), or `off` for a host that asks nobody and offers only
 * what it was built with — and the published list otherwise. Null means off;
 * something that is not an http(s) URL is off too, rather than a guess.
 */
export function listUrl(env: Record<string, string | undefined> = process.env): string | null {
  const set = env.KEHIKOT_OFFICIAL_LIST?.trim()
  if (!set) return PUBLISHED_LIST
  if (/^(off|none|0|false)$/i.test(set)) return null
  try {
    const url = new URL(set)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** A fetched list, read with the built-in list's own schema and one more bound. */
export function readFetched(raw: unknown): Official[] {
  const entries = readOfficial(raw)
  if (entries.length > MAX_ENTRIES) throw new Error(`the list has ${entries.length} entries, more than ${MAX_ENTRIES}`)
  return entries
}

/** The fetched list over the built-in one. See "The merge" above. */
export function mergeLists(builtIn: readonly Official[], fetched: readonly Official[] | null, retired: readonly Retired[] = []): Official[] {
  const gone = new Set(retired.map((one) => one.id))
  if (!fetched) return builtIn.filter((entry) => !gone.has(entry.id))
  const newer = new Map(fetched.map((entry) => [entry.id, entry]))
  const merged = builtIn.map((entry) => {
    const id = entry.id
    const over = newer.get(id)
    newer.delete(id)
    return over ?? entry
  })
  return [...merged, ...newer.values()].filter((entry) => !gone.has(entry.id))
}

/** Retired modules of both lists, by id; a module the fetched list still lists is not retired by an older built-in one. */
export function mergeRetired(builtIn: readonly Retired[], fetched: readonly Retired[] | null, listed: readonly Official[] | null): Retired[] {
  const alive = new Set((listed ?? []).map((entry) => entry.id))
  const all = new Map<string, Retired>()
  for (const one of [...builtIn, ...(fetched ?? [])]) all.set(one.id, one)
  return [...all.values()].filter((one) => !alive.has(one.id))
}

export interface Standing {
  /** When the list in use was read from where it is published; null when only the built-in one is in use. */
  fetched: string | null
  /** True when the last ask failed, so what is offered may be behind. */
  stale: boolean
  /** Present (true) when this machine switched asking off: only the built-in list is in use. */
  off?: true
}

export interface SourceDeps {
  builtIn: readonly Official[]
  /** The modules the built-in list retired. */
  builtInRetired?: readonly Retired[]
  /** The built-in layouts this host was built with; `BUILT_IN_LAYOUTS` when absent. */
  builtInLayouts?: readonly Layout[]
  /** Null turns fetching off: the built-in list, and nothing read or written. */
  url: string | null
  /** Where the last good list is kept. See `officialListFile`. */
  cache: string
  fetch?: (url: string, init: { signal: AbortSignal; redirect: 'error'; headers: Record<string, string> }) => Promise<Response>
  now?: () => number
  timeoutMs?: number
  /** One line for the host's own log when an ask fails. Never shown to anybody. */
  log?: (line: string) => void
}

/** The body as text, given up on as soon as it is longer than `max` bytes. */
async function bounded(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (declared > max) throw new Error(`the list is ${declared} bytes, more than ${max}`)
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      throw new Error(`the list is more than ${max} bytes`)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export function officialSource(deps: SourceDeps) {
  const now = deps.now ?? Date.now
  const ask: NonNullable<SourceDeps['fetch']> = (url, init) => because('the official module list', () => (deps.fetch ?? fetch)(url, init))
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS

  let fetched: Official[] | null = null
  let fetchedLayouts: Layout[] | null = null
  let fetchedAt: string | null = null
  let stale = false
  const builtInRetired = deps.builtInRetired ?? []
  let retiredNow: readonly Retired[] = mergeRetired(builtInRetired, null, fetched)
  let merged: readonly Official[] = mergeLists(deps.builtIn, null, retiredNow)
  let notBefore = 0
  let inFlight: Promise<void> | null = null

  function take(list: Official[], when: string, layouts: Layout[] | null, retired: Retired[] = []): void {
    fetched = list
    fetchedLayouts = layouts
    fetchedAt = when
    retiredNow = mergeRetired(builtInRetired, retired, list)
    merged = mergeLists(deps.builtIn, list, retiredNow)
  }

  /* The last good list, when it was read from the same place this host reads.
     Validated again: it is a file on a disk, and what it says decides what
     Install clones. Anything wrong with it and it is as if it were not there. */
  if (deps.url) {
    try {
      const kept = JSON.parse(readFileSync(deps.cache, 'utf8')) as { from?: unknown; fetched?: unknown; modules?: unknown; layouts?: unknown; retired?: unknown }
      if (kept.from === deps.url && typeof kept.fetched === 'string' && !Number.isNaN(Date.parse(kept.fetched))) {
        take(readFetched({ modules: kept.modules }), kept.fetched, readBuiltInLayouts({ layouts: kept.layouts }), readRetired(kept))
      }
    } catch {
      /* No cache, or not one this host can use. */
    }
  }

  async function once(url: string): Promise<void> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, refuse) => {
      timer = setTimeout(() => {
        abort.abort()
        refuse(new Error(`no answer within ${timeoutMs} ms`))
      }, timeoutMs)
    })
    try {
      const list = await Promise.race([
        (async () => {
          const response = await ask(url, { signal: abort.signal, redirect: 'error', headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`answered ${response.status}`)
          const raw: unknown = JSON.parse(await bounded(response, MAX_BYTES))
          return { modules: readFetched(raw), layouts: readBuiltInLayouts(raw), retired: readRetired(raw) }
        })(),
        late,
      ])
      const when = new Date(now()).toISOString()
      take(list.modules, when, list.layouts, list.retired)
      stale = false
      notBefore = now() + REFRESH_EVERY_MS
      try {
        mkdirSync(dirname(deps.cache), { recursive: true })
        const tmp = `${deps.cache}.writing-${process.pid}`
        writeFileSync(tmp, `${JSON.stringify({ from: url, fetched: when, modules: list.modules, ...(list.retired.length ? { retired: list.retired } : {}), ...(list.layouts ? { layouts: layoutsAsKept(list.layouts) } : {}) }, null, 2)}\n`)
        renameSync(tmp, deps.cache)
      } catch (error) {
        deps.log?.(`the official module list could not be kept at ${deps.cache}: ${(error as Error).message}`)
      }
    } catch (error) {
      stale = true
      notBefore = now() + RETRY_AFTER_MS
      deps.log?.(`the official module list at ${url} was not used: ${(error as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Ask again, unless it was asked a moment ago or is being asked now. Never
   * rejects: every way of failing ends with the host keeping what it had.
   */
  function refresh(): Promise<void> {
    const url = deps.url
    if (!url) return Promise.resolve()
    if (inFlight) return inFlight
    if (now() < notBefore) return Promise.resolve()
    inFlight = once(url).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  return {
    /** The list to offer and install from, as of now. */
    current: (): readonly Official[] => merged,
    /** The built-in layouts to offer: the published list's when it carried good ones, else the host's own. */
    layouts: (): readonly Layout[] => fetchedLayouts ?? deps.builtInLayouts ?? BUILT_IN_LAYOUTS,
    /** The modules the lists retired: what a host removes from its machine (`retired.ts`). */
    retired: (): readonly Retired[] => retiredNow,
    /** Only what was fetched (or read from the cache); null when there is none. */
    fetched: (): readonly Official[] | null => fetched,
    standing: (): Standing => ({ fetched: fetchedAt, stale, ...(deps.url ? {} : { off: true as const }) }),
    refresh,
  }
}

/**
 * Layouts as the cache keeps them: the shape `modules.json` gives them, so they are read back by the
 * same `readBuiltInLayouts`. They are kept as read, in the units of now, and say so with the current
 * `LAYOUT_VERSION`: kept with the version they were published at, they would be doubled again on the
 * next start. A cache an older host wrote says its own version, and is read in its units.
 */
function layoutsAsKept(layouts: readonly Layout[]) {
  return layouts.map((one) => ({ id: one.id, version: LAYOUT_VERSION, name: one.name, summary: one.summary, containers: one.containers }))
}
