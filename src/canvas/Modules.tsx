import { useEffect, useRef, useState } from 'react'
import { ScopeChip } from './Scope.tsx'
import { ArrowDownLeft, ArrowUpRight, Compass, Eye, LoaderCircle, MousePointerClick } from 'lucide-react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { appEngine } from '@/host/appUpdate.ts'
import type { Canvas } from '@/host/canvases.ts'
import { runsAsSaid, type BuildDetails } from '@/host/moduleBuilds.ts'
import { needsNewerSaid, releaseVersion, worksSaid, type ModuleRelease } from '@/host/moduleReleases.ts'
import { fetchModuleRelease } from '@/host/updates.ts'
import { arrange, attention, builtFrom, rowsOf, type Available, type Registered } from '@/host/moduleMenu.ts'
import { fetchOfficial, installOfficial, proposeModule, staleLine, type ListStanding, type OfficialModule, type Proposal } from '@/host/official.ts'
import {
  addRepository,
  adoptMine,
  checkRepository,
  fetchMine,
  installMine,
  removeMine,
  repoSaid,
  type Adoptable,
  type Checked,
  type MineList,
} from '@/host/myModules.ts'
import type { RegistryView } from '@/host/registry.ts'
import {
  labelFor,
  relate,
  sentenceFor,
  standingOf,
  type Placings,
  type Relationship,
  type Standing,
} from '@/host/relations.ts'
import { ConditionDot } from './Conditions.tsx'
import { ModuleIcon, setListedIcons } from './ModuleIcon.tsx'
import { GitSaid } from './GitSaid.tsx'
import { Hint } from './Hint.tsx'

/**
 * Kehikko modules: everything registered, whether or not it is on the canvas.
 *
 * ## What a row says
 *
 * What a person can do with it: the name, what it is in a sentence, and a
 * button to put it on this kehikko or take it off. Not how the host reached
 * its conclusion about it. Modules sleep when nothing needs them, so "not
 * running" is the ordinary state of most of this list, and it is said by the
 * dot alone — a sentence about it on every row made a wall of near-identical
 * warnings in which the one row that was really broken did not stand out.
 *
 * A sentence appears only for a module a person has to act on, and it ends
 * with the next step; `attention` in `host/moduleMenu.ts` decides which those
 * are. The address, the directory and the host's own reasoning are one press
 * away under "details", for whoever is debugging.
 *
 * ## How it is ordered
 *
 * What is on this kehikko first, then one section per category, taken from the
 * tags each module declares about itself — the host keeps no table of which
 * module is which. A box at the top narrows by name, summary and tag.
 *
 * ## What is not on this machine
 *
 * Modules on the official list that are not installed are on their shelves
 * too, under the registered ones and greyed, each with one button that clones,
 * installs and registers it — `server/installs.ts`. A registered module that
 * is not on the list can be proposed for it from its details.
 *
 * The list is the one the app came with under the one published now
 * (`server/officialSource.ts`), read again when this opens. A module it lists
 * that needs a newer app says so and has no button. When it could not be
 * refreshed, one muted line at the foot says which list this is — and nothing
 * else changes.
 *
 * ## My modules
 *
 * A module that is on no official list — a private repository, or one still
 * being written — is installed from its repository at the foot of the list
 * ("Install from repository…", `server/myModules.ts`). The repository is read
 * with the person's own login and what it holds is shown before anything is
 * written. Such a module is filed on its shelf like any other and marked
 * "added by you", because Kehikot does not vouch for it; its details have
 * Remove. A checkout put under `installed/` by hand is offered there too, as
 * "Keep it as one of my modules".
 */
