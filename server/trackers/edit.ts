import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { LIMITS, TRACKERS, type Tracker } from 'kehikot-module-protocol'

import { configFile, EVERY_DEFAULT, listSources, readConfig, sourceKey, sourceOfRemote, splitRemote, type Listed } from './sources.ts'

/**
 * The one writer of a project's `.kehikot/kehikko/trackers.json`.
 *
 * One edit at a time, read-modify-write and synchronous (nothing can write
 * between the read and the rename), the whole file kept — keys this host does
 * not know stay where they were — and written only when something changed.
 * The file travels with the repository, so it is kept tidy: known keys in a
 * stable order, two-space indentation, one entry's keys in a stable order.
 *
 * ## What `off` is
 *
 * A source that comes from a git remote cannot be removed from a file it is
 * not in. Turning it off writes an entry with `"off": true`; turning it back
 * on takes the entry's flag away (and the entry, when nothing else is in it).
 * A source somebody added is removed from the file instead.
 */

export type Edit =
  | { kind: 'add'; input: string; tracker?: Tracker; host?: string; default?: boolean; list?: boolean }
  | { kind: 'remove'; tracker: Tracker; host: string; repo: string }
  | { kind: 'set'; tracker: Tracker; host: string; repo: string; default?: boolean; list?: boolean; off?: boolean }
  | { kind: 'schedule'; every: number }
  | { kind: 'remotes'; on: boolean }

export interface Edited {
  /** `changed` and `unchanged` are answers; `declined` is a sentence and nothing written. */
  outcome: 'changed' | 'unchanged' | 'declined'
  why: string
  /** What the edit now says, in words. */
  said: string
}

/** What a person typed, as a source: the repository, and which tracker and host it is on. */
export type Spelled =
  | { ok: true; tracker: Tracker; host: string; repo: string }
  | { ok: false; why: string; needs?: 'tracker' }

const NAME = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/
const HOST = /^[A-Za-z0-9.-]+(?::\d+)?$/
const usual = (tracker: Tracker) => (tracker === 'github' ? 'github.com' : 'gitlab.com')

/**
 * What somebody typed or pasted into "add a source", as a source.
 *
 * A repository URL of any form `git` takes (the tracker is told by the host
 * name, as a remote's is) — or `owner/repo`, `group/subgroup/repo`, which needs
 * the tracker named, and the host for a GitLab that is not gitlab.com. A URL
 * on a host this cannot tell asks for the tracker too.
 */
