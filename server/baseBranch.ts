import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { explainGitFailure } from './gitAuth.ts'
import { spawnRunner, type Runner } from './feedback.ts'
import { hostPath } from './hostData.ts'
import { makeUnderRoot, projectRootExists, projectWritable, refusedSaid } from './projectRoot.ts'
import { QUIET_ENV } from './updates.ts'

/**
 * A project's base branch: the branch agents start their work from and
 * updates are pulled from — `development` for one project, `main` for most.
 *
 * Kept in `<project>/.kehikot/host/settings.json` (`{ "version": 1,
 * "baseBranch": "development" }`), which travels with the repository: it is
 * a fact about the project that everyone working on it shares, not about one
 * person's machine. `setBaseBranch` is the one writer; keys it does not know
 * are kept. Nothing set is origin's own default branch (`origin/HEAD`), read
 * from the project's git on each ask and never written down.
 */

export const SETTINGS_FILE = 'settings.json'
const VERSION = 1
const NAME_MAX = 200
const DEFAULT_TTL_MS = 30_000

export interface BaseBranch {
  /** What the project's settings say, or null when nobody set one. */
  set: string | null
  /** Origin's default branch (`origin/HEAD`), or null when git cannot say. */
  origin: string | null
  /** The one in force: `set`, else `origin`. */
  branch: string | null
}

export type BaseBranchEdited =
  | { outcome: 'changed' | 'unchanged'; said: string; base: BaseBranch }
  | { outcome: 'declined'; why: string }

export function settingsFile(root: string | null | undefined): string | null {
  return hostPath(root, SETTINGS_FILE)
}

type Held = Record<string, unknown>

/** The settings file as an object: `{}` when there is none, null when it does not read. */
function readHeld(root: string): Held | null {
  const file = settingsFile(root)
  if (!file || !existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Held) : null
  } catch {
    return null
  }
}

/** The base branch the project's settings name, or null: none set, or a file that will not read. */
export function readBaseBranch(root: string | null | undefined): string | null {
  if (typeof root !== 'string' || !root || !projectRootExists(root)) return null
  const named = readHeld(root)?.baseBranch
  return typeof named === 'string' && branchNameProblem(named) === null ? named : null
}

/**
 * Why `name` cannot be a branch, or null when it can: git's rules for a ref
 * name (`git check-ref-format --branch`), checked here so nothing a page sends
 * reaches git as an option or a pattern.
 */
