/**
 * Which Kehikot apps a module release works with, in words — shared by the
 * server (`server/appProtocols.ts` reads the apps, `server/moduleReleases.ts`
 * says it per release), the Updates menu, "What's new", the modules list and
 * the MCP door. Pure: nothing here asks git or GitHub.
 *
 * ## How it is known
 *
 * A module release pins the protocol package in its `package.json`
 * (`kehikot-module-protocol` … `#v2.6.0`), and the official list may add a
 * floor (`protocol`): that is what the release NEEDS. Every Kehikot app release
 * tags the host commit it was built from (`app-v0.1.39` in Jalez/kehikko), and
 * that commit's `package.json` says which protocol package the app SHIPPED. So
 * the first app whose protocol meets the need is the first Kehikot the release
 * works with.
 *
 * ## Same major, and no further
 *
 * A module built against protocol 2.x is built against 2.x: when Kehikot moves
 * to protocol 3, nothing promises it still runs. The upper bound is said only
 * when an app on a higher major EXISTS — "Works with Kehikot 0.1.15 to 0.1.21
 * (0.1.22 moved to protocol 2)". Before that it is "and later": nobody knows
 * which app will be the first on 3.
 *
 * ## When it cannot be known
 *
 * Offline with nothing cached, or a repository with no app tags: then the
 * apps are unknown, and the sentence says the protocol it needs — "Needs
 * protocol 2.6 or later" — never a guessed app version.
 */

/** One Kehikot app release and the protocol package it shipped: `{ app: '0.1.39', protocol: '2.10.0' }`. */
export interface AppProtocol {
  app: string
  protocol: string
}

export type WorksWith =
  /** The first app that meets `need`; `until` when an app on a later major exists. */
  | { kind: 'from'; need: string; from: string; until: { last: string; next: string; major: number } | null }
  /** No app released yet has the protocol it needs; `newest` is the newest app there is. */
  | { kind: 'unreleased'; need: string; newest: AppProtocol }
  /** Built for a protocol major no app shipped (older than every app on record). */
  | { kind: 'none'; need: string }
  /** The apps could not be read: only the protocol is known. */
  | { kind: 'unknown'; need: string }

const TRIPLE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/

function triple(version: string): [number, number, number] | null {
  const m = TRIPLE.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Negative when `a` is older than `b`; versions that do not read sort first. */
export function compareVersions(a: string, b: string): number {
  const x = triple(a) ?? [-1, -1, -1]
  const y = triple(b) ?? [-1, -1, -1]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

/** Whether protocol `have` runs a release that needs `need`: the same major, and not older. */
export function satisfies(need: string, have: string): boolean {
  const n = triple(need)
  const h = triple(have)
  if (!n || !h || n[0] !== h[0]) return false
  return compareVersions(have, need) >= 0
}

/** `2.6.0` → `2.6`; `2.6.1` stays. What a person is told a protocol is. */
export function protocolSaid(version: string): string {
  const t = triple(version)
  if (!t) return version
  return t[2] === 0 ? `${t[0]}.${t[1]}` : version
}

/** The higher of two protocol needs, either of which may be missing. */
export function higherNeed(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null
  if (!b) return a
  return compareVersions(a, b) >= 0 ? a : b
}

/** Oldest app first, one row per app, only versions that read. */
export function appsInOrder(apps: readonly AppProtocol[]): AppProtocol[] {
  const seen = new Map<string, AppProtocol>()
  for (const one of apps) if (triple(one.app) && triple(one.protocol)) seen.set(one.app, one)
  return [...seen.values()].sort((a, b) => compareVersions(a.app, b.app))
}

/** Which apps a release that needs `need` works with. `apps` null or empty: not known. */
export function worksWith(need: string, apps: readonly AppProtocol[] | null): WorksWith {
  const major = triple(need)?.[0]
  if (!apps || apps.length === 0 || major === undefined) return { kind: 'unknown', need }
  const ordered = appsInOrder(apps)
  if (ordered.length === 0) return { kind: 'unknown', need }
  const first = ordered.find((one) => satisfies(need, one.protocol))
  if (!first) {
    const newest = ordered[ordered.length - 1]!
    /* Every app is on an older major, or on this one and older: it needs one not released yet. */
    if (triple(newest.protocol)![0] <= major) return { kind: 'unreleased', need, newest }
    return { kind: 'none', need }
  }
  const at = ordered.indexOf(first)
  const next = ordered.slice(at + 1).find((one) => triple(one.protocol)![0] > major)
  if (!next) return { kind: 'from', need, from: first.app, until: null }
  const last = ordered[ordered.indexOf(next) - 1]!
  return { kind: 'from', need, from: first.app, until: { last: last.app, next: next.app, major: triple(next.protocol)![0] } }
}

/**
 * The sentence: "Works with Kehikot 0.1.39 and later", "Works with Kehikot
 * 0.1.15 to 0.1.21 (0.1.22 moved to protocol 2)", "Needs a Kehikot newer than
 * 0.1.41 (protocol 2.11 or later)", or, when the apps are not known, "Needs
 * protocol 2.6 or later".
 */
export function worksWithSaid(works: WorksWith): string {
  switch (works.kind) {
    case 'from':
      if (!works.until) return `Works with Kehikot ${works.from} and later`
      return `Works with Kehikot ${works.from === works.until.last ? works.from : `${works.from} to ${works.until.last}`} (${works.until.next} moved to protocol ${works.until.major})`
    case 'unreleased':
      return `Needs a Kehikot newer than ${works.newest.app} (protocol ${protocolSaid(works.need)} or later)`
    case 'none':
      return `Built for protocol ${protocolSaid(works.need)}, which no Kehikot release has`
    case 'unknown':
      return `Needs protocol ${protocolSaid(works.need)} or later`
  }
}

/**
 * A release this Kehikot cannot run, said with the app versions: "1.7.0 needs
 * Kehikot 0.1.41 or later; you have 0.1.40." `app` is the running app's
 * version when this page is inside the desktop app; without it, the host's
 * protocol is what there is to compare: "…; this Kehikot has protocol 2.10."
 */
export function needsKehikotSaid(version: string, works: WorksWith, have: { app?: string | null; protocol?: string | null } = {}): string {
  const youHave = have.app ? `you have ${have.app}` : have.protocol ? `this Kehikot has protocol ${protocolSaid(have.protocol)}` : null
  const tail = youHave ? `; ${youHave}.` : '.'
  switch (works.kind) {
    case 'from':
      return `${version} needs Kehikot ${works.from} or later${tail}`
    case 'unreleased':
      return `${version} needs a Kehikot newer than ${works.newest.app} (protocol ${protocolSaid(works.need)} or later)${tail}`
    case 'none':
    case 'unknown':
      return `${version} needs protocol ${protocolSaid(works.need)} or later${tail}`
  }
}
