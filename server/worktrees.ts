import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import {
  AUTO_EVERY_MS,
  WORKTREE_CLEANUP_DEFAULT,
  decide,
  doneSaid,
  freedSaid,
  generated,
  keptSaid,
  type Change,
  type Facts,
  type Issue,
  type ProjectRows,
  type RemoveAnswer,
  type Removed,
  type Row,
  type Scan,
  type ScanState,
  type Skipped,
} from '../src/host/worktrees.ts'
import { QUIET_ENV } from './updates.ts'
import { run as runGit, type Runner } from './versions.ts'

/**
 * Cleaning up finished git worktrees: the scan, the removal, the daily run.
 * The rule and the words are `src/host/worktrees.ts`.
 *
 * ## Which repositories
 *
 * Every project this host knows whose folder is there: the folder itself when
 * it is a repository's main checkout, else each folder directly in it that is
 * one. A repository two projects share is scanned once. Each repository's
 * worktrees are `git worktree list --porcelain` less the first entry, which is
 * the main checkout and never touched; a worktree at a project's own folder is
 * never touched either.
 *
 * ## What it reads
 *
 * `git fetch origin` once per repository per scan (a failure is a note, and
 * what was fetched before is used), then local git for each worktree, `lsof`
 * once for the working directories of running processes, the tracker reading
 * for requests and issues by branch (`Trackers.branchStates`: the person's own
 * logged-in CLIs, never a credential of the host's), and `du` at the lowest
 * priority, with a time limit, for the size of what would be offered.
 *
 * ## What it changes
 *
 * Only on a person's press (`/host/worktrees/remove`, `PAGE_ONLY`) or the
 * daily run they turned on: each worktree is read again and decided again
 * just before it is removed, and only a path the last scan offered may be
 * named. `git worktree remove`, with `--force` only when the untracked files
 * are generated folders; `git branch -D` only for a merged branch or one whose
 * request is merged or closed; `git worktree prune` once per repository. A
 * remote branch is never deleted. No MCP tool removes.
 */

const KEY = 'worktree-cleanup'

interface Stored {
  auto: boolean
  lastRun: number
}

function readStored(db: Database): Stored {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    if (!row) return { auto: WORKTREE_CLEANUP_DEFAULT, lastRun: 0 }
    const stored = JSON.parse(row.value) as { auto?: unknown; lastRun?: unknown }
    return {
      auto: typeof stored.auto === 'boolean' ? stored.auto : WORKTREE_CLEANUP_DEFAULT,
      lastRun: typeof stored.lastRun === 'number' ? stored.lastRun : 0,
    }
  } catch {
    return { auto: WORKTREE_CLEANUP_DEFAULT, lastRun: 0 }
  }
}

function writeStored(db: Database, stored: Stored): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(KEY, JSON.stringify(stored))
}

/** "Remove finished worktrees automatically": off unless the person turned it on. */
export function readWorktreeAuto(db: Database): boolean {
  return readStored(db).auto
}

export function writeWorktreeAuto(db: Database, auto: boolean): void {
  writeStored(db, { ...readStored(db), auto })
}

/** A change the settings route takes: `{ auto: boolean }`, or null. */
export function worktreeAutoChange(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const auto = (body as { auto?: unknown }).auto
  return typeof auto === 'boolean' ? auto : null
}

/* ------------------------------------------------------------------ *
 * Reading git
 * ------------------------------------------------------------------ */

/** One entry of `git worktree list --porcelain`. */
export interface Listed {
  path: string
  head: string
  branch: string | null
  locked: boolean
  prunable: boolean
  bare: boolean
}

export function parseWorktrees(out: string): Listed[] {
  const listed: Listed[] = []
  for (const block of out.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter(Boolean)
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) continue
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null
    listed.push({
      path,
      head: lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
      branch: ref ? ref.replace(/^refs\/heads\//, '') : null,
      locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
      prunable: lines.some((l) => l === 'prunable' || l.startsWith('prunable ')),
      bare: lines.includes('bare'),
    })
  }
  return listed
}

/** What a program printed, whatever its exit code, within a time limit; null when it could not run or ran out of time. */
export type Output = (argv: readonly string[], timeoutMs: number) => Promise<string | null>

