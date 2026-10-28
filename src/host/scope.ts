import {
  MODULE_SCOPES,
  SCOPE_MEANS,
  SCOPE_NAMES,
  activeScope,
  defaultScope,
  scopeNeedsEpic,
  supportedScopes,
  supportsScope,
  toldScope,
  type ContextScope,
  type ModuleScope,
} from 'kehikot-module-protocol'

/**
 * "All epics": the project about every epic at once (`context.scope:
 * 'project'`, protocol 2.9.0), and what the host does for a module that
 * cannot show that.
 *
 * ## The module says whether it can, and the host covers the rest
 *
 * A module lists `project` in `declares.scopes` when it can show every epic of
 * the project, each item labelled with its epic. One that does not still gets
 * its normal context — `scope: 'project'`, `epic: null`, no parts — because a
 * context is the host's account of where the person is standing and it is the
 * same account for everyone. What it does not get is a person looking at it:
 * the HOST covers its container with one sentence, rather than leave the
 * module to go blank (it would read `epic: null` as "no epic" and show its
 * empty state) or go on showing the last epic it was told about, which would
 * be a page quietly describing work the person is no longer on.
 *
 * ## The page stays, underneath
 *
 * The cover is drawn over the container's body and the module's page is
 * hidden by the path a folded container's page takes (`visibility`, in
 * `Frames.tsx`): kept at its size, kept running, its document untouched. So
 * whatever the module was holding — a scroll position, a half-typed field, a
 * terminal — is exactly where it was when an epic is picked again, and the
 * page cannot be clicked or tabbed into behind a sentence that says it is not
 * in use.
 *
 * ## A pinned container is not covered
 *
 * A pinned container keeps the context it was pinned with and does not hear
 * the canvas move (`whileFrozen` in `context.ts`), so it is still on the
 * epic it was on. Covering it would hide a module that is showing exactly what
 * it says it is showing.
 */

/** What the cover says. One sentence and an instruction, with no module named: the container's header already names it. */
export const ONE_EPIC_AT_A_TIME = 'This module works on one epic at a time. Pick an epic to use it.'

/** What the epic picker calls the choice, and what its closed control says while it is chosen. */
export const ALL_EPICS = 'All epics'

/**
 * Whether a container is covered while the project is on "All epics": the
 * subject is the whole project, the container is not pinned, it works at Epic
 * or Part (a container at This computer, Project or Kehikko is not about the
 * open epic, and goes on as it was), and its module cannot work at Project. A
 * module whose manifest has not been read is not covered here — it has a cover
 * of its own while it loads, or a notice when it will not answer
 * (`host/standing.ts`).
 */
export function coveredForScope(
  scope: 'epic' | 'project' | undefined,
  module: { declares?: { scopes?: readonly ContextScope[] }; modes?: readonly { id?: string; scope?: unknown; scopeSays?: unknown }[] } | null | undefined,
  pinned = false,
  picked: string | null = null,
): boolean {
  if (scope !== 'project' || pinned || !module) return false
  if (!scopeNeedsEpic(activeScope(module, picked))) return false
  return !supportsScope(module, 'project')
}

/*
 * ## A container's scope (protocol 2.29.0)
 *
 * What a module's content belongs to: This computer, Project, Epic, Part or
 * Kehikko. A module lists every scope it can work at, one mode each, its
 * default first; the person picks among THOSE, per container, in the module's
 * settings window, and the pick is kept with the container's arrangement
 * (`scope` on a placement, shared in `kehikot.json`, written only when it is
 * not the default). The module is told the one in use in `context.scope`
 * (`scopeToTell`). Nothing here can make a module work at a scope it did not
 * list. Every rule the page draws from is in this file: the header label, the
 * modules menu, the settings window and `read_canvas` all read `scopeOfContainer`.
 */

/** The lucide icon for each scope, drawn beside its name and alone where the header has no room. */
export const SCOPE_ICONS = {
  machine: 'laptop',
  project: 'folder',
  epic: 'flag',
  part: 'puzzle',
  kehikko: 'layout-grid',
} as const satisfies Record<ModuleScope, string>