export function ModuleList({
  registry,
  onCanvas,
  canvases,
  open,
  onPlace,
  onUnplace,
  onLookAgain,
}: {
  registry: RegistryView | null
  onCanvas: Set<string>
  canvases: readonly Canvas[]
  open: Canvas | null
  onPlace(id: string): void
  onUnplace(id: string): void
  /** Sweep the registry again: an install has just registered something. */
  onLookAgain?(): void
}) {
  const [query, setQuery] = useState('')
  const official = useOfficial(onLookAgain)

  if (!registry) return <p className="text-muted-foreground p-4 text-sm">Asking the host…</p>

  const { presences, sweep } = registry
  const rows = rowsOf(presences, onCanvas, official.list, official.mine?.modules ?? null)

  if (!rows.length) {
    return (
      <div className="space-y-2 p-4 text-sm">
        {/* Where it looked, said out loud. "No modules" and "no such directory"
            are two different things to be told and only one of them is fixed by
            starting a program. */}
        <p>No modules are registered.</p>
        <p className="text-muted-foreground text-xs">
          A registration is a file whose name is the module&rsquo;s id, saying where it answers. This host
          reads them from:
        </p>
        <p className="text-muted-foreground font-mono text-xs break-all">{sweep.dir}</p>
        <Rejected rejected={sweep.rejected} />
      </div>
    )
  }

  /*
   * Which module touches which, out of what each of them declared.
   *
   * Derived here rather than carried on the presence, because half the answer
   * is about the CANVASES — where the other end is right now — and the server
   * that reads manifests knows nothing about those. The whole derivation is a
   * pure function in `host/relations.ts`, with the argument for each kind of
   * relationship and, more importantly, for the ones it refuses to draw.
   */
  const elsewhere = new Map<string, string[]>()
  for (const canvas of canvases) {
    if (open && canvas.id === open.id) continue
    for (const placement of canvas.placements) {
      const already = elsewhere.get(placement.i)
      if (already) already.push(canvas.name)
      else elsewhere.set(placement.i, [canvas.name])
    }
  }
  const placings: Placings = { onCanvas, elsewhere }
  const relationships = relate(presences, placings)
  const sections = arrange(rows, query)
  const stale = staleLine(official.standing)

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="space-y-2 border-b p-3">
        <h2 className="text-sm font-medium">Kehikko modules</h2>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, what it does, category or scope"
          aria-label="search modules"
          className="h-7 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Where the official list would begin: said once, in a sentence, so a short list is not a mystery. */}
        {stale ? <p className="text-muted-foreground border-b px-3 py-2 text-[11px] leading-relaxed">{stale}</p> : null}
        {sections.length ? (
          sections.map((section) => (
            <section key={section.heading} aria-label={section.heading}>
              <h3 className="bg-muted/40 text-muted-foreground px-3 py-1 text-[11px] font-medium tracking-wide uppercase">
                {section.heading}
              </h3>
              <ul className="divide-y">
                {section.rows.map((row) =>
                  row.kind === 'available' ? (
                    <AvailableRow
                      key={row.id}
                      row={row}
                      onInstall={() => (row.entry.mine ? official.installMine(row.id) : official.install(row.id))}
                      onRemove={row.entry.mine ? () => official.remove(row.id) : undefined}
                      refused={official.refused.get(row.id) ?? null}
                    />
                  ) : (
                    <ModuleRow
                      key={row.id}
                      row={row}
                      relationships={relationships.get(row.id) ?? []}
                      onPlace={() => onPlace(row.id)}
                      onUnplace={() => onUnplace(row.id)}
                      onRemove={row.mine ? () => official.remove(row.id) : undefined}
                      refused={official.refused.get(row.id) ?? null}
                    />
                  ),
                )}
              </ul>
            </section>
          ))
        ) : (
          <p className="text-muted-foreground p-4 text-sm">No module matches &ldquo;{query.trim()}&rdquo;.</p>
        )}
        {official.mine ? (
          <MyModules
            mine={official.mine}
            onAdded={official.again}
            onAdopt={official.adopt}
            refused={official.refused}
          />
        ) : null}
        <div className="space-y-2 border-t p-3">
          <p className="text-muted-foreground font-mono text-[11px] break-all">{sweep.dir}</p>
          <Rejected rejected={sweep.rejected} />
        </div>
      </div>
    </div>
  )
}

/**
 * The official list, kept while the menu is open.
 *
 * Read when the menu opens and again every second and a half while something
 * is installing — the one time the answer changes without anybody pressing
 * anything. When a module that was not installed becomes installed, the
 * registry is swept, so its row turns into an ordinary one with an add button.
 *
 * A host from before the list answers 404, and then there is no list: nothing
 * extra is drawn and nothing is offered.
 */
const INSTALL_POLL_MS = 1500

function useOfficial(onInstalled?: () => void) {
  const [list, setList] = useState<OfficialModule[] | null>(null)
  const [mine, setMine] = useState<MineList | null>(null)
  const [standing, setStanding] = useState<ListStanding | null>(null)
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map())
  const [asked, setAsked] = useState(0)
  const installed = useRef<Set<string> | null>(null)
  const told = useRef(onInstalled)
  told.current = onInstalled

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    void Promise.all([fetchOfficial(), fetchMine().catch(() => null)])
      .then(([{ modules: got, standing: how }, ours]) => {
        if (!alive) return
        setStanding(how)
        const every = [...got, ...(ours?.modules ?? [])]
        const now = new Set(every.filter((one) => one.installed).map((one) => one.id))
        const before = installed.current
        installed.current = now
        /* Something became installed, or stopped being (a Remove): the registry is swept again. */
        if (before && ([...now].some((id) => !before.has(id)) || [...before].some((id) => !now.has(id)))) told.current?.()
        setList(got)
        setMine(ours)
        setListedIcons(every)
        if (every.some((one) => one.install?.state === 'installing')) timer = setTimeout(() => setAsked((n) => n + 1), INSTALL_POLL_MS)
      })
      .catch(() => {
        if (alive) setList(null)
      })
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [asked])

  /** A press: its earlier refusal cleared, the server asked, and the list read again whatever it said. */
  function press(id: string, ask: () => Promise<void>) {
    setRefused((was) => new Map([...was].filter(([one]) => one !== id)))
    void ask()
      .catch((error: unknown) => setRefused((was) => new Map(was).set(id, (error as Error).message)))
      .finally(() => setAsked((n) => n + 1))
  }

  return {
    list,
    mine,
    standing,
    refused,
    install: (id: string) => press(id, () => installOfficial(id)),
    installMine: (id: string) => press(id, () => installMine(id)),
    remove: (id: string) => press(id, () => removeMine(id)),
    adopt: (id: string) => press(id, () => adoptMine(id)),
    again: () => setAsked((n) => n + 1),
  }
}

