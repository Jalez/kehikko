import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import { CONTENT_HOST, EPIC_SLUG, LIMITS, MODULE_ID, kehikotDir, type ContentChange } from 'kehikot-module-protocol'
import { HOST_FOLDER, LEGACY_DATA_DIR, epicsDir, stateDir } from './hostData.ts'

/** `roadmap`: the host's folder from before the rename, still read where the new one is not there. */
const LEGACY_FOLDER = basename(LEGACY_DATA_DIR)

/**
 * Telling every container that the material it shows for an epic has changed.
 *
 * ## What was missing
 *
 * A module loads an epic when it is opened and has no reason to ask again. So
 * a ref an agent added to a journey step, an epic somebody retitled, a file
 * edited in the project's `.kehikot/` — each stayed invisible on an open
 * canvas until the window was reloaded. The tracker reading had this problem
 * and got `context.tracker`; this is the same answer for the material itself,
 * and the protocol's `content.ts` has the essay on the shape.
 *
 * ## Three things move it
 *
 * 1. The host's own writes to an epic — a create, a retitle, a delete, from
 *    the page or from the door. Said by whatever wrote, as `epicsChanged` is.
 * 2. A module reporting its own write: `content.changed`, relayed through
 *    `/host/call`. The source is the module that asked, never a parameter.
 * 3. An edit to the project's `.kehikot/` by anything else — a module's
 *    server process answering its own MCP door, an agent editing a file, a
 *    person with an editor. Nothing tells the host about those, so it watches;
 *    see `ContentWatch` below.
 *
 * What is kept is the last instant per source and epic, per project, and it is
 * kept in memory only: a host that starts again says nothing has changed since
 * it started, which is true, and costs a module at most one re-read.
 */

export interface ContentsOptions {
  /** Told a project's whole list whenever one entry moved. */
  told?: (projectPath: string, changes: ContentChange[]) => void
  now?: () => Date
}

export class Contents {
  #held = new Map<string, ContentChange[]>()
  #told: (projectPath: string, changes: ContentChange[]) => void
  #now: () => Date

  constructor(options: ContentsOptions = {}) {
    this.#told = options.told ?? (() => {})
    this.#now = options.now ?? (() => new Date())
  }

