import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { INTRO_FILE, INTRO_FILE_BYTES, introFromFile, introOf, type Intro } from 'kehikot-module-protocol'

import { newestFirst, type Runner } from './versions.ts'

/**
 * A module's own introduction (protocol 2.57.0), read WITHOUT running the module.
 *
 * ## Where an introduction is read from
 *
 * A person should be able to watch one before the module is started, placed or even installed, so
 * the page never asks the module. The server reads it, first that answers:
 *
 *  1. **The running module's manifest** (`intro`), as the sweep read it: the newest words.
 *  2. **The installed copy's `intro.json`** (`INTRO_FILE`), read as a file from the folder its
 *     registration names — the same folder `describeFolder` reads a sleeping module's manifest from.
 *     Nothing is run; a file over `INTRO_FILE_BYTES` is not read.
 *  3. **For a module on a list that is not installed: `intro.json` at the release an install would
 *     take** — the newest version tag in `git ls-remote --tags` (the repository's HEAD when it has
 *     none, as an install leaves it on `main`), then that commit's file through the person's own
 *     `gh api`, raw. Read-only, nothing cloned. A commit does not change, so a file read for one is
 *     kept for the life of the process; the tags are asked again after `TAGS_FOR_MS`.
 *
 * What comes back is `introFromFile` / `introOf`: plain text, bounded, every string one line. The
 * repository comes from the list on this side, never from a request.
 */

export const TAGS_FOR_MS = 10 * 60_000
export const READ_TIMEOUT_MS = 15_000
const COMMIT = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type IntroFrom = 'running' | 'installed' | 'release'

export interface IntroDeps {
  /** The running module's manifest as the sweep read it, or null. */
  running(id: string): { intro?: unknown } | null
  /** The folder the module's registration names, or null. */
  dir(id: string): string | null
  /** `owner/repo` on github.com for a listed module that could be installed, or null. */
  repo(id: string): string | null
  run: Runner
  read?(path: string): string | null
}

function readSmall(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length > INTRO_FILE_BYTES ? null : text
  } catch {
    return null
  }
}

/** The commit `ls-remote` names for the newest version tag (peeled when annotated), or HEAD's; null when it cannot say. */
export function releaseCommit(tagsOut: string, headOut: string | null): string | null {
  const commits = new Map<string, string>()
  const peeled = new Map<string, string>()
  for (const line of tagsOut.split('\n')) {
    const [sha, ref] = line.trim().split('\t')
    if (!sha || !ref || !COMMIT.test(sha) || !ref.startsWith('refs/tags/')) continue
    const name = ref.slice('refs/tags/'.length)
    if (name.endsWith('^{}')) peeled.set(name.slice(0, -3), sha)
    else commits.set(name, sha)
  }
  const newest = newestFirst([...commits.keys()])[0]
  if (newest) return peeled.get(newest) ?? commits.get(newest) ?? null
  const head = headOut?.split('\n').find((line) => line.trim().endsWith('\tHEAD'))?.split('\t')[0]?.trim()
  return head && COMMIT.test(head) ? head : null
}

export function moduleIntros(deps: IntroDeps) {
  const read = deps.read ?? readSmall
  const byCommit = new Map<string, Intro | null>()
  const tags = new Map<string, { commit: string | null; at: number }>()

  async function commitOf(repo: string): Promise<string | null> {
    const was = tags.get(repo)
    if (was && Date.now() - was.at < TAGS_FOR_MS) return was.commit
    const url = `https://github.com/${repo}.git`
    const listed = await deps.run(['git', 'ls-remote', '--tags', url], { timeoutMs: READ_TIMEOUT_MS })
    let commit: string | null = null
    if (listed.ok) {
      commit = releaseCommit(listed.out, null)
      if (!commit) {
        const head = await deps.run(['git', 'ls-remote', url, 'HEAD'], { timeoutMs: READ_TIMEOUT_MS })
        commit = head.ok ? releaseCommit('', head.out) : null
      }
    }
    tags.set(repo, { commit, at: Date.now() })
    return commit
  }

  async function atRelease(repo: string): Promise<Intro | null> {
    if (!REPO.test(repo)) return null
    const commit = await commitOf(repo)
    if (!commit) return null
    if (byCommit.has(commit)) return byCommit.get(commit) ?? null
    const ran = await deps.run(
      ['gh', 'api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${INTRO_FILE}?ref=${commit}`],
      { timeoutMs: READ_TIMEOUT_MS },
    )
    const intro = ran.ok ? introFromFile(ran.out) : null
    /* A refusal (no gh, no login, offline) is not remembered: the next opening asks again. */
    if (ran.ok) byCommit.set(commit, intro)
    return intro
  }

  return {
    /** The introduction for `id`, and where it was read; `{ intro: null, from: null }` when none could be. */
    async introFor(id: string): Promise<{ intro: Intro | null; from: IntroFrom | null }> {
      const running = introOf(deps.running(id))
      if (running) return { intro: running, from: 'running' }
      const dir = deps.dir(id)
      if (dir) {
        const installed = introFromFile(read(join(dir, INTRO_FILE)))
        return installed ? { intro: installed, from: 'installed' } : { intro: null, from: null }
      }
      const repo = deps.repo(id)
      if (!repo) return { intro: null, from: null }
      const released = await atRelease(repo)
      return released ? { intro: released, from: 'release' } : { intro: null, from: null }
    },
  }
}
