import { holdsLiveSessions } from 'kehikot-module-protocol'

import { releaseVersion, type ModuleRelease } from './moduleReleases.ts'

/**
 * Modules keep themselves up to date — the rule and the words, shared by the
 * server (`server/autoUpdates.ts`, which acts), the Updates menu, Settings and
 * What's new. Pure: nothing here runs git, starts a process or asks GitHub.
 *
 * ## The switch
 *
 * "Keep modules up to date automatically": machine-wide, one row of
 * `settings` in `frame.sqlite`, on unless the person turned it off — for a new
 * install and for one that had this before the switch existed alike. Off is
 * exactly the behaviour before it: every update waits for a press.
 *
 * ## What on does
 *
 * Every update check that already happens (the page's quiet check, Check now,
 * the check beside a start) that finds a newer release an installed copy can
 * run takes it: the same `update()` a press runs — checkout, `bun install`,
 * build — in the background. When it is put in place is `decide`:
 *
 * | the module is…                                   | it updates…                                 |
 * | ------------------------------------------------ | ------------------------------------------- |
 * | not running                                      | now                                         |
 * | running, not on the kehikko anybody has open     | now (restarted quietly; nobody is looking)  |
 * | running and on screen                            | when it is next off screen, or at restart   |
 * | holding shells or agent sessions, or kept        | when it next stops                          |
 * | pinned in a container                            | never by itself: the pin is the person's    |
 * | only newer releases that need a newer Kehikot    | never: it waits for the app                 |
 * | a checkout somebody registered (not installed)   | never                                       |
 * | refused by `update` (changes of its own…)        | never: it says why                          |
 * | failed at this release                           | at the next check, not before               |
 *
 * A major version jump (1.x → 2.0) is taken like any other — a release is
 * what its author published as working — and What's new says it prominently.
 * It does not ask: knowing whether its notes say "breaking" would cost a
 * GitHub read on every check, which the request budget does not allow.
 */

export const AUTO_UPDATES = {
  label: 'Keep modules up to date automatically',
  description:
    'A newer release of an installed module is downloaded, installed and built in the background. A module you are looking at, or one holding sessions, updates once you leave it or it stops. Pinned modules are left alone.',
  /** What the Updates menu's toggle says, in a narrower place. */
  short: 'Update modules automatically',
} as const

export const AUTO_UPDATES_DEFAULT = true

/**
 * How long a module whose automatic update failed is left before one is tried
 * again — just under the page's background check (every half hour), so the
 * retry is the next check's, and a focus or a second window does not make it
 * a loop.
 */
export const RETRY_AFTER_MS = 25 * 60_000

/** Why an update the switch would take is not being put in place now. */
export type Until =
  /** On the kehikko somebody has open: when they leave it, or at the next restart. */
  | 'off-screen'
  /** Holding live work, or kept by its registration: when it next stops. */
  | 'stopped'
  /** Its newer releases need a newer Kehikot. */
  | 'app'
  /** A container is pinned to a version of it. */
  | 'pinned'
  /** `update` would refuse it (`blocked`). */
  | 'held'
  /** The last try failed: at the next check. */
  | 'retry'

export interface AutoWait {
  until: Until
  /** The release it would move to; for `app`, the release that needs the newer Kehikot. */
  target: string | null
  /**
   * What the words need: the Kehikot version for `app` (empty when not known),
   * the pinned versions for `pinned`, the refusal for `held`, the failure for
   * `retry`. Null otherwise.
   */
  detail: string | null
  /** For `stopped`: it holds shells or agent sessions, rather than being kept. */
  shells?: boolean
  /** The move is to a new major version. */
  major?: boolean
}

/** One update the switch made. */
export interface AutoDone {
  id: string
  name: string
  /** `1.5.0`, or null when it left `main`. */
  from: string | null
  to: string
  /** ISO time it finished. */
  at: string
  major: boolean
}

/** What `GET /host/updates` says about the switch (`auto`). */
export interface AutoTold {
  on: boolean
  /** By module id: why its update is not being put in place now. */
  waiting: Record<string, AutoWait>
  /** The updates it made since this host started, newest first. */
  updated: AutoDone[]
}

/** Everything `decide` may consider about one module, gathered by the server. */
export interface Candidate {
  /** The switch. */
  on: boolean
  /** An installed copy (under `installed/`), not a checkout somebody edits. */
  installed: boolean
  /** Its copy as the check read it; null when it could not be read. */
  reading: { release?: ModuleRelease; blocked: string | null } | null
  /** The versions containers pin it to; empty when none. */
  pinned: readonly string[]
  /** Something answers for it, or this host holds its process. */
  running: boolean
  /** On a kehikko a live page has open. */
  onScreen: boolean
  /** Its manifest says it holds live sessions (`holdsShells`): a restart ends the shells or sessions in it. */
  holdsShells: boolean
  /** Its registration says `keep`: this host never stops it. */
  kept: boolean
  /** A person's update, or another, is running on it now. */
  busy: boolean
  /** The last automatic try that failed, at which release and when. */
  failed: { target: string; at: number; why: string } | null
  /** Whether this is a check (which may retry a failure) rather than a re-decision on a move. */
  checking: boolean
  now: number
}