/**
 * An official module that is not on this machine: what it is, and one button.
 *
 * Greyed, because it cannot be placed yet, and under the registered rows of
 * its shelf, because what is here comes before what could be. While it
 * installs the button says which step it is on; a failure is the server's
 * sentence, and the button tries again.
 *
 * One that needs a newer app than this one says so and has no button: the
 * host would refuse the module once it was here.
 */
function AvailableRow({
  row,
  onInstall,
  onRemove,
  refused,
}: {
  row: Available
  onInstall(): void
  /** One of the person's own: take it off My modules (and delete what an earlier attempt cloned). */
  onRemove?(): void
  refused: string | null
}) {
  const install = row.entry.install
  const working = install?.state === 'installing'
  const failed = install?.state === 'failed' ? install.why : refused
  return (
    <li className="flex items-start gap-2.5 p-3">
      <span className="border-muted-foreground/50 mt-1.5 size-1.5 shrink-0 rounded-full border" aria-label="not installed" title="not installed" />
      <div className="min-w-0 flex-1 opacity-70">
        <div className="flex items-center gap-2">
          <ModuleIcon id={row.id} icon={row.entry.icon} name={row.name} className="text-muted-foreground size-3.5" />
          <span className="truncate text-sm font-medium">{row.name}</span>
          <Badge variant="outline" className="text-muted-foreground shrink-0">
            not installed
          </Badge>
          {row.entry.mine ? <AddedByYou repo={repoSaid(row.entry)} /> : null}
        </div>
        {row.summary ? <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{row.summary}</p> : null}
        {row.entry.newer ? (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">Needs a newer version of Kehikot than this one.</p>
        ) : failed ? (
          <p role="alert" className="mt-1 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
            <GitSaid said={failed} />
          </p>
        ) : null}
        {onRemove && !working ? <RemoveMine name={row.name} installed={false} onRemove={onRemove} /> : null}
      </div>
      {row.entry.newer ? null : (
        <Hint label={`clone ${repoSaid(row.entry)}, install it and register it on this computer`} side="left">
          <Button variant="secondary" size="sm" className="h-6 shrink-0 px-2 text-xs" disabled={working} onClick={onInstall}>
            {working ? `${install.step}…` : failed ? 'try again' : 'install'}
          </Button>
        </Hint>
      )}
    </li>
  )
}

function ModuleRow({
  row,
  relationships,
  onPlace,
  onUnplace,
  onRemove,
  refused,
}: {
  row: Registered
  /** What this module touches, and how. Empty for most of them, honestly. */
  relationships: readonly Relationship[]
  onPlace(): void
  onUnplace(): void
  /** One of the person's own: take it off this computer. */
  onRemove?(): void
  /** Why the last press on it was refused. */
  refused?: string | null
}) {
  const { presence, placed } = row
  const standing = standingOf(presence, relationships)
  const trouble = attention(presence)
  /* The word beside the name, only where the dot's colour is not enough: what
     the host itself did (asleep, starting), and a module it cannot speak to.
     Plain "not running" gets no word. It is the resting state of the list. */
  const word = presence.lifecycle ?? (presence.condition === 'incompatible' ? 'incompatible' : null)
  return (
    <li className="flex items-start gap-2.5 p-3">
      <span className="mt-1.5">
        <ConditionDot condition={presence.condition} lifecycle={presence.lifecycle} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <ModuleIcon id={row.id} name={row.name} className="text-muted-foreground size-3.5" />
          <span className="truncate text-sm font-medium">{row.name}</span>
          {/* What its content belongs to (protocol 2.29.0): its default scope, the line and the others in the tooltip. */}
          {row.scope ? <ScopeChip scope={row.scope} /> : null}
          {word ? (
            <Badge variant="outline" className="text-muted-foreground shrink-0">
              {word}
            </Badge>
          ) : null}
          <Standings standing={standing} />
          {row.mine ? <AddedByYou repo={row.mine.repo} /> : null}
        </div>
        {row.summary ? <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{row.summary}</p> : null}
        {refused ? (
          <p role="alert" className="mt-1 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
            {refused}
          </p>
        ) : null}
        {trouble ? (
          <p role="alert" className="mt-1 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
            {trouble}
          </p>
        ) : null}
        {/* The list can come to name another repository for a module that is
            already here. Nothing follows it there; the row says so. */}
        {row.elsewhere ? (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed break-words">
            The official list names {row.elsewhere.listed} for this module. This one comes from {row.elsewhere.from} and
            stays there.
          </p>
        ) : null}
        {/*
         * What it touches. Absent entirely when it touches nothing, which is
         * seven of the eleven modules on this machine — and that absence is the
         * feature. A row of marks on every module is a row of marks nobody
         * reads; `Tools.tsx` has the long version of the argument, and it is
         * why nothing here marks the thing almost every module has in common.
         *
         * `min-w-0` on the wrapper because a badge is `whitespace-nowrap` in
         * shadcn's base, and a nowrap child sets a min-content floor under
         * everything above it. A sibling module put a sentence in one and gave
         * a two-hundred pixel container an eleven-hundred pixel floor. Nothing in a
         * badge here is longer than a module's name; the sentence is in the
         * tooltip, where there is room for it.
         */}
        {relationships.length ? (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
            {relationships.map((relationship) => (
              <RelationBadge
                /* The role is in the key because a module can be both ends of
                   one context kind — a notes pane that follows a passage and
                   points at one when somebody presses a note — and those are
                   two rows, not one drawn twice. */
                key={`${relationship.kind}:${relationship.role ?? ''}:${relationship.extension ?? ''}`}
                relationship={relationship}
                module={row.name}
              />
            ))}
          </div>
        ) : null}
        <Halves standing={standing} />
        <Details row={row} shown={trouble} onRemove={onRemove} />
      </div>
      <Hint
        label={
          placed
            ? 'take it off this kehikko — it stays registered, and stays on any other kehikko'
            : 'put it on this kehikko'
        }
        side="left"
      >
        <Button
          variant={placed ? 'ghost' : 'secondary'}
          size="sm"
          className="h-6 shrink-0 px-2 text-xs"
          onClick={placed ? onUnplace : onPlace}
        >
          {placed ? 'remove' : 'add'}
        </Button>
      </Hint>
    </li>
  )
}

