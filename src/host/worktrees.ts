import { bytesSaid } from './storage.ts'

/**
 * Cleaning up finished git worktrees — the rule and the words, shared by the
 * server (`server/worktrees.ts`, which runs git) and the page
 * (`src/canvas/Worktrees.tsx`). Pure: nothing here runs git or reads a disk.
 *
 * ## What "finished" is
 *
 * A worktree other than a repository's main checkout is finished when one of
 * these is true, read in this order:
 *
 *  1. its branch's pull or merge request is merged or closed (matched by head
 *     branch, through the tracker reading the host already does);
 *  2. its HEAD is contained in the default branch, as last fetched;
 *  3. its branch is one an issue names as its own (the reading's linked or
 *     related branches), and every such issue is closed.
 *
 * An open request on its branch keeps it, whatever else is true.
 *
 * ## What is never offered
 *
 * A finished worktree is still kept when any of these holds — each is a reason
 * a person is shown (`keptSaid`):
 *
 *  - it is locked (`git worktree lock`);
 *  - a tracked file has changes, staged or not;
 *  - it holds files git does not track, other than generated folders such as
 *    `node_modules` (only those are removed with `--force`);
 *  - it has commits that are on no remote branch and not in the default
 *    branch, and are not the head of its request;
 *  - something in it changed in the last 24 hours;
 *  - a running process has it as its working directory.
 *
 * The main checkout is never listed. A remote branch is never deleted. The
 * local branch is deleted only when it is merged into the default branch or
 * its request is merged or closed (`deletesBranch`).
 *
 * ## Removing them automatically
 *
 * "Remove finished worktrees automatically" is off unless the person turns it
 * on: one row of `settings` in `frame.sqlite`. On, the same rule runs once a
 * day and removes only what it would offer, and says in the Inbox how much
 * room it freed.
 */

export const WORKTREE_CLEANUP = {
  label: 'Remove finished worktrees automatically',
  description:
    'Once a day, worktrees whose pull or merge request is merged or closed, or whose work is already in the default branch, are removed. A worktree with changes, unpushed commits, something changed in the last day, or a process working in it is always left alone.',
  open: 'Clean up finished worktrees',
  openDescription: 'Worktrees whose work is merged or closed, in every project, with what each takes. You choose which to remove.',
} as const

export const WORKTREE_CLEANUP_DEFAULT = false

/** Whose line the daily run writes in the Inbox: the host's own. */
export const WORKTREES_INBOX_MODULE = 'kehikko.worktrees'

/** How long after its last change a worktree is left alone. */
export const RECENT_MS = 24 * 60 * 60_000

/** How often the automatic cleanup runs, when it is on. */
export const AUTO_EVERY_MS = 24 * 60 * 60_000

/**
 * Untracked folders that are generated and may go with the worktree: the only
 * untracked files `--force` is used for. Matched on the first path segment
 * that git reports.
 */
export const GENERATED = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.svelte-kit',
  '__pycache__',
  '.venv',
  '.pytest_cache',
])

/** Whether an untracked path, as `git status --porcelain` says it, is a generated folder or inside one. */
export function generated(path: string): boolean {
  return path.split('/').some((segment) => GENERATED.has(segment))
}

/** The pull or merge request a branch is the head of, as the tracker said. */
export interface Change {
  /** `!` for a merge request, `#` for a pull request: how the number is spelled. */
  sign: '#' | '!'
  number: number
  state: 'open' | 'merged' | 'closed'
  /** The commit its head is at, when the tracker said. */
  head?: string
}

/** An issue that names the branch as its own. */
export interface Issue {
  number: number
  state: 'open' | 'closed'
}

/** What the server read of one worktree. */
export interface Facts {
  path: string
  /** The repository's main checkout. */
  repo: string
  /** Null for a detached HEAD. */
  branch: string | null
  head: string
  /** The default branch, as `origin/main`, or null when none could be told. */
  base: string | null
  locked: boolean
  /** Tracked files with changes, staged or not. */
  tracked: number
  /** Untracked paths git reports (folders collapsed), each as said. */
  untracked: readonly string[]
  /** Commits on no remote branch and not in the default branch. */
  unpushed: number
  /** HEAD is contained in the default branch. */
  contained: boolean
  /** When work in it last happened, ms: its newest commit or checkout, or a file in its working tree. Not git's own housekeeping (`workChangedAt`). */
  changedAt: number
  /** A running process has its working directory here: its pid. */
  busy: number | null
  /** Requests whose head is this branch. */
  changes: readonly Change[]
  /** Issues that name this branch. */
  issues: readonly Issue[]
}

