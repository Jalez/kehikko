import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  LIMITS,
  readTrackerRef,
  trackerBoardSchema,
  trackerRowSchema,
  trackerSourceSchema,
  type TrackerColumns,
  type TrackerDetailFacts,
  type TrackerMissing,
  type TrackerReading,
  type TrackerRefreshResult,
  type TrackerRow,
  type TrackerSignal,
  type TrackerSource,
} from 'kehikot-module-protocol'
import { z } from 'zod'

import type { Runner } from '../feedback.ts'
import { epicsIn, listEpics, readEpic } from '../holdings.ts'
import { makeUnderRoot } from '../projectRoot.ts'
import { withContributors, type Adapter, type BoardsRead, type HeldBoard, type Me, type Read, type Wanted } from './common.ts'
import { githubAdapter } from './github.ts'
import { BRANCH_PAGES, branchesOn, columnsOn, gitlabAdapter } from './gitlab.ts'
import { editTrackers, nextStep, startFresh, type Edit, type Edited } from './edit.ts'
import { withRoles } from './roles.ts'
import { withStacks } from './stacks.ts'
import { EVERY_DEFAULT, listSources, readConfig, remotesNamed, remotesOf, sourceFor, sourceKey, sourcesOf, type Source } from './sources.ts'
import type { TrackerListing } from '../../src/host/trackerSources.ts'
import { hostPath } from '../hostData.ts'
import { basename } from 'node:path'
import { because } from '../traffic.ts'

/** Why a tracker read is made, for the record of traffic: whose project and how much of it. */
export function trackerReason(root: string, scope: Scope): string {
  const what = 'refs' in scope ? `${scope.refs.length} ref${scope.refs.length === 1 ? '' : 's'}` : 'epic' in scope ? `epic ${scope.epic}` : 'whole project'
  return `tracker read: ${basename(root)} (${what})`
}

/**
 * The host's one tracker reading per project, and the only thing in Kehikot
 * that reads GitHub or GitLab for a module.
 *
 * ## Where it is kept
 *
 * `<project>/.kehikot/host/tracker-reading.json`, spelled with `hostPath`
 * beside the project's other host files. It is a cache of what the trackers
 * said — nothing is lost by deleting it — so the host writes a `.gitignore`
 * line for it beside it, the way a module marks its own cache.
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
 * ## Boards
 *
 * Beside the rows, each source's boards and their columns (`boards`), for
 * `tracker.columns` and for placing a GitLab issue, which says only its labels.
 * A GitHub read brings the boards its items are on; a GitLab source's boards
 * are one more call on a whole read. A whole read replaces a listed source's
 * boards; a narrower one adds to them. When a tracker would not show its
 * boards (GitHub without `read:project`), the source holds the sentence saying
 * so and no boards, and the rows have no `column` — the reading itself is not
 * failed by it.
 *
 * ## Who I am, and my roles
 *
 * Each row carries `myRoles` (protocol 2.7.0): the person's roles on it,
 * worked out from who they are on its tracker host — asked of the adapter
 * (`gh api user`, `glab api user`), once per host, kept `ME_KNOWN_MS` when
 * known and `ME_UNKNOWN_MS` when not — over the whole reading on every read.
 * When who they are is not known the rows have no `myRoles` (never guessed),
 * and the tracker sources panel says why in one sentence (`peopleNote`), as it
 * does when a tracker would not say who reviews (an older GitLab). The same
 * login says whether a row's last activity was theirs (`lastActivity.mine`,
 * 2.8.0); unknown, `mine` is absent.
 *
 * ## Stacks
 *
 * A change's `stack` (2.8.0) is worked out over the whole reading on every
 * read, open changes only (`withStacks` in `stacks.ts`).
 *
 * ## A failure blanks nothing
 *
 * A source that fails keeps the rows it gave last time, each with its own
 * `readAt`, and the source carries the sentence saying why it is not newer.
 * Another source's failure never touches it.
 */

