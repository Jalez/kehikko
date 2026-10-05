import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LIMITS,
  moduleFile,
  readTrackerRef,
  trackerRowSchema,
  trackerSourceSchema,
  type TrackerDetailFacts,
  type TrackerMissing,
  type TrackerReading,
  type TrackerRefreshResult,
  type TrackerRow,
  type TrackerSignal,
  type TrackerSource,
} from 'roadmap-module-protocol'
import { z } from 'zod'

import type { Runner } from '../feedback.ts'
import { epicsIn, listEpics, readEpic } from '../holdings.ts'
import { HOST_ID } from '../kehikot.ts'
import type { Adapter, Read, Wanted } from './common.ts'
import { githubAdapter } from './github.ts'
import { gitlabAdapter } from './gitlab.ts'
import { EVERY_DEFAULT, readConfig, remotesOf, sourceFor, sourceKey, sourcesOf, type Source } from './sources.ts'

/**
 * The host's one tracker reading per project, and the only thing in Kehikot
 * that reads GitHub or GitLab for a module.
 *
 * ## Where it is kept
 *
 * `<project>/.kehikot/kehikko/tracker-reading.json`, spelled with `moduleFile`
 * beside the project's other host files. It is a cache of what the trackers
 * said — nothing is lost by deleting it — so the host writes a `.gitignore`
 * line for it beside it, the way References marks its own cache.
 *
 * ## Never waits on a tracker to answer a module
 *
 * `get` answers at once from what is held. A ref nobody has read yet comes back
 * `pending` and a read starts in the background; when it lands, `told` is
 * called with the new signal and the host puts it in `context.tracker` for
 * every page standing in the project. Startup reads nothing: the first read of
 * a project is started by the first page or module that asks about it.
 *
 * ## One read at a time per project
 *
 * Two presses are one read. A refresh asked for while a whole-project read is
 * running joins it; a narrower one waits for it and then reads what it asked
 * for. While any read runs, the previous reading stays served and the signal
 * says `refreshing`.
 *
 * ## A failure blanks nothing
 *
 * A source that fails keeps the rows it gave last time, each with its own
 * `readAt`, and the source carries the sentence saying why it is not newer.
 * Another source's failure never touches it.
 */

const FILE_NAME = 'tracker-reading'
const VERSION = 1
/** How many of each kind a listed source's listing reads. References' number, measured there. */
export const LIST_LIMIT = 400
/** How long a project counts as looked at after its last question, for the schedule. */
const LOOKED_AT_MS = 30 * 60_000

const storedSource = trackerSourceSchema.omit({ refreshing: true })
const fileSchema = z.object({
  version: z.literal(VERSION),
  at: z.string().nullable(),
  /** When the last whole-project read landed, for the schedule. */
  fullAt: z.string().nullable().default(null),
  sources: z.array(storedSource).max(LIMITS.TRACKER_SOURCES),
  rows: z.array(trackerRowSchema).max(LIMITS.TRACKER_ROWS * 2),
  /** Refs modules have asked about, so a whole read reads them again. */
  asked: z.array(z.string().max(LIMITS.REF)).max(LIMITS.TRACKER_ROWS),
  /** Refs somebody asked the detail of, so a read keeps it fresh. */
  detailed: z.array(z.string().max(LIMITS.REF)).max(LIMITS.TRACKER_ROWS),
  /** Identities the tracker said do not exist. */
  notFound: z.array(z.string()).max(LIMITS.TRACKER_ROWS),
})
type Stored = z.infer<typeof fileSchema>

const empty = (): Stored => ({ version: VERSION, at: null, fullAt: null, sources: [], rows: [], asked: [], detailed: [], notFound: [] })

export function readingFile(projectPath: string): string | null {
  return moduleFile(projectPath, HOST_ID, FILE_NAME)
}

/** The project's stored reading, or an empty one — a broken cache is a cache to rebuild, not a verdict to keep. */
export function loadReading(projectPath: string): Stored {
  const file = readingFile(projectPath)
  if (!file) return empty()
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : empty()
  } catch {
    return empty()
  }
}