type ScopeManifest = Parameters<typeof supportedScopes>[0]

/** Everything the page says about one container's scope. */
export interface ContainerScope {
  /** The scope in use: the person's pick when the module supports it, else the module's default. */
  active: ModuleScope
  /** What a person is shown for it: "This computer", "Project", "Epic", "Part", "Kehikko". */
  name: string
  /** The module's line for it (`scopeSays`), or the scope's own meaning when it says none. */
  says: string
  /** The module's default. */
  defaultScope: ModuleScope
  /** Whether the active scope is the default: "(default)" or "(changed)". */
  isDefault: boolean
  /** Every scope the module can work at, default first, each with its line. */
  supported: { scope: ModuleScope; name: string; says: string; isDefault: boolean }[]
}

/** A scope's line: the module's `scopeSays`, or what the scope means when it says nothing. */
function lineFor(says: string, scope: ModuleScope): string {
  return says || SCOPE_MEANS[scope]
}

/** A container's scope, from its module's manifest and the scope the person picked for it (null: none). */
export function scopeOfContainer(module: ScopeManifest, picked: string | null | undefined): ContainerScope {
  const list = supportedScopes(module)
  const fallback = defaultScope(module)
  const active = activeScope(module, picked ?? null)
  const supported = list.map((one) => ({ scope: one.scope, name: SCOPE_NAMES[one.scope], says: lineFor(one.says, one.scope), isDefault: one.scope === fallback }))
  return {
    active,
    name: SCOPE_NAMES[active],
    says: supported.find((one) => one.scope === active)?.says ?? SCOPE_MEANS[active],
    defaultScope: fallback,
    isDefault: active === fallback,
    supported,
  }
}

/** The header label's tooltip: the scope's name, whether it is the default, and the module's line. */
export function scopeTooltip(scope: ContainerScope): string {
  return `Scope: ${scope.name} (${scope.isDefault ? 'default' : 'changed'}). ${capitalised(scope.says)}`
}

/** A row's tooltip where nothing has been picked (the modules menu): the default's name and line. */
export function scopeRowTooltip(scope: ContainerScope): string {
  const others = scope.supported.filter((one) => !one.isDefault).map((one) => one.name)
  const also = others.length ? ` Can also work for: ${others.join(', ')}.` : ''
  return `Scope: ${scope.name}. ${capitalised(scope.says)}${also}`
}

/** What the settings window says for a module with one scope: it shows it, and cannot be changed. */
export function onlyScopeSaid(scope: ContainerScope): string {
  return `This module only works for ${scope.name}.`
}

function capitalised(line: string): string {
  const said = line.trim()
  if (!said) return ''
  const first = said.charAt(0).toUpperCase() + said.slice(1)
  return /[.!?]$/.test(first) ? first : `${first}.`
}

/**
 * What to keep for a pick: null for the module's default (so an arrangement on
 * defaults writes nothing, and a host before scopes still reads the file), the
 * scope otherwise. A scope the module does not list is refused (null too).
 */
export function scopeToKeep(module: ScopeManifest, picked: string | null | undefined): ModuleScope | null {
  if (!picked) return null
  const one = supportedScopes(module).find((s) => s.scope === picked)
  if (!one) return null
  return one.scope === defaultScope(module) ? null : one.scope
}

/**
 * What a container is told in `context.scope`: its scope, or `project` on "All
 * epics" for one at Epic or Part (`toldScope`). A pinned container keeps what it
 * was pinned on, so the canvas going to "All epics" does not move it.
 */
export function scopeToTell(active: ModuleScope, allEpics: boolean, pinned = false): ModuleScope {
  return toldScope(active, allEpics && !pinned)
}

/** The order the modules menu groups by: from the widest to the narrowest. */
export const SCOPE_ORDER: readonly ModuleScope[] = MODULE_SCOPES