/**
 * The diagnostics, folded away: where the module answers, where it lives, where
 * an agent reaches it, and the host's own sentence about it.
 *
 * A native disclosure rather than a tooltip on the dot, because an address is
 * something a person copies, and a tooltip closes when the pointer leaves it.
 */
function Details({ row, shown, onRemove }: { row: Registered; shown: string | null; onRemove?(): void }) {
  const { presence } = row
  const built = builtFrom(presence)
  /* The sentence is left out when the row already says it: as the summary of a
     module that is answering, or inside the line about what to do. */
  const line = presence.line && presence.line !== row.summary && !shown?.startsWith(presence.line) ? presence.line : null
  const [opened, setOpened] = useState(false)
  return (
    <details className="text-muted-foreground mt-1 text-[11px]" onToggle={(event) => event.currentTarget.open && setOpened(true)}>
      <summary className="hover:text-foreground w-fit cursor-pointer select-none">details</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt>id</dt>
        <dd className="font-mono break-all">{presence.id}</dd>
        <dt>address</dt>
        <dd className="font-mono break-all">{presence.at}</dd>
        {built ? (
          <>
            <dt>version</dt>
            <dd className="font-mono break-all">{built.version}</dd>
          </>
        ) : null}
        {/* The protocol PACKAGE the module is built with, which it states in
            its build identity — not the wire protocol number, which every
            module here shares. Absent for a module that does not say. */}
        {built?.protocol ? (
          <>
            <dt>protocol</dt>
            <dd className="font-mono break-all">{built.protocol}</dd>
          </>
        ) : null}
        {presence.dir ? (
          <>
            <dt>directory</dt>
            <dd className="font-mono break-all">{presence.dir}</dd>
          </>
        ) : null}
        {presence.module?.mcp ? (
          <>
            <dt>agents</dt>
            <dd className="font-mono break-all">{presence.module.mcp.url}</dd>
          </>
        ) : null}
      </dl>
      {opened ? <ReleaseDetails id={row.id} /> : null}
      {line ? <p className="mt-1 leading-relaxed">{line}</p> : null}
      {row.mine ? (
        <p className="mt-1 leading-relaxed">
          Added by you from {row.mine.repo}. Kehikot does not vouch for it. It runs its newest release (its main
          branch while it has none), moved there before it starts, like any installed module.
        </p>
      ) : null}
      {row.official === false ? <Propose id={row.id} name={row.name} /> : null}
      {onRemove ? <RemoveMine name={row.name} installed onRemove={onRemove} /> : null}
    </details>
  )
}

/**
 * An installed module's releases, read when its details are first opened: the
 * one it runs and the newest, each with which Kehikot it works with ("Works
 * with Kehikot 0.1.39 and later"). Nothing for a module registered from
 * somebody's own checkout, which runs its branch.
 */