export function branchNameProblem(name: string): string | null {
  if (!name) return 'Say which branch.'
  if (name.length > NAME_MAX) return `A branch name is at most ${NAME_MAX} characters.`
  const bad =
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock') ||
    name === '@' ||
    name === 'HEAD' ||
    name.includes('..') ||
    name.includes('//') ||
    name.includes('@{') ||
    name.split('/').some((part) => part.startsWith('.')) ||
    /[\u0000- \u007f~^:?*[\\]/.test(name)
  return bad ? `${name} is not a branch name git would take.` : null
}

const defaults = new Map<string, { origin: string | null; at: number }>()

/** Forget the default branches read so far; for tests. */
export function forgetOriginDefaults(): void {
  defaults.clear()
}

/**
 * Origin's default branch, as the project's git last heard it
 * (`refs/remotes/origin/HEAD`, set by a clone or `git remote set-head`).
 * Local and quick, and remembered for a few seconds, since every list of the
 * projects asks.
 */
export function originDefault(root: string, read: (root: string) => string | null = symbolicOriginHead, now = Date.now()): string | null {
  const known = defaults.get(root)
  if (known && now - known.at < DEFAULT_TTL_MS) return known.origin
  const origin = read(root)
  defaults.set(root, { origin, at: now })
  return origin
}

function symbolicOriginHead(root: string): string | null {
  try {
    const run = Bun.spawnSync(['git', '-C', root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
      env: QUIET_ENV,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (run.exitCode !== 0) return null
    const short = run.stdout.toString().trim()
    return short.startsWith('origin/') && short.length > 'origin/'.length ? short.slice('origin/'.length) : null
  } catch {
    return null
  }
}

export function baseBranchOf(root: string, read?: (root: string) => string | null): BaseBranch {
  const set = readBaseBranch(root)
  const origin = projectRootExists(root) ? originDefault(root, read) : null
  return { set, origin, branch: set ?? origin }
}

export type OnOrigin = { ok: true; note: string | null } | { ok: false; why: string }

/**
 * Whether origin has `branch`, asked of origin itself with the person's own
 * credentials (`git ls-remote`). When origin cannot be reached, its last
 * fetch answers instead, and the answer says so.
 */
export async function checkOnOrigin(root: string, branch: string, run: Runner = spawnRunner): Promise<OnOrigin> {
  const remote = await run(['git', '-C', root, 'remote', 'get-url', 'origin'], { timeout: 5_000 })
  if (remote.missing) return { ok: false, why: 'git is not installed here, so Kehikot cannot check the branch.' }
  if (remote.code !== 0) return { ok: false, why: `This project has no remote called origin, so Kehikot cannot check that ${branch} is there.` }

  const asked = await run(['git', '-C', root, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], { timeout: 15_000 })
  if (asked.code === 0) return { ok: true, note: null }
  if (asked.code === 2) return { ok: false, why: `origin has no branch called ${branch}. Push it first, or name a branch origin has.` }

  /* Why it failed, plainly: a locked key or a missing sign-in is not "could not be reached". */
  const url = remote.out.trim()
  const reason = explainGitFailure(asked.err, url)
  const cause = reason ? reason.said : 'origin could not be reached.'

  const fetched = await run(['git', '-C', root, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { timeout: 5_000 })
  if (fetched.code === 0) {
    return reason
      ? { ok: true, note: `${cause} This was checked against origin's last fetch instead, which has ${branch}.` }
      : { ok: true, note: `origin could not be reached, so this was checked against its last fetch, which has ${branch}.` }
  }
  return reason
    ? { ok: false, why: `${cause} Its last fetch has no branch called ${branch}.` }
    : { ok: false, why: `origin could not be reached, and its last fetch has no branch called ${branch}.` }
}

function baseSaid(base: BaseBranch): string {
  if (base.set) return `The base branch is ${base.set}.`
  if (base.origin) return `The base branch is origin's default, ${base.origin}.`
  return 'No base branch is set, and origin does not say its default.'
}

/**
 * Set the project's base branch, or with null go back to origin's default.
 * A branch is checked against origin first; a refusal is a sentence and
 * nothing written.
 */
export async function setBaseBranch(
  root: string,
  asked: string | null,
  run: Runner = spawnRunner,
  read?: (root: string) => string | null,
): Promise<BaseBranchEdited> {
  if (!projectWritable(root)) return { outcome: 'declined', why: `${refusedSaid(root)} The base branch was not changed.` }
  const held = readHeld(root)
  if (held === null) return { outcome: 'declined', why: `.kehikot/host/${SETTINGS_FILE} does not read as JSON, so it was left as it is. Fix or delete it first.` }

  const branch = asked === null ? null : asked.trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '')
  let note: string | null = null
  if (branch !== null) {
    const problem = branchNameProblem(branch)
    if (problem) return { outcome: 'declined', why: problem }
    const there = await checkOnOrigin(root, branch, run)
    if (!there.ok) return { outcome: 'declined', why: `${there.why} The base branch was not changed.` }
    note = there.note
  }

  const before = typeof held.baseBranch === 'string' ? held.baseBranch : null
  if (before === branch) {
    const base = baseBranchOf(root, read)
    return { outcome: 'unchanged', said: `Nothing changed. ${baseSaid(base)}`, base }
  }

  /* A newer host's version of the file is kept as it wrote it, so an older one never downgrades it. */
  const kept = typeof held.version === 'number' && held.version > VERSION ? held.version : VERSION
  const rest: Held = { ...held }
  delete rest.baseBranch
  const next: Held = branch === null ? rest : { ...rest, baseBranch: branch }
  const file = settingsFile(root)!
  const beside = `${file}.tmp-${process.pid}`
  try {
    if (Object.keys(next).every((key) => key === 'version')) {
      if (existsSync(file)) unlinkSync(file)
    } else {
      if (!makeUnderRoot(root, dirname(file))) return { outcome: 'declined', why: `${refusedSaid(root)} The base branch was not changed.` }
      writeFileSync(beside, `${JSON.stringify(Object.assign({ version: VERSION }, next, { version: kept }), null, 2)}\n`, 'utf8')
      renameSync(beside, file)
    }
  } catch (error) {
    try {
      unlinkSync(beside)
    } catch {
      /* It was never made. */
    }
    return { outcome: 'declined', why: `.kehikot/host/${SETTINGS_FILE} could not be written: ${(error as Error).message}` }
  }
  const base = baseBranchOf(root, read)
  return { outcome: 'changed', said: [baseSaid(base), note].filter(Boolean).join(' '), base }
}