export const output: Output = async (argv, timeoutMs) => {
  let child
  try {
    child = Bun.spawn([...argv], { env: QUIET_ENV, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
  } catch {
    return null
  }
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
  clearTimeout(timer)
  return child.signalCode ? null : out
}

/** Every running process's working directory, by pid: `lsof` once. Empty when it cannot be read. */
export async function processCwds(out: Output = output): Promise<Map<number, string>> {
  const text = await out(['lsof', '-nP', '-d', 'cwd', '-Fpn'], 15_000)
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const line of (text ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null
    else if (line.startsWith('n') && pid !== null) cwds.set(pid, line.slice(1))
  }
  return cwds
}

/** Bytes a folder takes, by `du` at the lowest priority; null when it took longer than `timeoutMs`. */
export async function sizeOf(path: string, out: Output = output, timeoutMs = 30_000): Promise<number | null> {
  const text = await out(['nice', '-n', '19', 'du', '-sk', path], timeoutMs)
  const kb = Number(/^(\d+)/.exec(text ?? '')?.[1])
  return Number.isFinite(kb) && text ? kb * 1024 : null
}

/** The repository main checkouts in a project folder: the folder, or the folders directly in it. */
export function reposIn(projectPath: string): string[] {
  const isMain = (dir: string) => {
    try {
      return statSync(join(dir, '.git')).isDirectory()
    } catch {
      return false
    }
  }
  if (isMain(projectPath)) return [projectPath]
  try {
    return readdirSync(projectPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && isMain(join(projectPath, e.name)))
      .map((e) => join(projectPath, e.name))
      .slice(0, 100)
  } catch {
    return []
  }
}

/** The default branch to compare with: `origin/HEAD`'s, else `origin/main` or `origin/master`, else a local one. */
export async function baseOf(repo: string, git: Runner): Promise<string | null> {
  const head = await git(['git', '-C', repo, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.out) return head.out.replace(/^refs\/remotes\//, '')
  for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
    const got = await git(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', ref])
    if (got.ok) return ref.replace(/^refs\/(remotes|heads)\//, '')
  }
  return null
}

const mtime = (path: string): number => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

const readText = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Tracked files statted per worktree, at most: enough for any working tree a person edits by hand. */
const TRACKED_MAX = 20_000

/** The newest entry's own time in a reflog (`<old> <new> <who> <seconds> <zone>\t<what>`), ms, or 0. */
export function newestReflogEntry(text: string): number {
  let newest = 0
  for (const line of text.split('\n')) {
    const at = /> (\d+) [+-]\d{4}(?:\t|$)/.exec(line)
    if (at) newest = Math.max(newest, Number(at[1]) * 1000)
  }
  return newest
}

/**
 * When work last happened in a worktree, ms: its newest commit, its newest
 * checkout or commit as the reflog's entries record them, and the files in its
 * working tree. Never a file git writes for itself — the index, HEAD, the
 * reflog file's own time — since git rewrites those in housekeeping (`gc`,
 * `reflog expire`, `status`) with nobody working there; never the generated
 * folders either, which an install rewrites.
 */
export function workChangedAt(work: {
  path: string
  committedAt: number
  reflog: string
  tracked: readonly string[]
  untracked: readonly string[]
}): number {
  const files = [
    ...work.tracked.filter((p) => !generated(p)).slice(0, TRACKED_MAX),
    ...work.untracked.filter((p) => !generated(p)).slice(0, 200),
  ]
  return Math.max(work.committedAt, newestReflogEntry(work.reflog), ...files.map((p) => mtime(join(work.path, p))))
}

/** The worktree's own folder in the repository (`.git/worktrees/<name>`), from its `.git` file. */
function gitDirOf(path: string): string | null {
  try {
    const text = readFileSync(join(path, '.git'), 'utf8')
    const dir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim()
    if (!dir) return null
    return isAbsolute(dir) ? dir : resolve(path, dir)
  } catch {
    return null
  }
}

/** What the tracker said about branches, for one repository. */
export interface BranchStates {
  changes: ReadonlyArray<Change & { branch: string }>
  issues: ReadonlyArray<Issue & { branch: string }>
}

/** Everything the rule reads of one worktree. */
export async function factsOf(
  entry: Listed,
  repo: string,
  base: string | null,
  states: BranchStates,
  cwds: ReadonlyMap<number, string>,
  git: Runner,
): Promise<Facts | null> {
  const status = await git(['git', '-C', entry.path, 'status', '--porcelain=v1', '-unormal'], { timeoutMs: 60_000 })
  if (!status.ok) return null
  let tracked = 0
  const untracked: string[] = []
  for (const line of status.out.split('\n')) {
    if (!line.trim()) continue
    if (line.startsWith('?? ')) untracked.push(line.slice(3).replace(/^"|"$/g, '').replace(/\/$/, ''))
    else tracked += 1
  }
  const contained = base !== null && (await git(['git', '-C', repo, 'merge-base', '--is-ancestor', entry.head, base])).ok
  const counted = await git(['git', '-C', repo, 'rev-list', '--count', entry.head, '--not', '--remotes', ...(base ? [base] : [])])
  /* Unknown is not "none": a count that could not be read keeps the worktree. */
  const unpushed = counted.ok ? Number(counted.out) || 0 : 1
  const committed = await git(['git', '-C', repo, 'log', '-1', '--format=%ct', entry.head])
  const listed = await git(['git', '-C', entry.path, 'ls-files', '-z'], { timeoutMs: 60_000 })
  const gitDir = gitDirOf(entry.path)
  const changedAt = workChangedAt({
    path: entry.path,
    committedAt: committed.ok ? Number(committed.out) * 1000 || 0 : 0,
    reflog: gitDir ? readText(join(gitDir, 'logs', 'HEAD')) : '',
    tracked: listed.ok ? listed.out.split('\0').filter(Boolean) : [],
    untracked,
  })
  let busy: number | null = null
  for (const [pid, cwd] of cwds) {
    if (cwd === entry.path || cwd.startsWith(`${entry.path}/`)) {
      busy = pid
      break
    }
  }
  const branch = entry.branch
  return {
    path: entry.path,
    repo,
    branch,
    head: entry.head,
    base,
    locked: entry.locked,
    tracked,
    untracked,
    unpushed,
    contained,
    changedAt,
    busy,
    changes: branch ? states.changes.filter((c) => c.branch === branch).map(({ branch: _, ...c }) => c) : [],
    issues: branch ? states.issues.filter((i) => i.branch === branch).map(({ branch: _, ...i }) => i) : [],
  }
}

async function pool<T, U>(items: readonly T[], size: number, work: (item: T) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const at = next++
        out[at] = await work(items[at]!)
      }
    }),
  )
  return out
}

/* ------------------------------------------------------------------ *
 * The scan, the removal, the daily run
 * ------------------------------------------------------------------ */

export interface WorktreeDeps {
  db: Database
  projects(): Array<{ id: number; name: string; path: string; missing?: boolean }>
  /** Requests and issues by branch, for a repository with these remotes in this project (`Trackers.branchStates`). */
  branchStates(root: string, remotes: readonly string[]): Promise<{
    changes: Array<{ branch: string; number: number; state: Change['state']; head?: string; sign: '#' | '!' }>
    issues: Array<{ branch: string; number: number; state: Issue['state'] }>
    notes: string[]
  }>
  /** Write the automatic run's Inbox line in a project. */
  tell(project: number, line: string): void
  git?: Runner
  output?: Output
  /** Whether to fetch each repository first. The tests do not. */
  fetch?: boolean
  now?(): number
  log?(line: string): void
}

/** One offered or kept worktree as the scan holds it, with what removing it needs. */
interface Held {
  project: number
  facts: Facts
  row: Row
  offered: boolean
}

export class Worktrees {
  readonly #deps: WorktreeDeps
  readonly #git: Runner
  readonly #out: Output
  readonly #now: () => number
  #scan: Scan | null = null
  #held = new Map<string, Held>()
  #states = new Map<string, BranchStates>()
  #scanning: Promise<Scan> | null = null
  #removing: Promise<RemoveAnswer> | null = null
  #error: string | null = null

  constructor(deps: WorktreeDeps) {
    this.#deps = deps
    this.#git = deps.git ?? runGit
    this.#out = deps.output ?? output
    this.#now = deps.now ?? Date.now
  }

  state(): ScanState {
    return { scanning: this.#scanning !== null, scan: this.#scan, error: this.#error, auto: readWorktreeAuto(this.#deps.db) }
  }

  /** Start a scan, or join the one running. */
  scan(): Promise<Scan> {
    if (this.#scanning) return this.#scanning
    this.#error = null
    this.#scanning = this.#scanNow()
      .catch((error: unknown) => {
        this.#error = error instanceof Error ? error.message : String(error)
        throw error
      })
      .finally(() => {
        this.#scanning = null
      })
    return this.#scanning
  }

  async #scanNow(): Promise<Scan> {
    const started = this.#now()
    const git = this.#git
    const projects = this.#deps.projects().filter((p) => !p.missing && existsSync(p.path))
    const roots = new Set(projects.map((p) => resolve(p.path)))
    const cwds = await processCwds(this.#out)
    const seen = new Set<string>()
    const held = new Map<string, Held>()
    const states = new Map<string, BranchStates>()
    const out: ProjectRows[] = []
    for (const project of projects) {
      const rows: Row[] = []
      const notes: string[] = []
      let going = 0
      for (const repo of reposIn(project.path)) {
        if (seen.has(repo)) continue
        seen.add(repo)
        const list = await git(['git', '-C', repo, 'worktree', 'list', '--porcelain'])
        if (!list.ok) continue
        /* The first entry is the main checkout: never listed, never touched. */
        const linked = parseWorktrees(list.out)
          .slice(1)
          .filter((one) => !one.bare && !one.prunable && !roots.has(resolve(one.path)) && existsSync(one.path))
        if (!linked.length) continue
        if (this.#deps.fetch !== false) {
          const fetched = await git(['git', '-C', repo, 'fetch', '--quiet', '--no-tags', 'origin'], { timeoutMs: 60_000 })
          if (!fetched.ok) notes.push(`${repo}: could not fetch, so what was fetched before is used (${fetched.why})`)
        }
        const base = await baseOf(repo, git)
        const remotes = await git(['git', '-C', repo, 'remote', '-v'])
        const urls = remotes.ok ? [...new Set(remotes.out.split('\n').filter((l) => l.endsWith('(fetch)')).map((l) => l.split(/\s+/)[1]!))] : []
        const said = await this.#deps.branchStates(project.path, urls).catch((e: unknown) => ({
          changes: [],
          issues: [],
          notes: [`the tracker could not be read: ${e instanceof Error ? e.message : String(e)}`],
        }))
        notes.push(...said.notes)
        const repoStates: BranchStates = { changes: said.changes, issues: said.issues }
        states.set(repo, repoStates)
        const facts = await pool(linked, 6, (one) => factsOf(one, repo, base, repoStates, cwds, git))
        const now = this.#now()
        const decided = facts
          .filter((f): f is Facts => f !== null)
          .map((f) => ({ f, d: decide(f, now) }))
        const shown = decided.filter(({ d }) => d.offer || d.done !== null)
        going += decided.length - shown.length
        const sizes = await pool(shown, 3, ({ d, f }) => (d.offer ? sizeOf(f.path, this.#out) : Promise.resolve(null)))
        shown.forEach(({ f, d }, i) => {
          const row: Row = {
            path: f.path,
            repo,
            branch: f.branch,
            done: d.done ? doneSaid(d.done) : null,
            kept: d.offer ? null : keptSaid(d.kept),
            bytes: sizes[i] ?? null,
            changedAt: f.changedAt,
          }
          rows.push(row)
          held.set(f.path, { project: project.id, facts: f, row, offered: d.offer })
        })
      }
      if (going) notes.push(`${going} other worktree${going === 1 ? ' is' : 's are'} still in progress and not listed.`)
      if (rows.length || notes.length) out.push({ id: project.id, name: project.name, path: project.path, rows, notes })
    }
    const scan: Scan = { at: started, took: this.#now() - started, projects: out }
    this.#scan = scan
    this.#held = held
    this.#states = states
    return scan
  }

  /**
   * Remove these worktrees: each must be one the last scan offered, and is read
   * and decided again first. What was removed, and what was skipped and why.
   */
  remove(paths: readonly string[]): Promise<RemoveAnswer> {
    if (this.#removing) return this.#removing.then(() => this.remove(paths))
    this.#removing = this.#removeNow(paths).finally(() => {
      this.#removing = null
    })
    return this.#removing
  }

  async #removeNow(paths: readonly string[]): Promise<RemoveAnswer> {
    const git = this.#git
    const removed: Removed[] = []
    const skipped: Skipped[] = []
    const repos = new Set<string>()
    const cwds = await processCwds(this.#out)
    const roots = new Set(this.#deps.projects().map((p) => resolve(p.path)))
    for (const path of new Set(paths)) {
      const held = this.#held.get(path)
      if (!held || !held.offered) {
        skipped.push({ path, why: 'it was not offered by the last scan' })
        continue
      }
      const repo = held.facts.repo
      if (roots.has(resolve(path)) || resolve(path) === resolve(repo)) {
        skipped.push({ path, why: 'it is a main checkout' })
        continue
      }
      /* Read again: what was true at the scan may not be now. */
      const list = await git(['git', '-C', repo, 'worktree', 'list', '--porcelain'])
      const entry = list.ok ? parseWorktrees(list.out).slice(1).find((one) => one.path === path) : undefined
      if (!entry) {
        skipped.push({ path, why: 'it is no longer a worktree of its repository' })
        continue
      }
      const base = await baseOf(repo, git)
      const facts = await factsOf(entry, repo, base, this.#states.get(repo) ?? { changes: [], issues: [] }, cwds, git)
      if (!facts) {
        skipped.push({ path, why: 'git could not read it' })
        continue
      }
      const decision = decide(facts, this.#now())
      if (!decision.offer) {
        skipped.push({ path, why: keptSaid(decision.kept) })
        continue
      }
      const gone = await git(['git', '-C', repo, 'worktree', 'remove', ...(decision.force ? ['--force'] : []), path], { timeoutMs: 10 * 60_000 })
      repos.add(repo)
      if (!gone.ok) {
        skipped.push({ path, why: `git did not remove it: ${gone.why}` })
        continue
      }
      let branchDeleted = false
      if (decision.deleteBranch && facts.branch) {
        branchDeleted = (await git(['git', '-C', repo, 'branch', '-D', facts.branch])).ok
      }
      removed.push({ path, branch: facts.branch, bytes: held.row.bytes, branchDeleted })
      this.#held.delete(path)
    }
    for (const repo of repos) await git(['git', '-C', repo, 'worktree', 'prune'])
    if (this.#scan && removed.length) {
      const gone = new Set(removed.map((r) => r.path))
      this.#scan = {
        ...this.#scan,
        projects: this.#scan.projects.map((p) => ({ ...p, rows: p.rows.filter((r) => !gone.has(r.path)) })),
      }
    }
    for (const one of removed) this.#deps.log?.(`kehikko: removed the finished worktree ${one.path}${one.branchDeleted ? ` and its branch ${one.branch}` : ''}`)
    return { ok: true, removed, skipped }
  }

  /**
   * The daily run, when the person turned it on: a scan, everything it offers
   * removed (each decided again), and one Inbox line per project that freed
   * something. Asked hourly; runs when a day has passed since the last.
   */
  async tick(): Promise<RemoveAnswer | null> {
    const stored = readStored(this.#deps.db)
    if (!stored.auto || this.#now() - stored.lastRun < AUTO_EVERY_MS) return null
    writeStored(this.#deps.db, { ...stored, lastRun: this.#now() })
    await this.scan()
    const offered = [...this.#held.values()].filter((h) => h.offered)
    const answer = await this.remove(offered.map((h) => h.facts.path))
    const byProject = new Map<number, { count: number; bytes: number }>()
    const projectOf = new Map(offered.map((h) => [h.facts.path, h.project]))
    for (const one of answer.removed) {
      const project = projectOf.get(one.path)
      if (project === undefined) continue
      const was = byProject.get(project) ?? { count: 0, bytes: 0 }
      byProject.set(project, { count: was.count + 1, bytes: was.bytes + (one.bytes ?? 0) })
    }
    for (const [project, freed] of byProject) this.#deps.tell(project, freedSaid(freed.count, freed.bytes))
    return answer
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/**
 * `GET /host/worktrees` (the last scan, and whether one runs),
 * `POST /host/worktrees/scan` (start one) and `POST /host/worktrees/remove`
 * (`{ paths: string[] }`). Both POSTs are in `PAGE_ONLY`.
 */
export function worktreesRoute(worktrees: Worktrees) {
  return async (request: Request, url: URL): Promise<Response | null> => {
    if (url.pathname === '/host/worktrees' && request.method === 'GET') return json(worktrees.state())
    if (url.pathname === '/host/worktrees/scan' && request.method === 'POST') {
      void worktrees.scan().catch(() => null)
      return json(worktrees.state())
    }
    if (url.pathname === '/host/worktrees/remove' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { paths?: unknown } | null
      const paths = body?.paths
      if (!Array.isArray(paths) || paths.length > 2000 || !paths.every((p) => typeof p === 'string' && p.length > 0 && p.length < 4096)) {
        return json({ ok: false, why: 'A removal names the worktrees as { paths: string[] }.' }, 400)
      }
      return json(await worktrees.remove(paths as string[]))
    }
    return null
  }
}