const IGNORE = `# What the host last read from GitHub and GitLab for this project. A cache:
# nothing is lost by deleting it.
${FILE_NAME}.json
${FILE_NAME}.json.tmp
`

function saveReading(projectPath: string, stored: Stored): void {
  const file = readingFile(projectPath)
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  const ignore = join(dirname(file), '.gitignore')
  try {
    if (!existsSync(ignore)) writeFileSync(ignore, IGNORE)
    else if (!readFileSync(ignore, 'utf8').includes(`${FILE_NAME}.json`)) {
      writeFileSync(ignore, `${readFileSync(ignore, 'utf8').replace(/\n?$/, '\n')}${IGNORE}`)
    }
  } catch {
    /* An ignore line is a courtesy; a read-only folder is not a reason to lose the reading. */
  }
  writeFileSync(`${file}.tmp`, `${JSON.stringify(stored)}\n`)
  renameSync(`${file}.tmp`, file)
}

/** A row's identity: one item however it is spelled. GitHub numbers are shared by issues and PRs. */
const identity = (s: Pick<Source, 'tracker' | 'host' | 'repo'>, kind: 'issue' | 'change' | null, number: number) =>
  `${sourceKey(s)}|${s.tracker === 'github' ? 'n' : (kind ?? 'issue')}|${number}`
const rowIdentity = (row: TrackerRow) => identity(row, row.kind, row.number)

/** Every ref spelling an epic names, in `refs` arrays and `ref`/`umbrella` fields at any depth. */
export function refsInEpic(epic: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach((one) => walk(one, depth + 1))
    for (const [key, value] of Object.entries(v)) {
      if (key === 'refs' && Array.isArray(value)) {
        for (const one of value) if (typeof one === 'string' && readTrackerRef(one.trim())) out.add(one.trim())
      } else if ((key === 'ref' || key === 'umbrella') && typeof value === 'string' && readTrackerRef(value.trim())) {
        out.add(value.trim())
      } else walk(value, depth + 1)
    }
  }
  walk(epic, 0)
  return [...out]
}

export function epicRefs(root: string, slug: string): string[] | null {
  const dir = epicsIn(root)
  if (!dir) return null
  const epic = readEpic(dir, slug)
  return epic ? refsInEpic(epic) : null
}

export function allEpicRefs(root: string): string[] {
  const dir = epicsIn(root)
  if (!dir) return []
  const out = new Set<string>()
  for (const one of listEpics(dir)) for (const ref of epicRefs(root, one.slug) ?? []) out.add(ref)
  return [...out]
}

export type Scope = { refs: string[] } | { epic: string } | { project: true }

interface Held {
  stored: Stored
  /** Sources as last worked out, with their remotes. Null until the first read works them out. */
  sources: Source[] | null
  running: Promise<TrackerRefreshResult> | null
  runningScope: Scope | null
  /** Refs and details asked for while nothing covered them, read on the next tick. */
  queued: Set<string>
  queuedDetail: Set<string>
  /** Details asked for, by identity and version, so each is asked once. */
  detailTried: Set<string>
  kick: ReturnType<typeof setTimeout> | null
  lookedAt: number
}

export interface TrackersOptions {
  run: Runner
  /** Told whenever a project's signal changes: a read started, or one landed. */
  told?: (projectPath: string, signal: TrackerSignal) => void
  adapters?: Partial<Record<Source['tracker'], Adapter>>
  now?: () => Date
  listLimit?: number
}

export class Trackers {
  #held = new Map<string, Held>()
  #run: Runner
  #told: (projectPath: string, signal: TrackerSignal) => void
  #adapters: Record<Source['tracker'], Adapter>
  #now: () => Date
  #listLimit: number