function ReleaseDetails({ id }: { id: string }) {
  const [read, setRead] = useState<{ release: ModuleRelease | null; protocol: string | null; build: BuildDetails | null; app: string | null } | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        const [got, status] = await Promise.all([
          fetchModuleRelease(id, abort.signal),
          appEngine()?.status().catch(() => null) ?? Promise.resolve(null),
        ])
        if (!abort.signal.aborted) setRead({ ...got, app: status?.current ?? null })
      } catch {
        /* Said nothing: the rest of the details stand on their own. */
      }
    })()
    return () => abort.abort()
  }, [id])
  const release = read?.release
  const build = read?.build ? <BuildLine build={read.build} /> : null
  if (!release) return build
  const rows = [
    release.installed ? { label: 'release', tag: release.installed } : null,
    release.newest && release.newest !== release.installed ? { label: 'newest', tag: release.newest } : null,
  ].filter((one): one is { label: string; tag: string } => one !== null)
  const newer = needsNewerSaid(release, { app: read.app, protocol: read.protocol })
  if (!rows.length && !newer) return build
  return (
    <div data-testid="module-release-details">
      {build}
      {rows.length ? (
        <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
          {rows.map((one) => (
            <div key={one.label} className="contents">
              <dt>{one.label}</dt>
              <dd className="break-words">
                <span className="font-mono">{releaseVersion(one.tag)}</span>
                {worksSaid(release, one.tag) ? ` · ${worksSaid(release, one.tag)}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {newer ? <p className="mt-1 leading-relaxed">{newer}</p> : null}
    </div>
  )
}

/**
 * How the module runs: "Ready-built" (its copy was built here at its release,
 * and its run.sh serves the build) or "Running from source". When the build
 * did not finish, why, and the build's own output — the last of it here and
 * the whole in the module's log, whose path is shown. All of it as text.
 */
function BuildLine({ build }: { build: BuildDetails }) {
  const [log, setLog] = useState(false)
  return (
    <div className="mt-0.5" data-testid="module-build-details">
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt>runs</dt>
        <dd className="break-words" data-testid="module-runs-as">
          {build.preparing ? 'Being built…' : runsAsSaid(build)}
          {!build.preparing && !build.ready && build.failed ? (
            <>
              {' — its build didn\'t finish. '}
              <button type="button" className="hover:text-foreground underline" aria-expanded={log} onClick={() => setLog((was) => !was)}>
                {log ? 'Hide the log' : 'See the log'}
              </button>
            </>
          ) : null}
        </dd>
      </dl>
      {log && build.failed ? (
        <div data-testid="module-build-log">
          <p className="mt-1 leading-relaxed break-words">{build.failed.why}</p>
          {build.failed.lines.length ? (
            <pre className="bg-muted mt-1 max-h-40 overflow-auto rounded px-2 py-1 font-mono text-[10px] leading-snug whitespace-pre-wrap">
              {build.failed.lines.join('\n')}
            </pre>
          ) : null}
          <p className="mt-1 font-mono break-all">{build.failed.log}</p>
        </div>
      ) : null}
    </div>
  )
}

/**
 * "Added by you": a module from the person's own list, which nobody else has
 * looked at. A fixed word in the badge (see `Standings` for why a badge never
 * holds a stranger's string); the repository is in the tooltip.
 */
function AddedByYou({ repo }: { repo: string }) {
  return (
    <Hint
      label={
        <span className="block max-w-[22rem] leading-relaxed break-words">
          {`You added this from ${repo}. It is not on the official list, and Kehikot does not vouch for it.`}
        </span>
      }
    >
      <Badge variant="outline" className="shrink-0 cursor-default border-dashed px-1.5 py-0 text-[10px] font-normal">
        added by you
      </Badge>
    </Hint>
  )
}

/**
 * Remove one of the person's own modules: one press asks, a second does it.
 * It stops the module and deletes the copy this host installed and its
 * registration; what it kept in projects stays.
 */
function RemoveMine({ name, installed, onRemove }: { name: string; installed: boolean; onRemove(): void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button type="button" className="text-muted-foreground hover:text-foreground mt-1.5 block text-[11px] underline" onClick={() => setAsking(true)}>
        {installed ? 'Remove from this computer' : 'Remove from my modules'}
      </button>
    )
  }
  return (
    <p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
      {installed
        ? `This stops ${name}, deletes the copy Kehikot installed and its registration, and takes it off My modules. What it kept in your projects stays. `
        : `This takes ${name} off My modules, and deletes anything an earlier install left. `}
      <button
        type="button"
        className="text-foreground underline"
        onClick={() => {
          setAsking(false)
          onRemove()
        }}
      >
        Remove it
      </button>{' '}
      <button type="button" className="underline" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </p>
  )
}

/**
 * The foot of the list: what "My modules" are, installing one from its
 * repository, and the checkouts installed by hand that could be kept as one.
 *
 * ## Install from repository
 *
 * Typed, checked, shown, confirmed — four steps, because the last one runs a
 * stranger's code on this computer. "Check" reads the repository with the
 * person's own `gh` or `glab` and writes nothing; what it finds is shown with
 * the plain sentence that Kehikot does not vouch for it; "Install" asks the
 * server to check again and install. A repository on the official list is
 * said to be one, and installed as the official module.
 */
function MyModules({
  mine,
  onAdded,
  onAdopt,
  refused,
}: {
  mine: MineList
  onAdded(): void
  onAdopt(id: string): void
  refused: ReadonlyMap<string, string>
}) {
  return (
    <section aria-label="My modules" className="border-t">
      <h3 className="bg-muted/40 text-muted-foreground px-3 py-1 text-[11px] font-medium tracking-wide uppercase">My modules</h3>
      <div className="space-y-2 p-3">
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          Modules you install from a repository you can read, private or not. They are kept on this computer only, and
          Kehikot does not vouch for them: install only what you trust, because it runs here with your permissions.
        </p>
        {mine.broken ? (
          <p role="alert" className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
            {mine.broken}
          </p>
        ) : null}
        {mine.adoptable.map((one) => (
          <Adopt key={one.id} one={one} onAdopt={() => onAdopt(one.id)} refused={refused.get(one.id) ?? null} />
        ))}
        <InstallFromRepository onAdded={onAdded} />
      </div>
    </section>
  )
}

function Adopt({ one, onAdopt, refused }: { one: Adoptable; onAdopt(): void; refused: string | null }) {
  return (
    <div className="space-y-1 rounded-md border p-2 text-xs">
      <p className="leading-relaxed break-words">
        {one.name} was installed by hand from {one.from}, which is on no list.
        {one.moves
          ? ` Keeping it moves it off port ${one.moves.from ?? 'none'}, which an official or another module has, to ${one.moves.to}; it is stopped and starts there next time.`
          : ''}
      </p>
      <Button variant="secondary" size="sm" className="h-6 px-2 text-xs" onClick={onAdopt}>
        Keep it as one of my modules
      </Button>
      {refused ? (
        <p role="alert" className="leading-relaxed text-amber-600 dark:text-amber-400">
          {refused}
        </p>
      ) : null}
    </div>
  )
}

function InstallFromRepository({ onAdded }: { onAdded(): void }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [at, setAt] = useState<'idle' | 'checking' | 'adding'>('idle')
  const [checked, setChecked] = useState<Checked | null>(null)
  const [refused, setRefused] = useState<string | null>(null)

  function reset() {
    setOpen(false)
    setTyped('')
    setChecked(null)
    setRefused(null)
    setAt('idle')
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => setOpen(true)}>
        Install from repository…
      </Button>
    )
  }

  function check() {
    setAt('checking')
    setChecked(null)
    setRefused(null)
    void checkRepository(typed)
      .then(setChecked)
      .catch((error: unknown) => setRefused((error as Error).message))
      .finally(() => setAt('idle'))
  }

  function add() {
    setAt('adding')
    setRefused(null)
    void addRepository(typed)
      .then(() => {
        reset()
        onAdded()
      })
      .catch((error: unknown) => {
        setRefused((error as Error).message)
        setAt('idle')
      })
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (typed.trim() && at === 'idle') check()
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value)
            setChecked(null)
          }}
          placeholder="owner/repo, or a GitHub or GitLab link"
          aria-label="repository to install from"
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <Button type="submit" variant="secondary" size="sm" className="h-7 shrink-0 px-2 text-xs" disabled={!typed.trim() || at !== 'idle'}>
          {at === 'checking' ? (
            <>
              <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden />
              Checking…
            </>
          ) : (
            'Check'
          )}
        </Button>
      </div>
      {checked ? <Found checked={checked} adding={at === 'adding'} onInstall={add} onCancel={reset} /> : null}
      {refused ? (
        <p role="alert" className="text-xs leading-relaxed break-words text-amber-600 dark:text-amber-400">
          {refused}
        </p>
      ) : null}
      {!checked ? (
        <button type="button" className="text-muted-foreground hover:text-foreground text-[11px] underline" onClick={reset}>
          Cancel
        </button>
      ) : null}
    </form>
  )
}

/** What a check found: the module, where it is from, what it needs, and the one press that installs it. */
function Found({ checked, adding, onInstall, onCancel }: { checked: Checked; adding: boolean; onInstall(): void; onCancel(): void }) {
  const actions = (label: string | null) => (
    <div className="flex items-center gap-2">
      {label ? (
        <Button type="button" size="sm" className="h-6 px-2 text-xs" disabled={adding} onClick={onInstall}>
          {adding ? 'Installing…' : label}
        </Button>
      ) : null}
      <button type="button" className="text-muted-foreground hover:text-foreground text-[11px] underline" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
  if (checked.kind === 'official') {
    return (
      <div className="space-y-1.5 rounded-md border p-2 text-xs">
        <p className="font-medium">{checked.name}</p>
        <p className="text-muted-foreground leading-relaxed">
          {checked.installed
            ? `${checked.repo} is ${checked.name} on the official list, and it is already installed.`
            : `${checked.repo} is ${checked.name} on the official list, so it is installed as the official module.`}
        </p>
        {actions(checked.installed ? null : 'Install')}
      </div>
    )
  }
  const from = repoSaid(checked)
  return (
    <div className="space-y-1.5 rounded-md border p-2 text-xs">
      <p className="break-words">
        <span className="font-medium">{checked.name}</span> <span className="text-muted-foreground font-mono text-[11px]">{checked.id}</span>
      </p>
      {checked.summary ? <p className="text-muted-foreground leading-relaxed">{checked.summary}</p> : null}
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt>from</dt>
        <dd className="font-mono break-all">
          {from}
          {checked.private ? ' (private)' : ''}
        </dd>
        <dt>protocol</dt>
        <dd className="font-mono break-all">{checked.protocol ? `needs ${checked.protocol}` : 'does not say'}</dd>
      </dl>
      {checked.newer ? (
        <p className="leading-relaxed text-amber-600 dark:text-amber-400">
          It needs a newer Kehikot than this one (protocol {checked.newer.protocol}; this one has {checked.newer.has}), so it
          cannot be installed here.
        </p>
      ) : (
        <p className="text-muted-foreground leading-relaxed">
          Added by you: Kehikot does not vouch for it. Installing clones it, runs bun install in it and registers it on this
          computer.
        </p>
      )}
      {actions(checked.newer ? null : 'Install')}
    </div>
  )
}

/**
 * Propose a registered module for the official list.
 *
 * Only for a module that is not on it. One press asks, a second files: the
 * proposal is an issue in Kehikot's repository under the person's own GitHub
 * account, and that is not something to do on a single click. A module that
 * cannot be proposed — no public repository — is told so in the server's
 * sentence, here, instead of filing an issue nobody could follow.
 */
function Propose({ id, name }: { id: string; name: string }) {
  const [at, setAt] = useState<'idle' | 'asking' | 'sending'>('idle')
  const [filed, setFiled] = useState<Proposal | null>(null)
  const [refused, setRefused] = useState<string | null>(null)

  if (filed) {
    return (
      <p className="mt-1.5 leading-relaxed">
        {filed.existing ? 'Already proposed: ' : 'Proposed: '}
        <a className="text-foreground underline" href={filed.url} target="_blank" rel="noreferrer">
          #{filed.number}
        </a>
      </p>
    )
  }

  function send() {
    setAt('sending')
    setRefused(null)
    void proposeModule(id)
      .then(setFiled)
      .catch((error: unknown) => setRefused((error as Error).message))
      .finally(() => setAt('idle'))
  }

  return (
    <div className="mt-1.5 space-y-1">
      {at === 'asking' ? (
        <p className="leading-relaxed">
          This opens an issue on Kehikot&rsquo;s repository from your GitHub account, filled in from what {name} says
          about itself.{' '}
          <button type="button" className="text-foreground underline" onClick={send}>
            File it
          </button>{' '}
          <button type="button" className="underline" onClick={() => setAt('idle')}>
            Cancel
          </button>
        </p>
      ) : (
        <button type="button" className="hover:text-foreground underline disabled:no-underline" disabled={at === 'sending'} onClick={() => setAt('asking')}>
          {at === 'sending' ? 'Filing the proposal…' : 'Propose for the official list'}
        </button>
      )}
      {refused ? (
        <p role="alert" className="leading-relaxed text-amber-600 dark:text-amber-400">
          {refused}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Consumer, provider, or both, in a word the host chose.
 *
 * ## Why the word is fixed, and why that is not a small point
 *
 * Every string in these two badges is a literal in this file. Nothing from a
 * manifest gets in. A badge is `whitespace-nowrap` in shadcn's base, and a
 * nowrap child puts a min-content floor under every flex and grid ancestor it
 * has: a sibling module in this workspace put a variable string in one and gave
 * a 220-pixel container an 1187-pixel floor, which does not look like a badge
 * bug — it looks like the whole window refusing to be narrow. `Tools.tsx` has
 * the long version. Module names in this row go in the prose lines below, which
 * can truncate; the badges get words nobody else writes.
 *
 * ## What the two words claim, which is less than it looks
 *
 * They are read off this module's own manifest, not off who else is installed.
 * "Provider" means it says it emits a format or declared a capability that puts
 * something in front of every pane on a canvas; "consumer" means it says it
 * shows a format or reacts to something in the context. Both stay true on a
 * machine where nothing else is registered, which is what somebody browsing to
 * decide what to install actually wants to read.
 *
 * Neither is a permission and neither is checked. A module is not stopped from
 * consuming a context it never declared — it is sent the context regardless —
 * and the badge is a description that can be wrong without anything else being
 * different. See the essay on `reacts` in the protocol's `manifest.ts`.
 *
 * Nothing at all when a module is neither, which is most of them, and the
 * silence is the feature: a mark on every row is a mark nobody reads.
 */
function Standings({ standing }: { standing: Standing }) {
  if (!standing.consumer && !standing.provider) return null
  return (
    <>
      {standing.consumer ? (
        <Hint
          label={
            <span className="block max-w-[22rem] leading-relaxed">
              It says in its own manifest that it shows an event format, or that it reacts to
              something the canvas broadcasts. Nothing here is checked or enforced — every framed
              module is sent the whole context in any case.
            </span>
          }
        >
          <Badge variant="outline" className="shrink-0 cursor-default px-1.5 py-0 text-[10px] font-normal">
            consumer
          </Badge>
        </Hint>
      ) : null}
      {standing.provider ? (
        <Hint
          label={
            <span className="block max-w-[22rem] leading-relaxed">
              It says in its own manifest that it emits an event format, or it declared a capability
              that puts something in front of every module on the canvas.
            </span>
          }
        >
          <Badge variant="outline" className="shrink-0 cursor-default px-1.5 py-0 text-[10px] font-normal">
            provider
          </Badge>
        </Hint>
      ) : null}
    </>
  )
}

/**
 * "Consumes: X, Y, Z" and "Provides to: Z, W, A", one line each.
 *
 * ## One line each, and it stays one line however many there are
 *
 * The standing complaint about this workspace is prose in a narrow column, and
 * a module with six relationships is exactly where a summary turns into a
 * paragraph. So each half is a single row that TRUNCATES: `min-w-0` on the
 * container, `truncate` on the names, and the whole list in the tooltip where
 * there is room. Six counterparts produce two lines, the same as one does.
 *
 * The names are a stranger's strings, so they are here in ordinary text rather
 * than in a badge — see `Standings` above for what a variable string inside a
 * nowrap badge did to a container in this workspace.
 *
 * ## Absent rather than empty
 *
 * A half with nothing in it draws nothing. "Provides to: —" would be a row
 * asserting that this module provides to nobody, and the host does not know
 * that: what it knows is that no registered module has DECLARED that it takes
 * anything from this one, which is a fact about who is installed today. The
 * badge above already says the module provides. `relations.ts` has the argument
 * in full, and it is the same one that keeps half a relationship from being
 * drawn as one.
 */
function Halves({ standing }: { standing: Standing }) {
  if (!standing.consumes.length && !standing.providesTo.length) return null
  return (
    <div className="mt-1 min-w-0 space-y-0.5">
      {standing.consumes.length ? (
        <Half label="Consumes" who={standing.consumes.map((one) => one.name)} />
      ) : null}
      {standing.providesTo.length ? (
        <Half label="Provides to" who={standing.providesTo.map((one) => one.name)} />
      ) : null}
    </div>
  )
}

function Half({ label, who }: { label: string; who: readonly string[] }) {
  const all = who.join(', ')
  return (
    <Hint label={<span className="block max-w-[22rem] leading-relaxed">{`${label}: ${all}`}</span>} side="bottom" align="start">
      <p className="text-muted-foreground min-w-0 text-[11px] leading-relaxed">
        {/* The label is the host's own word and never wraps away from the names
            it introduces; the names are the part allowed to run out of room. */}
        <span className="text-foreground/70 font-medium">{label}:</span>{' '}
        <span className="inline-block max-w-full truncate align-bottom">{all}</span>
      </p>
    </Hint>
  )
}

/**
 * One relationship, in as few words as it can be said.
 *
 * ## Two families, because the user asked about two things
 *
 * They asked whether a module that uses another, "indirectly or directly",
 * should show something. Both do, and they must not look alike.
 *
 * A DIRECT one is an event: the host itself takes a payload from one named
 * program and posts it into another named program's frame, and `host/events.ts`
 * is the thing that does it. So it gets an arrow, pointing the way the message
 * goes, and it names the other end — the strongest claim in the list, drawn as
 * the strongest badge.
 *
 * An INDIRECT one names nobody, because there is nobody to name. A module that
 * can move the canvas's subject, or set the selection, changes what everything
 * else is told without any of them being its correspondent; the host can vouch
 * for the sending half and there is no declared receiving half to vouch for.
 * That gets a dashed outline and a muted word, which reads as weaker at a
 * glance and is weaker.
 *
 * A direct relationship whose other end is on no kehikko keeps the arrow — it
 * is still that kind of claim — and goes muted, because at this moment nothing
 * is being carried. The tooltip says which of the two it is.
 */
function RelationBadge({ relationship, module }: { relationship: Relationship; module: string }) {
  const carrying = relationship.with.some(
    (one) => one.reach.where === 'here' || one.reach.where === 'elsewhere',
  )
  /* A reaction gets the eye rather than the pointer, and it is the only mark in
     the row that stands for something nobody performs: the module says it
     watches the context go by. The pointer belongs to the half that acts. */
  const Icon =
    relationship.kind === 'emits'
      ? ArrowUpRight
      : relationship.kind === 'consumes'
        ? ArrowDownLeft
        : relationship.kind === 'navigation'
          ? Compass
          : relationship.role === 'reacts'
            ? Eye
            : MousePointerClick

  return (
    /* The sentence is bounded rather than left to `w-fit`, which would draw one
       very long line across the window. Radix balances the text; it does not
       decide how wide is sensible. */
    <Hint
      label={<span className="block max-w-[22rem] leading-relaxed">{sentenceFor(module, relationship)}</span>}
      side="bottom"
      align="start"
    >
      <Badge
        variant={relationship.direct && carrying ? 'secondary' : 'outline'}
        className={
          relationship.direct
            ? carrying
              ? 'max-w-[13rem] cursor-default gap-1 px-1.5 py-0 text-[11px] font-normal'
              : 'text-muted-foreground max-w-[13rem] cursor-default gap-1 px-1.5 py-0 text-[11px] font-normal'
            : 'text-muted-foreground max-w-[13rem] cursor-default gap-1 border-dashed px-1.5 py-0 text-[11px] font-normal'
        }
      >
        <Icon className="shrink-0" />
        <span className="min-w-0 truncate">{labelFor(relationship)}</span>
      </Badge>
    </Hint>
  )
}

/**
 * Registration files the host read and would not use.
 *
 * Shown, always. A registration silently skipped is the worst failure this
 * design has: somebody wrote a file, nothing appeared, and there is nowhere to
 * look. Each line names the file and says what was wrong with it.
 */
function Rejected({ rejected }: { rejected: { file: string; why: string }[] }) {
  if (!rejected.length) return null
  return (
    <ul className="space-y-1.5">
      {rejected.map((one) => (
        <li key={one.file} className="text-xs">
          <span className="font-mono break-all">{one.file}</span>
          <span className="text-muted-foreground"> — {one.why}</span>
        </li>
      ))}
    </ul>
  )
}