export function spell(input: string, tracker?: Tracker, host?: string): Spelled {
  const text = input.trim().replace(/^(?:git\s+clone\s+)/, '')
  if (!text) return { ok: false, why: 'Say which repository: a link like https://github.com/owner/repo, or owner/repo.' }
  const asked = host?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') || undefined
  if (asked && !HOST.test(asked)) return { ok: false, why: `${asked} is not a host name.` }

  const url = /^(?:https?:\/\/|ssh:\/\/|[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:)/.test(text)
  if (url) {
    const found = sourceOfRemote(text)
    if (found) {
      /* The person's own choice of tracker overrides what the name suggests. */
      return { ok: true, tracker: found.tracker, host: found.host, repo: found.repo }
    }
    const split = splitRemote(text)
    if (!split) return { ok: false, why: `That does not look like a repository link. Try https://github.com/owner/repo or git@host:group/project.git.` }
    if (!tracker) return { ok: false, needs: 'tracker', why: `Is ${split.host} a GitHub or a GitLab?` }
    return { ok: true, tracker, host: split.host.replace(/:\d+$/, ''), repo: split.repo }
  }

  const repo = text.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  if (!NAME.test(repo) || repo.length > LIMITS.TRACKER_REPO) {
    return { ok: false, why: 'A repository is written owner/repo, or group/subgroup/repo, or is a link to one.' }
  }
  if (!tracker) return { ok: false, needs: 'tracker', why: 'Is it on GitHub or GitLab?' }
  if (tracker === 'github' && repo.split('/').length !== 2) {
    return { ok: false, why: 'A GitHub repository is owner/repo — two parts.' }
  }
  const at = asked ?? usual(tracker)
  if (tracker === 'github' && at !== 'github.com' && !asked) return { ok: false, why: 'Which GitHub host?' }
  return { ok: true, tracker, host: at, repo }
}

/**
 * What a failed read means to a person, and the next step, from the sentence
 * the adapters already make (`trouble` in `common.ts`).
 *
 * The host cannot log anybody in: `gh auth login` and `glab auth login` are
 * interactive, and this host has no terminal to give them. So it says so, and
 * what to do once.
 */
export function nextStep(why: string, tracker: Tracker, host: string): string {
  const cli = tracker === 'github' ? 'gh' : 'glab'
  const login = `${cli} auth login${tracker === 'gitlab' && host !== 'gitlab.com' ? ` --hostname ${host}` : ''}`
  if (/is not installed/.test(why)) {
    const where = tracker === 'github' ? 'https://cli.github.com' : 'https://gitlab.com/gitlab-org/cli'
    return `${why} Install it (${where}; on a Mac, \`brew install ${cli === 'gh' ? 'gh' : 'glab'}\`), run \`${login}\` in a terminal once, then press Check again.`
  }
  if (/is not logged in/.test(why)) {
    return `${cli === 'gh' ? 'The GitHub CLI (gh)' : 'The GitLab CLI (glab)'} is not logged in to ${host}. Run \`${login}\` in a terminal once, then press Check again. Kehikot cannot log in for you: the login asks questions only a terminal can.`
  }
  if (/has no repository it will show/.test(why)) {
    return `${host} has no repository by that name that your login can see. Check the spelling, and that the account ${cli} is logged in as has access to it, then press Check again.`
  }
  if (/could not be reached|did not answer/.test(why)) {
    return `${why} Check the network or VPN and the host name, then press Check again.`
  }
  return why
}

const ORDER = ['version', 'sources', 'remotes', 'every']
const ENTRY_ORDER = ['tracker', 'host', 'repo', 'default', 'list', 'off']

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const tidyEntry = (entry: Json): Json => {
  const out: Json = {}
  for (const key of ENTRY_ORDER) if (entry[key] !== undefined) out[key] = entry[key]
  for (const key of Object.keys(entry)) if (!(key in out)) out[key] = entry[key]
  return out
}
const tidyFile = (file: Json): Json => {
  const out: Json = {}
  for (const key of ORDER) if (file[key] !== undefined) out[key] = file[key]
  for (const key of Object.keys(file)) if (!(key in out)) out[key] = file[key]
  return out
}

const entryKey = (entry: Json) =>
  sourceKey({
    tracker: entry.tracker as Tracker,
    host: typeof entry.host === 'string' ? entry.host : usual(entry.tracker as Tracker),
    repo: String(entry.repo),
  })

/** Only a flag-less entry for a remote's repository says nothing: it is not kept. */
const bare = (entry: Json) => Object.keys(entry).every((k) => ['tracker', 'host', 'repo'].includes(k))

/**
 * Make one edit. `remotes` are the project's git remotes (name and URL), which
 * the writer needs to know what a source comes from. Never throws; every
 * refusal is a sentence and writes nothing.
 */
export function editTrackers(
  root: string | null | undefined,
  edit: Edit,
  remotes: ReadonlyArray<{ name: string; url: string }>,
): Edited {
  const declined = (why: string): Edited => ({ outcome: 'declined', why, said: '' })
  const file = configFile(root)
  if (!root || !file) return declined('There is no project to keep tracker sources in.')

  const read = readConfig(root)
  if (!read.ok) {
    return declined(`${file} will not read (${read.why}), and this host will not write over a file it cannot read. Start it fresh from the tracker panel, which keeps the old one as trackers.json.broken.`)
  }
  let raw: Json = { version: 1 }
  let existed = false
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!isObject(parsed)) return declined(`${file} is not an object, and this host will not write over it.`)
      raw = parsed
      existed = true
    } catch {
      return declined(`${file} could not be read as JSON.`)
    }
  }
  const before = structuredClone(raw)
  const next: Json = { ...raw }
  const entries: Json[] = (Array.isArray(next.sources) ? next.sources : []).filter(isObject).map((e) => ({ ...e }))
  const shown: Listed[] = listSources(read.config, remotes)
  const at = (tracker: Tracker, host: string, repo: string) =>
    shown.find((s) => sourceKey(s) === sourceKey({ tracker, host, repo }))
  const entryAt = (tracker: Tracker, host: string, repo: string) =>
    entries.findIndex((e) => entryKey(e) === sourceKey({ tracker, host, repo }))
  const hostField = (tracker: Tracker, host: string): Json => (host.toLowerCase() === usual(tracker) ? {} : { host })
  let said = ''

  /** One default per tracker: the others' flag goes, the file's choice is this one's. */
  const makeDefault = (tracker: Tracker, key: string) => {
    for (const e of entries) if (e.tracker === tracker && entryKey(e) !== key) delete e.default
  }

  if (edit.kind === 'add') {
    const spelled = spell(edit.input, edit.tracker, edit.host)
    if (!spelled.ok) return declined(spelled.why)
    const { tracker, host, repo } = spelled
    const there = at(tracker, host, repo)
    const i = entryAt(tracker, host, repo)
    if (there && !there.off) return { outcome: 'unchanged', why: `${repo} is already one of this project's sources.`, said: `${repo} is already a source.` }
    if (there && there.off && i >= 0) {
      /* Adding what was turned off is turning it back on. */
      delete entries[i]!.off
      if (edit.default) {
        entries[i]!.default = true
        makeDefault(tracker, entryKey(entries[i]!))
      }
      if (bare(entries[i]!) && there.origin === 'remote') entries.splice(i, 1)
      said = `${repo} is read again.`
    } else {
      if (shown.filter((s) => !s.off).length + entries.filter((e) => e.off).length >= LIMITS.TRACKER_SOURCES) {
        return declined(`A project reads at most ${LIMITS.TRACKER_SOURCES} sources.`)
      }
      const entry: Json = { tracker, ...hostField(tracker, host), repo }
      if (edit.default) entry.default = true
      if (edit.list !== undefined) entry.list = edit.list
      else entry.list = true
      entries.push(entry)
      if (edit.default) makeDefault(tracker, entryKey(entry))
      said = `${repo} is added.`
    }
  } else if (edit.kind === 'remove') {
    const there = at(edit.tracker, edit.host, edit.repo)
    const i = entryAt(edit.tracker, edit.host, edit.repo)
    if (!there) return declined(`${edit.repo} is not one of this project's sources.`)
    if (there.origin === 'remote') {
      return declined(
        `${edit.repo} comes from this project's git remote ${there.remote ?? ''}, so it cannot be removed from the file. Turn it off instead; it can be turned back on.`.replace('  ', ' '),
      )
    }
    if (i >= 0) entries.splice(i, 1)
    said = `${edit.repo} is removed.`
  } else if (edit.kind === 'set') {
    const there = at(edit.tracker, edit.host, edit.repo)
    if (!there) return declined(`${edit.repo} is not one of this project's sources.`)
    if (edit.off === true && there.origin === 'file') {
      return declined(`${edit.repo} was added by you, so there is nothing to turn off — remove it instead.`)
    }
    let i = entryAt(edit.tracker, edit.host, edit.repo)
    if (i < 0) {
      entries.push({ tracker: edit.tracker, ...hostField(edit.tracker, edit.host), repo: edit.repo })
      i = entries.length - 1
    }
    const e = entries[i]!
    if (edit.off !== undefined) {
      if (edit.off) {
        e.off = true
        delete e.default
      } else delete e.off
    }
    if (edit.default !== undefined && !(edit.off === true)) {
      if (there.off && edit.off !== false && edit.default) {
        return declined(`${edit.repo} is turned off; turn it back on before making it the default.`)
      }
      if (edit.default) {
        e.default = true
        makeDefault(edit.tracker, entryKey(e))
      } else delete e.default
    }
    if (edit.list !== undefined) {
      /* A remote's listing is on unless it says otherwise; an added one's, off. */
      if (there.origin === 'remote' && edit.list) delete e.list
      else e.list = edit.list
    }
    if (bare(e) && there.origin === 'remote') entries.splice(i, 1)
    said = `${edit.repo}${edit.off === true ? ' is turned off' : edit.off === false ? ' is read again' : ' is changed'}.`
  } else if (edit.kind === 'schedule') {
    if (!Number.isInteger(edit.every) || edit.every < 0 || edit.every > 24 * 60) {
      return declined('How often is minutes, from 0 (never on its own) to 1440.')
    }
    next.every = edit.every
    said = edit.every === 0 ? 'The host no longer reads on its own.' : `The host reads again every ${edit.every} minutes while somebody is looking.`
  } else {
    next.remotes = edit.on
    said = edit.on ? "This project's git remotes are read." : "This project's git remotes are not read; only the sources listed here are."
  }

  const sources = entries.map(tidyEntry)
  const wrote: Json = { ...next }
  if (sources.length || Array.isArray(raw.sources)) wrote.sources = sources
  if (wrote.version === undefined) wrote.version = 1
  /* A schedule at its default, and remotes on, are what an absent key says;
     a key somebody wrote stays as they wrote it. */
  const tidy = tidyFile(wrote)
  if (existed ? isDeepStrictEqual(before, tidy) : isDeepStrictEqual({ version: 1 }, tidy) || isDeepStrictEqual({ version: 1, sources: [] }, tidy)) {
    return { outcome: 'unchanged', why: '', said: `Nothing changed: ${said.replace(/\.$/, '')} already.` }
  }
  mkdirSync(dirname(file), { recursive: true })
  const beside = `${file}.tmp-${process.pid}`
  try {
    writeFileSync(beside, `${JSON.stringify(tidy, null, 2)}\n`, 'utf8')
    renameSync(beside, file)
  } catch (error) {
    try {
      unlinkSync(beside)
    } catch {
      /* It was never made. */
    }
    return declined(`trackers.json could not be written: ${(error as Error).message}`)
  }
  return { outcome: 'changed', why: '', said }
}

/** A file that will not read, set aside as `.broken` and the project started fresh. */
export function startFresh(root: string | null | undefined): Edited {
  const file = configFile(root)
  if (!file || !existsSync(file)) return { outcome: 'unchanged', why: '', said: 'There is no tracker file to set aside.' }
  const aside = `${file}.broken`
  try {
    renameSync(file, aside)
  } catch (error) {
    return { outcome: 'declined', why: `The file could not be set aside: ${(error as Error).message}`, said: '' }
  }
  return { outcome: 'changed', why: '', said: `The old file is kept as ${aside}. This project reads its git remotes again.` }
}

export { EVERY_DEFAULT, TRACKERS }