  constructor(options: TrackersOptions) {
    this.#run = options.run
    this.#told = options.told ?? (() => {})
    this.#adapters = {
      github: options.adapters?.github ?? githubAdapter(options.run),
      gitlab: options.adapters?.gitlab ?? gitlabAdapter(options.run),
    }
    this.#now = options.now ?? (() => new Date())
    this.#listLimit = options.listLimit ?? LIST_LIMIT
  }

  #of(root: string): Held {
    let held = this.#held.get(root)
    if (!held) {
      held = {
        stored: loadReading(root),
        sources: null,
        running: null,
        runningScope: null,
        queued: new Set(),
        queuedDetail: new Set(),
        detailTried: new Set(),
        kick: null,
        lookedAt: 0,
      }
      this.#held.set(root, held)
    }
    return held
  }

  /** The small half, for `context.tracker`. Asking for it counts as somebody looking. */
  signal(root: string): TrackerSignal {
    const held = this.#of(root)
    held.lookedAt = Date.now()
    /* Nothing read yet, and nothing reading: the first look at a project starts
       its first read. Not at startup — when somebody is actually looking. */
    if (held.stored.at === null && !held.running) this.#start(root, { project: true })
    return { at: held.stored.at, refreshing: held.running !== null }
  }

  /** The sources as last known, for sentences and for `get`. */
  #sourcesFor(held: Held): Source[] {
    if (held.sources) return held.sources
    return held.stored.sources.map((s) => ({ tracker: s.tracker, host: s.host, repo: s.repo, default: s.default, listed: s.listed }))
  }

  /**
   * What the reading holds for one scope, at once. Starts a read for anything
   * it does not hold yet; see the essay at the top.
   */
  get(root: string, scope: Scope, detail: 'summary' | 'detail' = 'summary'): TrackerReading | { refused: string } {
    const held = this.#of(root)
    held.lookedAt = Date.now()
    const sources = this.#sourcesFor(held)
    const known = sources.length > 0 || held.stored.at !== null
    const byId = new Map(held.stored.rows.map((row) => [rowIdentity(row), row]))
    const notFound = new Set(held.stored.notFound)

    let rows: TrackerRow[] = []
    const missing: TrackerMissing[] = []
    if ('project' in scope) {
      rows = [...byId.values()]
      if (held.stored.at === null) this.#start(root, { project: true })
    } else {
      const refs = 'refs' in scope ? scope.refs : epicRefs(root, scope.epic)
      if (refs === null) return { refused: 'There is no epic here under that name.' }
      for (const ref of refs) {
        const source = sourceFor(sources, ref)
        const name = readTrackerRef(ref)
        if (!name) {
          missing.push({ ref, reason: 'no-tracker' })
          continue
        }
        if (!source && !name.repo) {
          /* A short spelling with no default source for its tracker. Before
             the first read nobody knows the sources yet, so it waits for one. */
          missing.push({ ref, reason: known ? 'no-tracker' : 'pending' })
          if (!known) held.queued.add(ref)
          continue
        }
        const found = source ? this.#find(byId, source, name.kind, name.number) : undefined
        if (found) {
          const asked = { ...found, ref }
          if (detail === 'summary') delete asked.detail
          else if (!found.detail || (found.updatedAt && found.detail.readAt < found.updatedAt)) {
            /* Asked once per version of the ref: a detail that could not be
               read is not asked again on every question, which would be a
               module and this host re-asking each other forever. */
            const tried = `${rowIdentity(found)}@${found.updatedAt ?? ''}`
            if (!held.detailTried.has(tried)) {
              held.detailTried.add(tried)
              held.queuedDetail.add(ref)
            }
          }
          rows.push(asked)
          continue
        }
        if (source && notFound.has(identity(source, name.kind, name.number))) {
          missing.push({ ref, reason: 'not-found' })
          continue
        }
        const failed = source ? held.stored.sources.find((s) => sourceKey(s) === sourceKey(source))?.error : null
        const triedBefore = held.stored.asked.includes(ref)
        if (failed && triedBefore && !held.running) {
          missing.push({ ref, reason: 'failed' })
          continue
        }
        missing.push({ ref, reason: 'pending' })
        held.queued.add(ref)
        if (detail === 'detail') held.queuedDetail.add(ref)
      }
      this.#kick(root)
    }

    return {
      at: held.stored.at,
      refreshing: held.running !== null,
      sources: this.#sourceRows(held),
      rows: rows.slice(0, LIMITS.TRACKER_ROWS),
      missing: missing.slice(0, LIMITS.TRACKER_ROWS),
    }
  }

  /**
   * `live.get`'s four bags for one epic, built from the reading: GitHub's keyed
   * by the ref as the epic spells it, GitLab's by number, with the state words
   * the old refresher wrote (`opened`, `closed`, `merged`). Null when the
   * reading holds none of the epic's refs. Starts a read for the rest, as `get`
   * does.
   */
  live(root: string, epic: string): Record<string, unknown> | null {
    const got = this.get(root, { epic })
    if ('refused' in got || !got.rows.length) return null
    const bags: Record<'issues' | 'mrs' | 'ghIssues' | 'ghPrs', Record<string, unknown>> = { issues: {}, mrs: {}, ghIssues: {}, ghPrs: {} }
    for (const row of got.rows) {
      const entry: Record<string, unknown> = {
        state: row.state === 'open' ? 'opened' : row.state,
        title: row.title,
        at: row.mergedAt ?? row.closedAt ?? row.updatedAt ?? '',
        url: row.url,
        labels: row.labels,
        assignees: row.assignees,
        ...(row.stateReason ? { stateReason: row.stateReason } : {}),
        ...(row.draft !== undefined ? { draft: row.draft } : {}),
        ...(row.author ? { author: row.author } : {}),
        ...(row.pipeline ? { pipeline: row.pipeline } : {}),
      }
      if (row.tracker === 'github') bags[row.kind === 'change' ? 'ghPrs' : 'ghIssues'][row.ref] = entry
      else bags[row.kind === 'change' ? 'mrs' : 'issues'][String(row.number)] = entry
    }
    return { generated: got.at, ...bags }
  }

  #find(byId: Map<string, TrackerRow>, source: Source, kind: 'issue' | 'change' | null, number: number) {
    return byId.get(identity(source, kind, number))
  }

  #sourceRows(held: Held): TrackerSource[] {
    const stored = new Map(held.stored.sources.map((s) => [sourceKey(s), s]))
    const now = this.#sourcesFor(held)
    return now.slice(0, LIMITS.TRACKER_SOURCES).map((s) => {
      const was = stored.get(sourceKey(s))
      return trackerSourceSchema.parse({
        tracker: s.tracker,
        host: s.host,
        repo: s.repo,
        default: s.default,
        listed: s.listed,
        at: was?.at ?? null,
        error: was?.error ?? null,
        refreshing: held.running !== null,
      })
    })
  }

  /** Read what was queued, once whatever is running has finished. */
  #kick(root: string): void {
    const held = this.#of(root)
    if (held.kick || (!held.queued.size && !held.queuedDetail.size)) return
    held.kick = setTimeout(() => {
      held.kick = null
      const refs = [...new Set([...held.queued, ...held.queuedDetail])]
      held.queued.clear()
      if (!refs.length) return
      void this.refresh(root, { refs: refs.slice(0, LIMITS.TRACKER_ROWS) }).catch(() => {})
    }, 25)
  }

  #start(root: string, scope: Scope): void {
    void this.refresh(root, scope).catch(() => {})
  }

  /**
   * Read the trackers for one scope and answer when the read lands.
   *
   * Joins a whole-project read already running; waits behind anything else.
   */
  refresh(root: string, scope: Scope): Promise<TrackerRefreshResult> {
    const held = this.#of(root)
    held.lookedAt = Date.now()
    if (held.running) {
      if (held.runningScope && 'project' in held.runningScope) return held.running
      const after = held.running.then(
        () => this.refresh(root, scope),
        () => this.refresh(root, scope),
      )
      return after
    }
    const run = this.#read(root, scope).finally(() => {
      held.running = null
      held.runningScope = null
      this.#told(root, { at: held.stored.at, refreshing: false })
      this.#kick(root)
    })
    held.running = run
    held.runningScope = scope
    this.#told(root, { at: held.stored.at, refreshing: true })
    return run
  }

  async #read(root: string, scope: Scope): Promise<TrackerRefreshResult> {
    const held = this.#of(root)
    const now = this.#now().toISOString()
    const config = readConfig(root)
    const named = allEpicRefs(root)

    let refs: string[]
    if ('refs' in scope) refs = scope.refs
    else if ('epic' in scope) {
      const found = epicRefs(root, scope.epic)
      if (found === null) return { outcome: 'declined', at: held.stored.at, why: 'There is no epic here under that name.' }
      refs = found
    } else refs = [...new Set([...named, ...held.stored.asked])]

    const remotes = await remotesOf(root, this.#run)
    const sources = sourcesOf(
      config.ok ? config.config : { version: 1, sources: [], remotes: true, every: EVERY_DEFAULT },
      remotes,
      [...named, ...held.stored.asked, ...refs],
    )
    held.sources = sources
    if (!sources.length) {
      held.stored = { ...held.stored, at: now, sources: [] }
      saveReading(root, held.stored)
      return {
        outcome: 'declined',
        at: held.stored.at,
        why: config.ok
          ? 'This project has no GitHub or GitLab remote and names no tracker in .kehikot/kehikko/trackers.json, so there is nothing to read.'
          : `${config.file} will not read (${config.why}).`,
      }
    }

    /* What each source is asked: its listing on a whole read, and the named
       refs the listing will not cover. */
    const plan = new Map<string, { source: Source; list: boolean; wanted: Map<string, Wanted & { refs: string[] }> }>()
    for (const source of sources) {
      plan.set(sourceKey(source), { source, list: 'project' in scope && source.listed, wanted: new Map() })
    }
    for (const ref of refs) {
      const source = sourceFor(sources, ref)
      const name = readTrackerRef(ref)
      if (!source || !name) continue
      const id = identity(source, name.kind, name.number)
      const entry = plan.get(sourceKey(source))!
      const was = entry.wanted.get(id)
      entry.wanted.set(id, { number: name.number, kind: name.kind, refs: [...(was?.refs ?? []), ref] })
    }

    const errors = new Map<string, string | null>()
    const fresh: TrackerRow[] = []
    const gone = new Set<string>()
    const listedNow = new Set<string>()
    await Promise.all(
      [...plan.values()].map(async ({ source, list, wanted }) => {
        const adapter = this.#adapters[source.tracker]
        const key = sourceKey(source)
        if (!list && !wanted.size) return
        let got: TrackerRow[] = []
        if (list) {
          const read = await adapter.list(source, this.#listLimit, now)
          if (!read.ok) return errors.set(key, read.why)
          got = read.rows
          listedNow.add(key)
        }
        const have = new Set(got.map(rowIdentity))
        const rest = [...wanted.entries()].filter(([id]) => !have.has(id)).map(([, w]) => w)
        if (rest.length) {
          const read: Read = await adapter.refs(source, rest, now)
          if (!read.ok) return errors.set(key, read.why)
          got = [...got, ...read.rows]
          }
        errors.set(key, null)
        fresh.push(...got)
        /* Asked for, answered for, and not among the rows: either the tracker
           said so, or what it said would not make a row. Either way it is not
           asked again until something names it afresh, so no question and no
           read can chase each other. */
        const made = new Set(got.map(rowIdentity))
        for (const [id] of wanted) if (!made.has(id)) gone.add(id)
      }),
    )

    /* Merge: fresh rows replace their identities; a listed source's rows that
       neither its new listing nor anybody's ref still names are dropped, so
       the reading does not grow forever. Rows of a failed source stay. */
    const wantedIds = new Set<string>()
    for (const { wanted } of plan.values()) for (const id of wanted.keys()) wantedIds.add(id)
    for (const ref of [...named, ...held.stored.asked]) {
      const source = sourceFor(sources, ref)
      const name = readTrackerRef(ref)
      if (source && name) wantedIds.add(identity(source, name.kind, name.number))
    }
    const byId = new Map<string, TrackerRow>()
    for (const row of held.stored.rows) {
      const key = sourceKey(row)
      if (listedNow.has(key) && !wantedIds.has(rowIdentity(row))) continue
      byId.set(rowIdentity(row), row)
    }
    for (const row of fresh) {
      const was = byId.get(rowIdentity(row))
      /* A detail read earlier survives a summary read, unless the ref moved since. */
      const detail = was?.detail && (!row.updatedAt || was.detail.readAt >= row.updatedAt) ? was.detail : undefined
      byId.set(rowIdentity(row), detail ? { ...row, detail } : row)
    }

    /* Detail, for the refs somebody asked the detail of and that this read covers. */
    const detailed = new Set([...held.stored.detailed, ...[...held.queuedDetail].filter((r) => refs.includes(r))])
    held.queuedDetail = new Set([...held.queuedDetail].filter((r) => !refs.includes(r)))
    const needDetail = new Map<string, { source: Source; rows: TrackerRow[] }>()
    for (const ref of detailed) {
      if (!refs.includes(ref) && !('project' in scope)) continue
      const source = sourceFor(sources, ref)
      const name = readTrackerRef(ref)
      if (!source || !name || errors.get(sourceKey(source))) continue
      const row = byId.get(identity(source, name.kind, name.number))
      if (!row || (row.detail && (!row.updatedAt || row.detail.readAt >= row.updatedAt))) continue
      const entry = needDetail.get(sourceKey(source)) ?? { source, rows: [] }
      entry.rows.push(row)
      needDetail.set(sourceKey(source), entry)
    }
    await Promise.all(
      [...needDetail.values()].map(async ({ source, rows }) => {
        const got = await this.#adapters[source.tracker].detail(source, rows.slice(0, LIMITS.TRACKER_ASK), now)
        if (!(got instanceof Map)) return errors.set(sourceKey(source), got.why)
        for (const row of rows) {
          const facts: TrackerDetailFacts | undefined = got.get(row.ref)
          if (facts) byId.set(rowIdentity(row), { ...row, detail: facts })
        }
      }),
    )

    const stored = new Map(held.stored.sources.map((s) => [sourceKey(s), s]))
    const notFound = new Set([...held.stored.notFound].filter((id) => !fresh.some((r) => rowIdentity(r) === id)))
    for (const id of gone) notFound.add(id)
    const asked = 'refs' in scope ? [...new Set([...held.stored.asked, ...scope.refs])] : held.stored.asked

    held.stored = {
      version: VERSION,
      at: now,
      fullAt: 'project' in scope ? now : held.stored.fullAt,
      sources: sources.map((s) => {
        const was = stored.get(sourceKey(s))
        const key = sourceKey(s)
        const error = errors.has(key) ? errors.get(key)! : (was?.error ?? null)
        return {
          tracker: s.tracker,
          host: s.host,
          repo: s.repo,
          default: s.default,
          listed: s.listed,
          at: errors.has(key) && errors.get(key) === null ? now : (was?.at ?? null),
          error: error === null ? null : error.slice(0, LIMITS.REASON),
        }
      }),
      rows: [...byId.values()].slice(0, LIMITS.TRACKER_ROWS),
      asked: asked.slice(-LIMITS.TRACKER_ROWS),
      detailed: [...detailed].slice(-LIMITS.TRACKER_ROWS),
      notFound: [...notFound].slice(-LIMITS.TRACKER_ROWS),
    }
    try {
      saveReading(root, held.stored)
    } catch {
      /* The reading is still served from memory; the file is a cache. */
    }

    const failed = [...errors.entries()].filter(([, why]) => why !== null)
    if (failed.length) {
      return {
        outcome: 'failed',
        at: now,
        why: failed
          .map(([key, why]) => `${key.split('|').slice(1).join('/')}: ${why}`)
          .join(' ')
          .slice(0, LIMITS.REASON),
      }
    }
    return { outcome: 'read', at: now, why: '' }
  }

  /**
   * The schedule: every project somebody has looked at in the last half hour
   * is read whole once its `every` has passed. Called on a minute tick by the
   * server; never at startup, and never for a project nobody is looking at.
   */
  tick(now: number = Date.now()): void {
    for (const [root, held] of this.#held) {
      if (held.running || now - held.lookedAt > LOOKED_AT_MS) continue
      const config = readConfig(root)
      const every = config.ok ? config.config.every : EVERY_DEFAULT
      if (every <= 0) continue
      const last = held.stored.fullAt ? Date.parse(held.stored.fullAt) : 0
      if (now - last >= every * 60_000) this.#start(root, { project: true })
    }
  }
}