export type Done =
  | { kind: 'change'; sign: '#' | '!'; number: number; state: 'merged' | 'closed' }
  | { kind: 'contained'; base: string }
  | { kind: 'issue'; numbers: number[] }

export type Kept =
  | { kind: 'open'; sign: '#' | '!'; number: number }
  | { kind: 'not-done' }
  | { kind: 'locked' }
  | { kind: 'tracked'; count: number }
  | { kind: 'untracked'; paths: string[] }
  | { kind: 'unpushed'; count: number }
  | { kind: 'recent'; at: number }
  | { kind: 'busy'; pid: number }

export type Decision =
  | { offer: true; done: Done; force: boolean; deleteBranch: boolean }
  | { offer: false; done: Done | null; kept: Kept }

/** The request that says most about a branch: an open one, else a merged one, else the highest closed one. */
export function changeOf(changes: readonly Change[]): Change | null {
  const by = (state: Change['state']) => changes.filter((c) => c.state === state).sort((a, b) => b.number - a.number)[0]
  return by('open') ?? by('merged') ?? by('closed') ?? null
}

/** Whether the work is finished, and why — or null. */
export function doneOf(facts: Facts): { done: Done | null; open: Change | null } {
  const change = changeOf(facts.changes)
  if (change?.state === 'open') return { done: null, open: change }
  if (change) return { done: { kind: 'change', sign: change.sign, number: change.number, state: change.state as 'merged' | 'closed' }, open: null }
  if (facts.contained && facts.base) return { done: { kind: 'contained', base: facts.base }, open: null }
  if (facts.branch && facts.issues.length && facts.issues.every((i) => i.state === 'closed')) {
    return { done: { kind: 'issue', numbers: facts.issues.map((i) => i.number).sort((a, b) => a - b) }, open: null }
  }
  return { done: null, open: null }
}

/** The rule (see the top of this file). `now` in ms. */
export function decide(facts: Facts, now: number): Decision {
  const { done, open } = doneOf(facts)
  if (open) return { offer: false, done: null, kept: { kind: 'open', sign: open.sign, number: open.number } }
  if (!done) return { offer: false, done: null, kept: { kind: 'not-done' } }
  const keep = (kept: Kept): Decision => ({ offer: false, done, kept })
  if (facts.locked) return keep({ kind: 'locked' })
  if (facts.tracked > 0) return keep({ kind: 'tracked', count: facts.tracked })
  const loose = facts.untracked.filter((path) => !generated(path))
  if (loose.length) return keep({ kind: 'untracked', paths: loose.slice(0, 5) })
  const change = changeOf(facts.changes)
  /* The request's head is on the forge, so commits up to it are not lost with the worktree. */
  const pushedAsChange = change !== null && change.head !== undefined && change.head === facts.head
  if (facts.unpushed > 0 && !pushedAsChange) return keep({ kind: 'unpushed', count: facts.unpushed })
  if (now - facts.changedAt < RECENT_MS) return keep({ kind: 'recent', at: facts.changedAt })
  if (facts.busy !== null) return keep({ kind: 'busy', pid: facts.busy })
  return { offer: true, done, force: facts.untracked.length > 0, deleteBranch: deletesBranch(facts, done) }
}