export type Decision =
  | { do: 'nothing' }
  | { do: 'now'; target: string; major: boolean }
  | ({ do: 'wait' } & AutoWait)

function majorOf(tag: string | null): number | null {
  const m = tag ? /^v?(\d+)\./.exec(tag) : null
  return m ? Number(m[1]) : null
}

/** Whether moving from one release to another changes the major version. From `main` (null) it is not. */
export function isMajor(from: string | null, to: string): boolean {
  const a = majorOf(from)
  const b = majorOf(to)
  return a !== null && b !== null && b > a
}

/** The Kehikot version a release that needs a newer app waits for: the first app that meets it, or '' when not known. */
function appFor(release: ModuleRelease): string {
  const tag = release.needsNewer?.tag
  const works = tag && release.works && Object.hasOwn(release.works, tag) ? release.works[tag]! : null
  return works?.kind === 'from' && works.from ? works.from : ''
}

/**
 * Whether the switch takes this module's update, and when. See the table above;
 * the order of the rules is the order of the table's exceptions.
 */
export function decide(c: Candidate): Decision {
  if (!c.on || !c.installed || !c.reading || c.busy) return { do: 'nothing' }
  const release = c.reading.release
  /* Only a copy that runs releases: one following `main` (no release yet) waits for a press, as before. */
  if (!release || release.follows === 'main') return { do: 'nothing' }
  const target = release.target
  if (!target) {
    return release.needsNewer ? { do: 'wait', until: 'app', target: release.needsNewer.tag, detail: appFor(release) } : { do: 'nothing' }
  }
  const major = isMajor(release.installed, target)
  if (c.pinned.length) return { do: 'wait', until: 'pinned', target, detail: c.pinned.join(', '), major }
  if (c.reading.blocked) return { do: 'wait', until: 'held', target, detail: c.reading.blocked, major }
  if (c.failed && c.failed.target === target && (!c.checking || c.now - c.failed.at < RETRY_AFTER_MS)) {
    return { do: 'wait', until: 'retry', target, detail: c.failed.why, major }
  }
  if (c.running && (c.holdsShells || c.kept)) return { do: 'wait', until: 'stopped', target, detail: null, shells: c.holdsShells, major }
  if (c.running && c.onScreen) return { do: 'wait', until: 'off-screen', target, detail: null, major }
  return { do: 'now', target, major }
}

/**
 * Compatibility, not a rule: the modules that held live sessions before a manifest could say so
 * (protocol 2.33.0, `holds`). A copy of one of them released before it says nothing, and the
 * update that brings the declaration must not be the restart that ends its sessions, so a module
 * that says NOTHING about `holds` and has one of these ids is read as holding them.
 *
 * Remove when every copy an app can still be running declares it: once the `modules.json` entries
 * for these three give `protocol: "2.33.0"` or later, or a host release has shipped after their
 * releases declaring `holds: ['live-sessions']` have been on `main` for a full update cycle.
 */
const HELD_SESSIONS_BEFORE_2_33: ReadonlySet<string> = new Set(['kehikot.terminal', 'kehikot.claude', 'kehikot.codex'])

/**
 * Whether restarting a module ends live shells or agent sessions in it: its manifest says
 * `holds: ['live-sessions']` (protocol 2.33.0). Shared with the Updates menu's "Restart now (ends
 * its shells)". `holds` absent (an older copy, or not read yet) falls back to
 * `HELD_SESSIONS_BEFORE_2_33`; a manifest that says `holds` without the word holds nothing.
 */
export function holdsShells(module: { id: string; holds?: readonly string[] | null }): boolean {
  if (holdsLiveSessions(module)) return true
  return module.holds == null && HELD_SESSIONS_BEFORE_2_33.has(module.id)
}

/** The sentence for a module whose update waits: "Terminal updates when its sessions end". */
export function waitSaid(name: string, wait: AutoWait): string {
  const to = wait.target ? releaseVersion(wait.target) : null
  switch (wait.until) {
    case 'off-screen':
      return `${name} updates when you leave its kehikko`
    case 'stopped':
      return wait.shells ? `${name} updates when its sessions end` : `${name} updates when it next stops`
    case 'app':
      return wait.detail ? `${name} waits for Kehikot ${wait.detail}` : `${name} waits for a newer Kehikot`
    case 'pinned':
      return `${name} is pinned to ${wait.detail ?? 'a version'}, so it is not updated automatically`
    case 'held':
      return `${name} is not updated automatically: ${wait.detail ?? 'its copy has changes of its own'}`
    case 'retry':
      return `${name} could not be updated${to ? ` to ${to}` : ''}${wait.detail ? `: ${wait.detail.replace(/[.\s]+$/, '')}` : ''}. It is tried again at the next check.`
  }
}

/** "Journeys 1.5.0 → 1.6.0", for an "Updated automatically" row. */
export function doneSaid(done: AutoDone): string {
  return `${done.name} ${done.from ?? 'main'} → ${done.to}`
}

/** The announcement What's new makes once, to an install that had modules before the switch. */
export const AUTO_UPDATES_NOTE = 'auto-updates'
export const AUTO_UPDATES_ANNOUNCED = {
  title: 'Modules now update themselves',
  body: 'New module releases are installed in the background. Turn it off in Settings › Modules, or at the top of the Updates menu.',
} as const