const FILE_NAME = 'tracker-reading'
const VERSION = 1
/** How many of each kind a listed source's listing reads. A module's number, measured there. */
export const LIST_LIMIT = 400
/** How long a project counts as looked at after its last question, for the schedule. */
const LOOKED_AT_MS = 30 * 60_000
/** How long who the person is on a tracker host is believed. */
const ME_KNOWN_MS = 12 * 60 * 60_000
/** How long a failure to say who they are is believed before asking again. */
const ME_UNKNOWN_MS = 30 * 60_000

const storedSource = trackerSourceSchema.omit({ refreshing: true })
const heldBoardSchema = trackerBoardSchema.extend({
  lists: z.array(z.string()).max(LIMITS.TRACKER_COLUMNS).optional(),
  scope: z.array(z.string()).max(LIMITS.TRACKER_LABELS).optional(),
  open: z.boolean().optional(),
  closed: z.boolean().optional(),
})
const storedBoards = z.object({
  /** `sourceKey` of the source these are the boards of. */
  source: z.string(),
  boards: z.array(heldBoardSchema).max(LIMITS.TRACKER_BOARDS),
  /** Why the boards could not be read, in the sentence a person is told; null when they were. */
  unreadable: z.string().max(LIMITS.REASON).nullable().default(null),
})
type StoredBoards = z.infer<typeof storedBoards>
/** A source's branch names, for an issue's related branches on a tracker that does not say them (GitLab). */
const storedBranches = z.object({
  /** `sourceKey` of the source these are the branches of. */
  source: z.string(),
  names: z.array(z.string().min(1).max(LIMITS.BRANCH)).max(BRANCH_PAGES * 100),
})
type StoredBranches = z.infer<typeof storedBranches>
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
  /** Each source's boards, as last read. Absent in a file from before boards: none known. */
  boards: z.array(storedBoards).max(LIMITS.TRACKER_SOURCES).default([]),
  /** Each GitLab source's branch names, as last read (2.19.0). Absent in an older file: none known. */
  branches: z.array(storedBranches).max(LIMITS.TRACKER_SOURCES).default([]),
})
type Stored = z.infer<typeof fileSchema>

const empty = (): Stored => ({ version: VERSION, at: null, fullAt: null, sources: [], rows: [], asked: [], detailed: [], notFound: [], boards: [], branches: [] })

export function readingFile(projectPath: string): string | null {
  return hostPath(projectPath, `${FILE_NAME}.json`)
}