  /** What has changed in a project since this host began keeping count, newest last. */
  of(root: string): ContentChange[] {
    return [...(this.#held.get(root) ?? [])]
  }

  /**
   * One source's material changed, for one epic or for no one epic in
   * particular.
   *
   * The instant always moves forward for its `(source, epic)`, even when two
   * changes land inside one millisecond: a module compares instants to decide
   * whether to re-read, and a second change stamped the same as the first
   * would be a change nobody heard.
   */
  announce(root: string, source: string, epic: string | null = null): ContentChange[] {
    const held = this.#held.get(root) ?? []
    const before = held.find((one) => one.source === source && one.epic === epic)
    let at = this.#now().getTime()
    if (before && at <= Date.parse(before.at)) at = Date.parse(before.at) + 1
    const rest = held.filter((one) => one !== before)
    rest.push({ source, epic, at: new Date(at).toISOString() })
    /* Newest kept. One dropped moves the stamp of a module that was showing it
       and costs that module a re-read; see `contentSignalSchema`. */
    const kept = rest.slice(-LIMITS.CONTENT)
    this.#held.set(root, kept)
    this.#told(root, [...kept])
    return [...kept]
  }
}

/**
 * How long a folder has to be quiet before its change is announced.
 *
 * A save is rarely one event: an editor writes a temporary file and renames
 * it, a module rewrites two files for one edit. Long enough to fold those into
 * one announcement, short enough that a person watching an agent work sees the
 * step appear as the tool call returns.
 */
export const CONTENT_QUIET_MS = 150

/**
 * How long after a module reported its own write the watcher stays quiet about
 * that module's folder.
 *
 * The report and the file event are two accounts of one write, and they arrive
 * in either order a few milliseconds apart. Announcing both would have every
 * container re-read twice for one press.
 */
export const CONTENT_REPORTED_MS = 2000

export interface ContentWatchOptions {
  /** A source's material changed under `root`, from outside this host. */
  changed: (root: string, source: string, epic: string | null) => void
  /** A project's `state/` was rewritten from outside: the `live.get` view is not what it was. */
  stateChanged?: (root: string) => void
  /**
   * Which module keeps the folder of this name under `.kehikot/`, or null for
   * a folder that is nobody's. Asked rather than derived, because the folder
   * name drops the id's prefix and only the registry knows which id it was.
   */
  sourceOf?: (folder: string) => string | null
  quietMs?: number
  reportedMs?: number
  log?: (line: string) => void
}

interface Watched {
  watcher: FSWatcher
  /** What each of the host's own files held when it was last looked at. */
  seen: Map<string, string>
  pending: Map<string, ReturnType<typeof setTimeout>>
  /** When each source last reported its own write. */
  reported: Map<string, number>
}

/**
 * Watching the `.kehikot/` of every project somebody has open.
 *
 * ## Why this host watches after saying it would not
 *
 * `epicsChanged` in `wake.ts` refuses a watcher, and for a reason that still
 * holds: something rewrites `.kehikot/kehikko/` under a running host, and a
 * page re-reading on every one of those is the tick-driven read this host
 * refuses everywhere. What changed is not the reason but the cost of the
 * alternative. Modules write from their own server processes now — an agent at
 * a module's MCP door — and "what this host wrote, this host says" leaves all
 * of that unsaid, with a person watching the canvas for exactly that write.
 *
 * So it watches, and pays for the objection three ways:
 *
 * - **Only open projects.** `watching` is given the folders a screen is
 *   standing in; a project nobody is looking at is not watched at all.
 * - **Quiet first.** A burst is one announcement per source, after
 *   `CONTENT_QUIET_MS` of silence.
 * - **Nothing for nothing.** The host's own epics and state are compared by
 *   what they hold, so a file rewritten with the bytes it already had — a
 *   refresher run twice, an editor saving without a change — announces
 *   nothing. The host's own writes are `noted` as they are made, for the same
 *   comparison, so it does not hear itself.
 *
 * ## What a path means
 *
 * `kehikko/epics/<slug>.json` is the host's epic of that slug. `kehikko/state/…`
 * is what an outside refresher read, which is the tracker's business and goes
 * to `stateChanged`. Anything else under `kehikko/` is the host's own
 * bookkeeping — the reading, the marks, the arrangement — and each of those
 * already has its own news. Every other folder is the module's whose folder it
 * is, for no epic in particular: the host does not read a module's files and
 * cannot say which epic a line in one of them was about.
 */
export class ContentWatch {
  #watched = new Map<string, Watched>()
  #options: ContentWatchOptions
  #quietMs: number
  #reportedMs: number

  constructor(options: ContentWatchOptions) {
    this.#options = options
    this.#quietMs = options.quietMs ?? CONTENT_QUIET_MS
    this.#reportedMs = options.reportedMs ?? CONTENT_REPORTED_MS
  }

  /** The folders being watched. For tests, and for saying so. */
  get roots(): string[] {
    return [...this.#watched.keys()]
  }

  /**
   * Watch exactly these projects: start on the ones that are new, stop on the
   * ones that are gone. A project with no `.kehikot/` yet is tried again the
   * next time this is called, which is whenever a screen opens or closes.
   */
  watching(roots: readonly string[]): void {
    const wanted = new Set(roots)
    for (const root of [...this.#watched.keys()]) {
      if (!wanted.has(root)) this.#stop(root)
    }
    for (const root of wanted) {
      if (!this.#watched.has(root)) this.#start(root)
    }
  }

  /** Stop everything. */
  close(): void {
    for (const root of [...this.#watched.keys()]) this.#stop(root)
  }

  /**
   * The host wrote this file itself and has said so already. Remembered as it
   * now is, so the event the write causes compares equal and says nothing.
   */
  noted(root: string, file: string): void {
    const held = this.#watched.get(root)
    if (held) held.seen.set(file, signature(file))
  }

  /** A module reported its own write; its folder's events for a moment are that write. */
  reported(root: string, source: string): void {
    this.#watched.get(root)?.reported.set(source, Date.now())
  }

  #start(root: string): void {
    const dir = kehikotDir(root)
    if (!dir || !existsSync(dir)) return
    const seen = new Map<string, string>()
    for (const own of [epicsDir(root), stateDir(root)]) {
      for (const file of jsonIn(own)) seen.set(file, signature(file))
    }
    try {
      const watcher = watch(dir, { recursive: true }, (_event, name) => {
        if (typeof name === 'string') this.#heard(root, dir, name)
      })
      watcher.on('error', () => this.#stop(root))
      this.#watched.set(root, { watcher, seen, pending: new Map(), reported: new Map() })
    } catch (error) {
      this.#options.log?.(`kehikko: could not watch ${dir}: ${(error as Error).message}`)
    }
  }

  #stop(root: string): void {
    const held = this.#watched.get(root)
    if (!held) return
    this.#watched.delete(root)
    for (const timer of held.pending.values()) clearTimeout(timer)
    try {
      held.watcher.close()
    } catch {
      /* Already closed. */
    }
  }

  #heard(root: string, dir: string, name: string): void {
    const parts = name.split(sep)
    const folder = parts[0]
    /* Dot-files and editors' leavings: a `.tmp` beside the real file is half
       of a write whose other half is the rename that follows. */
    const leaf = parts[parts.length - 1] ?? ''
    if (!folder || parts.length < 2 || leaf.startsWith('.') || leaf.endsWith('~') || /\.tmp(-|$)|\.swp$/.test(leaf)) return

    /* The host's own folder, wherever this project keeps it — `hostData.ts`
       reads a pre-rename folder when the new one could not be made, and so
       does this. Compared by directory rather than by name for that reason. */
    const full = join(dir, name)
    if (folder === HOST_FOLDER || folder === LEGACY_FOLDER) {
      if (!leaf.endsWith('.json')) return
      const slug = leaf.slice(0, -'.json'.length)
      if (!EPIC_SLUG.test(slug)) return
      const within = dirname(full)
      if (within === epicsDir(root)) {
        this.#soon(root, `epic ${slug}`, () => this.#own(root, full, () => this.#options.changed(root, CONTENT_HOST, slug)))
      } else if (within === stateDir(root)) {
        this.#soon(root, `state ${slug}`, () => this.#own(root, full, () => this.#options.stateChanged?.(root)))
      }
      return
    }

    const source = (this.#options.sourceOf ?? folderSource)(folder)
    if (!source) return
    this.#soon(root, `module ${source}`, () => {
      const held = this.#watched.get(root)
      const last = held?.reported.get(source) ?? 0
      if (Date.now() - last < this.#reportedMs) return
      this.#options.changed(root, source, null)
    })
  }

  /** Say it only if the file does not hold what it held when last looked at. */
  #own(root: string, file: string, say: () => void): void {
    const held = this.#watched.get(root)
    if (!held) return
    const now = signature(file)
    if (held.seen.get(file) === now) return
    held.seen.set(file, now)
    say()
  }

  #soon(root: string, key: string, act: () => void): void {
    const held = this.#watched.get(root)
    if (!held) return
    const before = held.pending.get(key)
    if (before) clearTimeout(before)
    const timer = setTimeout(() => {
      held.pending.delete(key)
      if (this.#watched.get(root) !== held) return
      try {
        act()
      } catch (error) {
        this.#options.log?.(`kehikko: a change under ${root} was not announced: ${(error as Error).message}`)
      }
    }, this.#quietMs)
    timer.unref?.()
    held.pending.set(key, timer)
  }
}

/** `kehikot.<folder>`, where that is a module id at all. The registry knows better; see `sourceOf`. */
export function folderSource(folder: string): string | null {
  const id = `kehikot.${folder}`
  return MODULE_ID.test(id) ? id : null
}

/** What a file holds, as a short word to compare; `gone` when it is not there. */
function signature(file: string): string {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex')
  } catch {
    return 'gone'
  }
}

function jsonIn(dir: string): string[] {
  try {
    if (!statSync(dir).isDirectory()) return []
    return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => join(dir, name))
  } catch {
    return []
  }
}