/** The local branch goes only when it is merged, or its request is merged or closed. */
export function deletesBranch(facts: Facts, done: Done): boolean {
  if (!facts.branch) return false
  return facts.contained || done.kind === 'change'
}

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const requestWord = (sign: '#' | '!') => (sign === '!' ? 'MR' : 'PR')
const shortBase = (base: string) => base.replace(/^[^/]+\//, '')

/** Why a worktree is finished: "PR #12 merged", "contained in main". */
export function doneSaid(done: Done): string {
  if (done.kind === 'change') return `${requestWord(done.sign)} ${done.sign}${done.number} ${done.state}`
  if (done.kind === 'contained') return `contained in ${shortBase(done.base)}`
  return done.numbers.length === 1 ? `issue #${done.numbers[0]} closed` : `issues ${done.numbers.map((n) => `#${n}`).join(', ')} closed`
}

/** Why a worktree is kept, as a clause. */
export function keptSaid(kept: Kept): string {
  switch (kept.kind) {
    case 'open':
      return `${requestWord(kept.sign)} ${kept.sign}${kept.number} is still open`
    case 'not-done':
      return 'its work is not merged or closed'
    case 'locked':
      return 'it is locked'
    case 'tracked':
      return `${plural(kept.count, 'tracked file has', 'tracked files have')} changes`
    case 'untracked':
      return `it has files git does not track: ${kept.paths.join(', ')}`
    case 'unpushed':
      return `${plural(kept.count, 'commit is', 'commits are')} not pushed anywhere`
    case 'recent':
      return 'something in it changed in the last 24 hours'
    case 'busy':
      return `a running process (pid ${kept.pid}) works in it`
  }
}

/** "3 days ago", "today", for a last change. */
export function agoSaid(at: number, now: number): string {
  const days = Math.floor((now - at) / (24 * 60 * 60_000))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  return `${Math.floor(days / 30)} months ago`
}

/** A size, or why there is none. */
export function sizeSaid(bytes: number | null): string {
  return bytes === null ? 'size not measured' : bytesSaid(bytes)
}

/** "Remove 12 worktrees (3.4 GB)". */
export function removeSaid(count: number, bytes: number, unmeasured: number): string {
  const size = bytes > 0 ? ` (${unmeasured ? 'at least ' : ''}${bytesSaid(bytes)})` : ''
  return `Remove ${plural(count, 'worktree')}${size}`
}

/** The Inbox line the automatic cleanup writes. */
export function freedSaid(count: number, bytes: number): string {
  return `Removed ${plural(count, 'finished worktree')}${bytes > 0 ? `, freeing ${bytesSaid(bytes)}` : ''}.`
}

/* ------------------------------------------------------------------ *
 * What the route answers
 * ------------------------------------------------------------------ */

/** One worktree as the page is shown it. */
export interface Row {
  path: string
  repo: string
  branch: string | null
  /** Why it is finished, said; null when it is not. */
  done: string | null
  /** Offered: why it is kept, said, is null. */
  kept: string | null
  bytes: number | null
  changedAt: number
}

export interface ProjectRows {
  id: number
  name: string
  path: string
  rows: Row[]
  /** Sentences about what could not be read here (a fetch, a tracker), each said once. */
  notes: string[]
}

export interface Scan {
  at: number
  took: number
  projects: ProjectRows[]
}

/** The scan as the page polls it: running, the last one, or why it failed. */
export interface ScanState {
  scanning: boolean
  scan: Scan | null
  error: string | null
  auto: boolean
}

export interface Removed {
  path: string
  branch: string | null
  bytes: number | null
  /** The local branch was deleted too. */
  branchDeleted: boolean
}

export interface Skipped {
  path: string
  why: string
}

export interface RemoveAnswer {
  ok: true
  removed: Removed[]
  skipped: Skipped[]
}

/** "Removed 3 worktrees, freeing 1.2 GB. Skipped 1." */
export function reportSaid(answer: RemoveAnswer): string {
  const bytes = answer.removed.reduce((sum, one) => sum + (one.bytes ?? 0), 0)
  const removed = answer.removed.length
    ? `Removed ${plural(answer.removed.length, 'worktree')}${bytes > 0 ? `, freeing ${bytesSaid(bytes)}` : ''}.`
    : 'Nothing was removed.'
  return answer.skipped.length ? `${removed} Skipped ${answer.skipped.length}.` : removed
}

const OPEN_EVENT = 'kehikot:worktrees'

/** Open the cleanup dialog, wherever it is mounted (the projects menu holds it). */
export function openWorktrees(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_EVENT))
}

/** Listen for `openWorktrees`. Returns the unlisten. */
export function onOpenWorktrees(then: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(OPEN_EVENT, then)
  return () => window.removeEventListener(OPEN_EVENT, then)
}