/** The project's stored reading, or an empty one — a broken cache is a cache to rebuild, not a verdict to keep. */
export function loadReading(projectPath: string): Stored {
  const file = readingFile(projectPath)
  if (!file) return empty()
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    /* Linked again on the way in: a file written before the links were worked
       out over the whole reading is put right without waiting for a read. */
    return parsed.success ? { ...parsed.data, rows: backLinked(parsed.data.rows) } : empty()
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
  /* A cache, and the folder it would go in is gone: keep it in memory, make nothing. */
  if (!makeUnderRoot(projectPath, dirname(file))) return
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

/**
 * Give each issue the changes in the reading that declare it, and say it was
 * closed by a merge when one of them merged (Jalez/kehikko#38).
 *
 * Over the WHOLE reading, every time rows are merged into it, and not over the
 * rows of one read: an issue and the change that delivers it are often read by
 * different reads — one in a listing, the other by name — and an issue read
 * again by name arrives from GitLab with no links at all. Worked out per read,
 * the link exists only when both happened to arrive together.
 *
 * A change's own `closes` is the claim; `closed-by` is its mirror. So a mirror
 * naming a held change that no longer makes the claim is taken off — but only
 * when that change was read after the issue, since otherwise the link is the
 * tracker's own newer word about the issue (GitHub hands an issue its closers).
 * A link to a change the reading does not hold is left alone: nothing here
 * can say it is wrong.
 */
function backLinked(rows: TrackerRow[]): TrackerRow[] {
  /* Refs are spelled per source, so `#12` is only itself within one. */
  const within = (row: TrackerRow, ref: string) => `${sourceKey(row)}|${ref}`
  /* And the changes that are only part of an issue, as its `contributedBy`
     (protocol 2.26.0): over the whole reading for the same reason, after the
     closers, so that a change that closes the issue is not also one of them. */
  return withContributors(closedByDeclarers(rows, within), within)
}

function closedByDeclarers(rows: TrackerRow[], within: (row: TrackerRow, ref: string) => string): TrackerRow[] {
  const changes = new Map<string, TrackerRow>()
  const declarers = new Map<string, TrackerRow[]>()
  for (const one of rows) {
    if (one.kind !== 'change') continue
    changes.set(within(one, one.ref), one)
    for (const link of one.links) {
      if (link.relation === 'closes') declarers.set(within(one, link.ref), [...(declarers.get(within(one, link.ref)) ?? []), one])
    }
  }
  return rows.map((one) => {
    if (one.kind !== 'issue') return one
    const by = declarers.get(within(one, one.ref)) ?? []
    const declaring = new Set(by.map((d) => d.ref))
    const withdrawn = one.links
      .filter((link) => link.relation === 'closed-by' && !declaring.has(link.ref))
      .map((link) => changes.get(within(one, link.ref)))
      .filter((change): change is TrackerRow => change !== undefined && change.readAt > one.readAt)
    const known = new Set(one.links.map((l) => l.ref))
    const added = by.filter((d) => !known.has(d.ref))
    const merged = by.some((d) => d.state === 'merged')
    if (!withdrawn.length && !added.length && (!merged || one.closedByMerge === true)) return one
    const gone = new Set(withdrawn.map((c) => c.ref))
    const { closedByMerge: was, ...rest } = one
    /* True when a declarer merged. Never false from this alone: a change
       outside the reading may be the one that closed it. And when the merged
       change it rested on has withdrawn, it is unknown again, not still true. */
    const closedByMerge = merged ? true : withdrawn.some((c) => c.state === 'merged') ? undefined : was
    return {
      ...rest,
      links: [
        ...one.links.filter((l) => !gone.has(l.ref)),
        ...added.map((d) => ({ ref: d.ref, relation: 'closed-by' as const })),
      ].slice(0, LIMITS.TRACKER_LINKS),
      ...(closedByMerge !== undefined ? { closedByMerge } : {}),
    }
  })
}

/** A sentence cut to what a reason may be. */
const clip = (text: string) => (text.length > LIMITS.REASON ? `${text.slice(0, LIMITS.REASON - 1)}…` : text)

/** A board's identity across sources: one GitHub project may hold several repositories' items. */
const boardKey = (b: Pick<HeldBoard, 'board' | 'boardUrl'>) => `${b.board}|${b.boardUrl ?? ''}`

/** Boards `fresh` over `was`, by identity, fresh ones winning and first. */
function unionBoards(was: readonly HeldBoard[], fresh: readonly HeldBoard[]): HeldBoard[] {
  const out = new Map<string, HeldBoard>()
  for (const b of [...fresh, ...was]) if (!out.has(boardKey(b))) out.set(boardKey(b), b)
  return [...out.values()].slice(0, LIMITS.TRACKER_BOARDS)
}

/** Two reads of one source's boards as one: unreadable wins, since then none of them were seen. */
function joinBoards(a: BoardsRead | undefined, b: BoardsRead | undefined): BoardsRead | undefined {
  if (!a) return b
  if (!b) return a
  if ('unreadable' in a) return a
  if ('unreadable' in b) return b
  return { boards: unionBoards(a.boards, b.boards) }
}

/**
 * Place each GitLab issue on the boards held for its source. A GitHub row
 * came from its tracker with its column already; a GitLab row says only its
 * labels, so its column is worked out here, every time, from the boards as
 * they now stand.
 */
function placedOnBoards(rows: TrackerRow[], boards: readonly StoredBoards[]): TrackerRow[] {
  const by = new Map(boards.map((b) => [b.source, b.boards]))
  return rows.map((row) => {
    if (row.tracker !== 'gitlab') return row
    const held = by.get(sourceKey(row))
    return held ? columnsOn(row, held) : row
  })
}

/**
 * Give each GitLab issue its related branches from the names held for its
 * source (protocol 2.19.0), worked out every time as its column is. A GitHub
 * row came from its tracker with its linked branches already; a source whose
 * names were never read leaves its issues with none said (absent).
 */
function withBranches(rows: TrackerRow[], branches: readonly StoredBranches[]): TrackerRow[] {
  const by = new Map(branches.map((b) => [b.source, b.names]))
  return rows.map((row) => {
    if (row.tracker !== 'gitlab') return row
    const names = by.get(sourceKey(row))
    return names ? branchesOn(row, names) : row
  })
}

/**
 * Every ref spelling an epic names, in `refs` and `related` arrays and `ref`/`issue`/`umbrella` fields at
 * any depth. `related` and `issue` are a published plan step's (protocol 2.21.0): the older record keeps
 * a step's prior art among its `refs`, a plan moves it to `related`, and the scope must be the same
 * before and after Journeys publishes. A gate's `waitsOn` is not read: the record never was.
 */
export function refsInEpic(epic: unknown): string[] {
  const out = new Set<string>()
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach((one) => walk(one, depth + 1))
    for (const [key, value] of Object.entries(v)) {
      if ((key === 'refs' || key === 'related') && Array.isArray(value)) {
        for (const one of value) if (typeof one === 'string' && readTrackerRef(one.trim())) out.add(one.trim())
      } else if ((key === 'ref' || key === 'issue' || key === 'umbrella') && typeof value === 'string' && readTrackerRef(value.trim())) {
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

/** Which epic names each ref spelling, the first by slug: where a tracker notice belongs. */
export function epicsByRef(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const dir = epicsIn(root)
  if (!dir) return out
  for (const one of listEpics(dir)) {
    for (const ref of epicRefs(root, one.slug) ?? []) if (!out.has(ref)) out.set(ref, one.slug)
  }
  return out
}

/**
 * Which refs a call is about. `also`, with an epic (protocol 2.19.0, `tracker.get { epic, parts: true }`):
 * refs to answer beside the ones the epic names — what its parts hold.
 */
export type Scope = { refs: string[] } | { epic: string; also?: readonly string[] } | { project: true }

/** The refs an epic scope covers: the epic's own, then `also` that it does not name. Null for no such epic. */
function epicScopeRefs(root: string, scope: { epic: string; also?: readonly string[] }): string[] | null {
  const own = epicRefs(root, scope.epic)
  if (own === null) return null
  return [...new Set([...own, ...(scope.also ?? [])])]
}

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
  /** Per source key: why the person's roles there are not whole, in the sentence they are told. */
  peopleNotes: Map<string, { about: 'me' | 'reviewers'; said: string }>
}

export interface TrackersOptions {
  run: Runner
  /** Told whenever a project's signal changes: a read started, or one landed. */
  told?: (projectPath: string, signal: TrackerSignal) => void
  /**
   * Told when a read's rows are stored, with who the person is per
   * `tracker|host` where known: what tracker notices compare (`server/trackerNotices.ts`).
   */
  landed?: (projectPath: string, rows: readonly TrackerRow[], me: ReadonlyMap<string, string>) => void
  adapters?: Partial<Record<Source['tracker'], Adapter>>
  now?: () => Date
  listLimit?: number
}

export class Trackers {
  #held = new Map<string, Held>()
  #run: Runner
  #told: (projectPath: string, signal: TrackerSignal) => void
  #landed: NonNullable<TrackersOptions['landed']>
  #adapters: Record<Source['tracker'], Adapter>
  #now: () => Date
  #listLimit: number
  /** Who the person is per tracker host (`tracker|host`), and until when that is believed. */
  #me = new Map<string, { me: Me; until: number }>()

  constructor(options: TrackersOptions) {
    this.#run = options.run
    this.#told = options.told ?? (() => {})
    this.#landed = options.landed ?? (() => {})
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
        peopleNotes: new Map(),
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

  /**
   * The project's sources as a person is shown them: where each came from, its
   * switches, what it last read and how much — beside the schedule and the
   * remotes switch. Worked out from the file and the remotes, not from the
   * last read, so an edit shows at once.
   */
  listing(root: string, remotes: ReadonlyArray<{ name: string; url: string }>): TrackerListing {
    const held = this.#of(root)
    const config = readConfig(root)
    if (!config.ok) {
      return { sources: [], remotes: true, every: EVERY_DEFAULT, broken: { file: config.file, why: config.why } }
    }
    const stored = new Map(held.stored.sources.map((s) => [sourceKey(s), s]))
    const boards = new Map(held.stored.boards.map((b) => [b.source, b]))
    const counts = new Map<string, { issues: number; changes: number }>()
    for (const row of held.stored.rows) {
      const key = sourceKey(row)
      const one = counts.get(key) ?? { issues: 0, changes: 0 }
      if (row.kind === 'change') one.changes += 1
      else one.issues += 1
      counts.set(key, one)
    }
    return {
      sources: listSources(config.config, remotes).map((s) => {
        const was = stored.get(sourceKey(s))
        const n = counts.get(sourceKey(s))
        return {
          tracker: s.tracker,
          host: s.host,
          repo: s.repo,
          default: s.default,
          listed: s.listed,
          origin: s.origin,
          remote: s.remote,
          off: s.off,
          at: was?.at ?? null,
          error: was?.error ?? null,
          issues: was?.at ? (n?.issues ?? 0) : null,
          changes: was?.at ? (n?.changes ?? 0) : null,
          boards: (boards.get(sourceKey(s))?.boards ?? []).map(({ board, columns }) => ({ board, columns })),
        }
      }),
      boardsNote: held.stored.boards.find((b) => b.unreadable && stored.has(b.source))?.unreadable ?? null,
      peopleNote: [...held.peopleNotes].find(([key]) => stored.has(key))?.[1].said ?? null,
      remotes: config.config.remotes,
      every: config.config.every,
      broken: null,
    }
  }

  /** `listing`, with the project's remotes asked of git. */
  async describe(root: string): Promise<TrackerListing> {
    return this.listing(root, await remotesNamed(root, this.#run))
  }

  /**
   * One edit of the project's tracker sources — the only way the file is
   * written. A change has the host read again; an answer is the sentence and
   * the sources as they now stand.
   */
  async edit(root: string, edit: Edit | { kind: 'fresh' }): Promise<Edited & { listing: TrackerListing }> {
    const remotes = await remotesNamed(root, this.#run)
    const done = edit.kind === 'fresh' ? startFresh(root) : editTrackers(root, edit, remotes)
    if (done.outcome === 'changed') this.sourcesChanged(root, remotes.map((r) => r.url))
    return { ...done, listing: this.listing(root, remotes) }
  }

  /**
   * The file changed: work the sources out again at once, so the next answer
   * is the new list, and read. Every container is told when the read starts
   * and lands, as for any read.
   */
  sourcesChanged(root: string, remotes: readonly string[]): void {
    const held = this.#of(root)
    const config = readConfig(root)
    held.sources = sourcesOf(
      config.ok ? config.config : { version: 1, sources: [], remotes: true, every: EVERY_DEFAULT },
      remotes,
      [...allEpicRefs(root), ...held.stored.asked],
    )
    this.#start(root, { project: true })
  }

  /**
   * Read one source once, now, as it would be read — nothing is stored. What
   * it found in counts, or why it could not in words with the next step.
   */
  async check(source: Source): Promise<{ ok: true; issues: number; changes: number; capped: boolean } | { ok: false; why: string }> {
    const adapter = this.#adapters[source.tracker]
    const limit = 100
    const read = await adapter.list(source, limit, this.#now().toISOString())
    if (!read.ok) return { ok: false, why: nextStep(read.why, source.tracker, source.host) }
    const issues = read.rows.filter((r) => r.kind === 'issue').length
    const changes = read.rows.filter((r) => r.kind === 'change').length
    return { ok: true, issues, changes, capped: issues >= limit || changes >= limit }
  }

  /** Who the person is on a tracker host, asked of its adapter at most once per `ME_KNOWN_MS`. */
  async #whoAmI(source: Source): Promise<Me | null> {
    const ask = this.#adapters[source.tracker].me
    if (!ask) return null
    const key = `${source.tracker}|${source.host}`
    const was = this.#me.get(key)
    const now = this.#now().getTime()
    if (was && now < was.until) return was.me
    const me = await ask(source.host).catch((e: unknown) => ({ why: e instanceof Error ? e.message : String(e) }))
    this.#me.set(key, { me, until: now + ('login' in me ? ME_KNOWN_MS : ME_UNKNOWN_MS) })
    return me
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
      const refs = 'refs' in scope ? scope.refs : epicScopeRefs(root, scope)
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
      /* An epic's issues come with the changes that are part of them
         (protocol 2.26.0, Jalez/kehikko#187): "Part of #3912" names the issue,
         not the epic, so without this the change is missing from the epic
         while its issue is there. Only what the reading holds; nothing is
         asked for, and a ref asked for by name is answered as itself only. */
      if ('epic' in scope) {
        const answered = new Set(rows.map(rowIdentity))
        for (const issue of [...rows]) {
          if (issue.kind !== 'issue') continue
          for (const ref of issue.contributedBy ?? []) {
            const name = readTrackerRef(ref)
            if (!name) continue
            const found = this.#find(byId, issue, 'change', name.number)
            if (!found || answered.has(rowIdentity(found))) continue
            answered.add(rowIdentity(found))
            const { detail: _, ...summary } = found
            rows.push(summary)
          }
        }
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
   * `tracker.columns`: the boards of the sources the project reads now and
   * their columns, from the reading, at once. A board two sources share is
   * one board. Nothing read yet starts the first read, as `get` does.
   */
  columns(root: string): TrackerColumns {
    const held = this.#of(root)
    held.lookedAt = Date.now()
    if (held.stored.at === null) this.#start(root, { project: true })
    const now = new Set(this.#sourcesFor(held).map(sourceKey))
    const seen = new Map<string, TrackerColumns['boards'][number]>()
    for (const one of held.stored.boards) {
      if (!now.has(one.source)) continue
      for (const b of one.boards) {
        const key = boardKey(b)
        if (seen.has(key)) continue
        seen.set(key, { board: b.board, ...(b.boardUrl ? { boardUrl: b.boardUrl } : {}), columns: b.columns })
      }
    }
    return { boards: [...seen.values()].slice(0, LIMITS.TRACKER_BOARDS) }
  }

  /**
   * `live.get`'s four bags for one epic, built from the reading: GitHub's keyed
   * by the ref as the epic spells it, GitLab's by number, with the state words
   * the old refresher wrote (`opened`, `closed`, `merged`). Null when the
   * reading holds none of the epic's refs and has not been read, or the
   * epic's refs are still being asked for. Starts a read for the rest, as `get`
   * does.
   *
   * With them, which change delivers which issue, in the refresher's two maps:
   * `links`, a GitLab issue's number to its merge requests' numbers, and
   * `ghLinks`, a GitHub issue's ref as the epic spells it to its pull requests'
   * numbers. A change is under an issue only where a row's link says so — a
   * `closes` on the change or its `closed-by` mirror on the issue — which for
   * GitLab is a closing keyword in the merge request's own description
   * (`closingIssues` in `common.ts`), and for GitHub its closing references. A
   * change that is only part of an issue ("Part of #12", protocol 2.26.0) is
   * not under it here: these maps say which change delivers which issue, and
   * their readers take an issue with a merged change as delivered. A change
   * that only mentions an issue has no link and folds nowhere.
   */
  live(root: string, epic: string): Record<string, unknown> | null {
    const got = this.get(root, { epic })
    if ('refused' in got) return null
    /* A reading that has landed and has nothing of this epic's in it, with
       nothing of the epic's still being asked for, is an honest empty
       reading — "the trackers were read and hold nothing live for it" — and
       not the refusal that means nobody has read them. */
    if (!got.rows.length && !(got.at && !got.missing.length)) return null
    const bags: Record<'issues' | 'mrs' | 'ghIssues' | 'ghPrs', Record<string, unknown>> = { issues: {}, mrs: {}, ghIssues: {}, ghPrs: {} }
    const links: Record<string, number[]> = {}
    const ghLinks: Record<string, number[]> = {}
    const spelled = new Map(got.rows.filter((row) => row.kind === 'issue').map((row) => [rowIdentity(row), row.ref]))
    for (const row of got.rows) {
      for (const link of row.links) {
        const other = readTrackerRef(link.ref)
        if (!other) continue
        let issue: string
        let change: number
        if (row.kind === 'issue' && link.relation === 'closed-by') {
          issue = row.tracker === 'github' ? row.ref : String(row.number)
          change = other.number
        } else if (row.kind === 'change' && link.relation === 'closes') {
          /* An issue the epic does not name has no spelling of the epic's; the link's own stands. */
          issue = row.tracker === 'github' ? (spelled.get(identity(row, 'issue', other.number)) ?? link.ref) : String(other.number)
          change = row.number
        } else continue
        const map = row.tracker === 'github' ? ghLinks : links
        if (!map[issue]?.includes(change)) map[issue] = [...(map[issue] ?? []), change]
      }
    }
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
    return { generated: got.at, ...bags, links, ghLinks }
  }

  #find(byId: Map<string, TrackerRow>, source: Pick<Source, 'tracker' | 'host' | 'repo'>, kind: 'issue' | 'change' | null, number: number) {
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
    const held = this.#held.get(root)
    if (!held || held.kick || (!held.queued.size && !held.queuedDetail.size)) return
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
    const run = because(trackerReason(root, scope), () => this.#read(root, scope)).finally(() => {
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
      const found = epicScopeRefs(root, scope)
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
      this.#save(root, held)
      return {
        outcome: 'declined',
        at: held.stored.at,
        why: config.ok
          ? 'This project has no GitHub or GitLab remote and has no source added, so there is nothing to read. Add one from the trackers panel in the bar.'
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
    const boardsRead = new Map<string, BoardsRead>()
    /** Per source read: the sentence when it would not say who reviews, or null when it did. */
    const peopleRead = new Map<string, string | null>()
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
          if (read.boards) boardsRead.set(key, read.boards)
          peopleRead.set(key, read.people?.unreadable ?? null)
        }
        const have = new Set(got.map(rowIdentity))
        let unread: { why: string; refs: Array<{ number: number; kind: 'issue' | 'change' | null }> } | undefined
        const rest = [...wanted.entries()].filter(([id]) => !have.has(id)).map(([, w]) => w)
        if (rest.length) {
          const read: Read = await adapter.refs(source, rest, now)
          if (!read.ok) return errors.set(key, read.why)
          got = [...got, ...read.rows]
          unread = read.unread
          if (read.people || !peopleRead.has(key)) peopleRead.set(key, read.people?.unreadable ?? null)
          const joined = joinBoards(boardsRead.get(key), read.boards)
          if (joined) boardsRead.set(key, joined)
        }
        const refused = new Set((unread?.refs ?? []).map((r) => identity(source, r.kind, r.number)))
        errors.set(key, unread?.why ?? null)
        fresh.push(...got)
        /* Asked for, answered for, and not among the rows: either the tracker
           said so, or what it said would not make a row. Either way it is not
           asked again until something names it afresh, so no question and no
           read can chase each other. */
        const made = new Set(got.map(rowIdentity))
        for (const [id] of wanted) if (!made.has(id) && !refused.has(id)) gone.add(id)
      }),
    )

    /* A whole read asks a tracker that reads its boards apart (GitLab) for
       them: one call per source that read cleanly. A failure keeps the boards
       held before, and fails nothing. */
    if ('project' in scope) {
      await Promise.all(
        sources.map(async (source) => {
          const key = sourceKey(source)
          const boards = this.#adapters[source.tracker].boards
          if (!boards || errors.get(key) || boardsRead.has(key)) return
          const got = await boards(source).catch(() => null)
          if (got) boardsRead.set(key, got)
        }),
      )
    }

    /* And its branch names, for an issue's related branches (GitLab, 2.19.0):
       a listing of them per source that read cleanly, never a request per
       issue. A failure keeps the names held before. */
    const branchesRead = new Map<string, string[]>()
    if ('project' in scope) {
      await Promise.all(
        sources.map(async (source) => {
          const key = sourceKey(source)
          const read = this.#adapters[source.tracker].branches
          if (!read || errors.get(key)) return
          const got = await read(source).catch(() => null)
          if (got) branchesRead.set(key, got)
        }),
      )
    }

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
    const stillRead = new Set(sources.map(sourceKey))
    for (const row of held.stored.rows) {
      const key = sourceKey(row)
      /* A source that is no longer read (removed, or turned off) takes its rows with it. */
      if (!stillRead.has(key)) continue
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

    const boardsWas = new Map(held.stored.boards.map((b) => [b.source, b]))
    const boards: StoredBoards[] = []
    for (const source of sources) {
      const key = sourceKey(source)
      const was = boardsWas.get(key)
      const got = boardsRead.get(key)
      if (!got) {
        if (was) boards.push(was)
        continue
      }
      if ('unreadable' in got) {
        boards.push({ source: key, boards: [], unreadable: got.unreadable.slice(0, LIMITS.REASON) })
        continue
      }
      /* A listing saw everything recent, so it replaces; a read by name saw a few, so it adds. */
      const whole = listedNow.has(key) || source.tracker !== 'github'
      boards.push({ source: key, boards: whole ? got.boards.slice(0, LIMITS.TRACKER_BOARDS) : unionBoards(was?.boards ?? [], got.boards), unreadable: null })
    }

    const branchesWas = new Map(held.stored.branches.map((b) => [b.source, b]))
    const branches: StoredBranches[] = []
    for (const source of sources) {
      const key = sourceKey(source)
      const got = branchesRead.get(key)
      if (got) branches.push({ source: key, names: got.slice(0, BRANCH_PAGES * 100) })
      else if (branchesWas.has(key)) branches.push(branchesWas.get(key)!)
    }

    /* Who the person is on each host read, and their roles over the whole reading. */
    const meBy = new Map<string, string>()
    for (const source of sources) {
      const key = sourceKey(source)
      /* A source not read, or whose read failed, has its own sentence already. */
      if ((!plan.get(key)?.list && !plan.get(key)?.wanted.size) || errors.get(key)) continue
      const me = await this.#whoAmI(source)
      if (!me) continue
      if ('login' in me) {
        meBy.set(`${source.tracker}|${source.host}`, me.login)
        const note = peopleRead.get(key)
        if (note) held.peopleNotes.set(key, { about: 'reviewers', said: note })
        else if (note === null || held.peopleNotes.get(key)?.about === 'me') held.peopleNotes.delete(key)
      } else {
        held.peopleNotes.set(key, { about: 'me', said: clip(`My role needs to know who you are on ${source.host}: ${me.why}`) })
      }
    }
    const roled = [...byId.values()].map((row) => {
      const me = meBy.get(`${row.tracker}|${row.host}`)
      return me ? withRoles(row, me) : row
    })

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
      rows: withBranches(placedOnBoards(withStacks(backLinked(roled)), boards), branches).slice(0, LIMITS.TRACKER_ROWS),
      asked: asked.slice(-LIMITS.TRACKER_ROWS),
      detailed: [...detailed].slice(-LIMITS.TRACKER_ROWS),
      notFound: [...notFound].slice(-LIMITS.TRACKER_ROWS),
      boards,
      branches,
    }
    try {
      this.#save(root, held)
    } catch {
      /* The reading is still served from memory; the file is a cache. */
    }
    try {
      const me = new Map<string, string>()
      for (const [key, known] of this.#me) if ('login' in known.me) me.set(key, known.me.login)
      this.#landed(root, held.stored.rows, me)
    } catch {
      /* A notice that could not be worked out is not a reason to fail the read. */
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
   * Something that is not this host rewrote the project's `state/`, which
   * `live` reads under the reading. The view is not what it was, so `at` moves
   * and every module that reacts to `tracker` asks again.
   *
   * Nothing is said for a project that has never been read: the first look
   * starts its first read, and that read is told when it lands.
   */
  stateChanged(root: string): void {
    const held = this.#of(root)
    if (held.stored.at === null) return
    held.stored.at = this.#now().toISOString()
    saveReading(root, held.stored)
    this.#told(root, { at: held.stored.at, refreshing: held.running !== null })
  }

  /** A read that lands after its project was forgotten writes nothing. */
  #save(root: string, held: Held): void {
    if (this.#held.get(root) === held) saveReading(root, held.stored)
  }

  /**
   * The project was taken off the list: hold nothing for it, so the schedule
   * reads and writes nothing there again. A read already running lands in
   * memory only.
   */
  forget(root: string): void {
    const held = this.#held.get(root)
    if (!held) return
    if (held.kick) clearTimeout(held.kick)
    this.#held.delete(root)
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
