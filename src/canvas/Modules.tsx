import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ScopeChip } from './Scope.tsx'
import { ChevronRight, LoaderCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { StepProgress, useJob } from './StepProgress.tsx'
import { appEngine } from '@/host/appUpdate.ts'
import { runsAsSaid, type BuildDetails } from '@/host/moduleBuilds.ts'
import { needsNewerSaid, releaseVersion, worksSaid, type ModuleRelease } from '@/host/moduleReleases.ts'
import { protocolDetailSaid } from '@/host/worksWith.ts'
import { fetchModuleRelease } from '@/host/updates.ts'
import { arrange, attention, builtFrom, deprecatedSaid, firstSentence, HERE, rowsOf, uninstallSaid, type Available, type Registered } from '@/host/moduleMenu.ts'
import { fetchOfficial, installOfficial, uninstallModule, proposeModule, staleLine, type ListStanding, type OfficialModule, type Proposal } from '@/host/official.ts'
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
import { ConditionDot } from './Conditions.tsx'
import { ModuleIcon, setListedIcons } from './ModuleIcon.tsx'
import { GitSaid } from './GitSaid.tsx'
import { Hint } from './Hint.tsx'
import { IntroButton } from './ModuleHelp.tsx'

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
/** What the dialog needs of a module that may not be registered here. */
export interface IntroAbout {
  name: string
  icon?: string | null
  summary?: string | null
}

export function ModuleList({
  registry,
  onCanvas,
  onPlace,
  onUnplace,
  onLookAgain,
  onIntro,
  openAtFirst,
}: {
  registry: RegistryView | null
  onCanvas: Set<string>
  onPlace(id: string): void
  onUnplace(id: string): void
  /** Sweep the registry again: an install has just registered something. */
  onLookAgain?(): void
  /**
   * Open a module's introduction (protocol 2.57.0) — or its "How to use" when it has none, or the line
   * it says about itself — in the app's introduction dialog, with "Add to this kehikko". Given: a "?"
   * on every row, installed or not; the introduction is read without running the module.
   */
  onIntro?(id: string, about: IntroAbout): void
  /** The rows open when the menu opens; none by default. A test opens them. */
  openAtFirst?: readonly string[] | 'all'
}) {
  const [query, setQuery] = useState('')
  const official = useOfficial(onLookAgain)
  /* Which rows are open: kept for as long as the menu is (the popover unmounts this on close), never stored. */
  const [opened, setOpened] = useState<ReadonlySet<string> | 'all'>(() => (openAtFirst === 'all' ? 'all' : new Set(openAtFirst ?? [])))
  const isOpen = (id: string) => opened === 'all' || opened.has(id)
  const setRow = (id: string, to: boolean, every: readonly string[]) =>
    setOpened((was) => {
      const now = new Set(was === 'all' ? every : was)
      if (to) now.add(id)
      else now.delete(id)
      return now
    })

  if (!registry) return <p className="text-muted-foreground p-4 text-sm">Reading the modules…</p>

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

  /* What a module works with — what it follows, narrows to, consumes and provides — is not in the
     row: it is in the "What <name> is" dialog (`worksWithSaid`), with the rest of the long words. */
  const sections = arrange(rows, query)
  const stale = staleLine(official.standing)
  const every = rows.map((row) => row.id)
  const toggle = (id: string) => setRow(id, !isOpen(id), every)

  /*
   * The keyboard: Up and Down move between rows, Right (or Enter, which presses the name) opens one
   * and Right again goes to its one thing to do, Left closes it and comes back to its name.
   */
  function onKeys(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, [role="alert"]')) return
    const row = target.closest<HTMLElement>('[data-module-row]')
    const id = row?.dataset.moduleRow
    if (!row || !id) return
    const name = row.querySelector<HTMLElement>('[data-module-row-toggle]')
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const names = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-module-row-toggle]')]
      const next = names[names.indexOf(name!) + (event.key === 'ArrowDown' ? 1 : -1)]
      event.preventDefault()
      next?.focus()
    } else if (event.key === 'ArrowRight' && target === name) {
      event.preventDefault()
      if (!isOpen(id)) setRow(id, true, every)
      else row.querySelector<HTMLElement>('[data-row-primary]')?.focus()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setRow(id, false, every)
      name?.focus()
    }
  }

  return (
    <div className="flex max-h-[70vh] min-w-0 flex-col" data-module-list="">
      <div className="space-y-2 border-b p-3">
        <h2 className="text-sm font-medium">Kehikko modules</h2>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, what it does, category or scope"
          aria-label="search modules"
          className="h-7 text-xs"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return
            const first = event.currentTarget.closest('[data-module-list]')?.querySelector<HTMLElement>('[data-module-row-toggle]')
            if (!first) return
            event.preventDefault()
            first.focus()
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto" onKeyDown={onKeys}>
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
                      open={isOpen(row.id)}
                      onToggle={() => toggle(row.id)}
                      onInstall={() => (row.entry.mine ? official.installMine(row.id) : official.install(row.id))}
                      onRemove={row.entry.mine ? () => official.remove(row.id) : undefined}
                      refused={official.refused.get(row.id) ?? null}
                      onIntro={onIntro ? () => onIntro(row.id, { name: row.name, icon: row.entry.icon ?? null, summary: row.summary }) : undefined}
                    />
                  ) : (
                    <ModuleRow
                      key={row.id}
                      row={row}
                      open={isOpen(row.id)}
                      onToggle={() => toggle(row.id)}
                      onPlace={() => onPlace(row.id)}
                      onUnplace={() => onUnplace(row.id)}
                      onRemove={row.mine ? () => official.remove(row.id) : undefined}
                      onUninstall={() => official.uninstall(row.id)}
                      refused={official.refused.get(row.id) ?? null}
                      onIntro={onIntro ? () => onIntro(row.id, { name: row.name, summary: row.summary }) : undefined}
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
    uninstall: (id: string) => press(id, () => uninstallModule(id)),
    adopt: (id: string) => press(id, () => adoptMine(id)),
    again: () => setAsked((n) => n + 1),
  }
}

/**
 * One row, folded or open. Folded it is one line: the dot, the icon, the NAME — which wraps before it
 * is ever cut, and never gives way to anything beside it — and at most one short status at the end,
 * then the "?". Badges go on a line of their own under the name. Opened (a click on the name, Right or
 * Enter) it says one sentence, the one thing to do, how far an install has got, and at the foot
 * Remove and Uninstall side by side. Everything longer — what it is, its introduction, how to use
 * it, what it works with, its version — is in the "What <name> is" dialog the "?" opens.
 */
function RowShell({
  id,
  name,
  open,
  onToggle,
  dot,
  icon,
  status,
  badges,
  onIntro,
  children,
  progress = null,
  muted = false,
}: {
  id: string
  name: string
  open: boolean
  onToggle(): void
  dot: ReactNode
  icon: ReactNode
  status: ReactNode
  badges: ReactNode[]
  onIntro?(): void
  children: ReactNode
  /** An install or update on its way: inside this row, under its name, folded or open. */
  progress?: ReactNode
  muted?: boolean
}) {
  const body = `module-row-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`
  const shown = badges.filter(Boolean)
  return (
    <li data-module-row={id} data-open={open ? '' : undefined} className="px-2 py-1.5">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          data-module-row-toggle=""
          aria-expanded={open}
          aria-controls={open ? body : undefined}
          onClick={onToggle}
          className="hover:bg-muted/50 focus-visible:ring-ring/50 flex min-w-0 flex-1 items-start gap-1.5 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2"
        >
          <ChevronRight className={`text-muted-foreground mt-1 size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
          <span className="mt-1.5 flex shrink-0">{dot}</span>
          <span className={`mt-0.5 flex shrink-0 ${muted ? 'opacity-70' : ''}`}>{icon}</span>
          {/* The name gets the room: it wraps, and is never truncated for the status beside it. */}
          <span data-module-name="" className={`min-w-0 flex-1 text-sm leading-snug font-medium [overflow-wrap:anywhere] ${muted ? 'opacity-70' : ''}`}>
            {name}
          </span>
        </button>
        {status ? <span className="flex min-h-6 shrink-0 items-center">{status}</span> : null}
        {onIntro ? <IntroButton name={name} onIntro={onIntro} /> : null}
      </div>
      {shown.length ? (
        <div data-module-badges="" className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 pl-[3.25rem]">
          {shown}
        </div>
      ) : null}
      {progress ? (
        <div data-module-progress="" className="mt-1 pr-1 pl-[3.25rem]">
          {progress}
        </div>
      ) : null}
      {open ? (
        <div id={body} data-module-row-body="" className="mt-1 space-y-1.5 pr-1 pb-1 pl-[3.25rem]">
          {children}
        </div>
      ) : null}
    </li>
  )
}

/** The one short status at the end of a folded row; it is what gives way when room runs out, never the name. */
function Status({ children, tone = 'muted', label }: { children: ReactNode; tone?: 'muted' | 'warn'; label?: string }) {
  return (
    <span
      data-row-status=""
      title={label}
      className={`max-w-[7rem] truncate text-[11px] ${tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
    >
      {children}
    </span>
  )
}

/** The foot of an open row: Remove (from this kehikko) and Uninstall (from this computer), side by side. */
function RowFoot({ children }: { children: ReactNode }) {
  return (
    <div data-row-foot="" className="flex flex-wrap items-start gap-x-3 gap-y-1 pt-0.5">
      {children}
    </div>
  )
}

/** A small button of a row's foot. */
function FootButton({ children, onClick, hint }: { children: ReactNode; onClick(): void; hint: string }) {
  return (
    <Hint label={hint} side="bottom">
      <button type="button" className="text-muted-foreground hover:text-foreground text-[11px] underline" onClick={onClick}>
        {children}
      </button>
    </Hint>
  )
}

const REMOVE_HINT = 'take it off this kehikko — it stays registered, and stays on any other kehikko'
const UNINSTALL_HINT = 'take it off this computer and every kehikko (the “remove” button only takes it off this one)'

/** The one sentence an open row says. */
function Sentence({ text }: { text: string }) {
  const said = firstSentence(text)
  return said ? <p className="text-muted-foreground text-xs leading-relaxed" data-row-sentence="">{said}</p> : null
}

/**
 * An official module that is not on this machine: greyed, because it cannot be placed yet, and under
 * the registered rows of its shelf. Opened, one button installs it; while it installs the bar says
 * which step it is on; a failure is the server's sentence, and the button tries again. One that needs
 * a newer app than this one says so and has no button: the host would refuse the module once here.
 */
function AvailableRow({
  row,
  open,
  onToggle,
  onInstall,
  onRemove,
  refused,
  onIntro,
}: {
  row: Available
  open: boolean
  onToggle(): void
  onInstall(): void
  /** Open "What <name> is", read from the release an install would take: the "?". */
  onIntro?(): void
  /** One of the person's own: take it off My modules (and delete what an earlier attempt cloned). */
  onRemove?(): void
  refused: string | null
}) {
  const install = row.entry.install
  /* How far it has got, step by step, with a bar (`StepProgress`); a failure says the step and why. */
  const job = useJob(row.id)
  const shownJob = job && job.kind === 'install' && (working(install) || job.failed) ? job : null
  const isWorking = working(install)
  const failed = install?.state === 'failed' ? install.why : refused
  const newer = row.entry.newer
  const status =
    isWorking ? (
      <Status>installing</Status>
    ) : failed ? (
      <Status tone="warn">failed</Status>
    ) : (
      <Status>not installed</Status>
    )
  const badges = [
    newer ? (
      <Badge key="newer" variant="outline" className="text-muted-foreground cursor-default px-1.5 py-0 text-[10px] font-normal" title={protocolDetailSaid(newer.protocol, newer.has)}>
        needs a newer Kehikot
      </Badge>
    ) : null,
    row.entry.mine ? <AddedByYou key="mine" repo={repoSaid(row.entry)} /> : null,
  ]
  return (
    <RowShell
      id={row.id}
      name={row.name}
      open={open}
      onToggle={onToggle}
      muted
      dot={<span className="border-muted-foreground/50 size-1.5 rounded-full border" aria-label="not installed" title="not installed" />}
      icon={<ModuleIcon id={row.id} icon={row.entry.icon} name={row.name} className="text-muted-foreground size-3.5" />}
      status={status}
      progress={shownJob ? <StepProgress job={shownJob} /> : null}
      badges={badges}
      onIntro={onIntro}
    >
      <Sentence text={row.summary} />
      {newer ? (
        <p className="text-muted-foreground text-xs leading-relaxed" title={protocolDetailSaid(newer.protocol, newer.has)} data-needs-newer>
          {newer.app ? `Needs Kehikot ${newer.app} or later.` : 'Needs a newer version of Kehikot than this one.'}
        </p>
      ) : failed ? (
        <p role="alert" className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
          <GitSaid said={failed} />
        </p>
      ) : install?.state === 'installing' ? (
        <p className="text-muted-foreground text-xs">{installStepSaid(install.step)}…</p>
      ) : null}
      {newer ? null : (
        <Hint label={`clone ${repoSaid(row.entry)}, install it and register it on this computer`} side="bottom">
          <Button variant="secondary" size="sm" className="h-6 px-2 text-xs" data-row-primary="" disabled={isWorking} onClick={onInstall}>
            {isWorking ? 'Installing…' : failed ? 'Try again' : 'Install'}
          </Button>
        </Hint>
      )}
      {onRemove && !isWorking ? (
        <RowFoot>
          <RemoveMine name={row.name} installed={false} onRemove={onRemove} />
        </RowFoot>
      ) : null}
    </RowShell>
  )
}

const working = (install: Available['entry']['install']): boolean => install?.state === 'installing'

/** An install's step from an older host, which says no more than this. */
function installStepSaid(step: string): string {
  return step === 'cloning' ? 'Downloading' : step === 'installing' ? 'Installing dependencies' : step === 'preparing' ? 'Building the page' : step === 'registering' ? 'Registering' : step
}

function ModuleRow({
  row,
  open,
  onToggle,
  onPlace,
  onUnplace,
  onRemove,
  onUninstall,
  refused,
  onIntro,
}: {
  row: Registered
  open: boolean
  onToggle(): void
  onPlace(): void
  onUnplace(): void
  /** One of the person's own: take it off this computer. */
  onRemove?(): void
  /** Uninstall: off this computer and every kehikko; asked once first. */
  onUninstall(): void
  /** Why the last press on it was refused. */
  refused?: string | null
  /** Open "What <name> is" (its introduction, how to use it, what it works with): the "?". */
  onIntro?(): void
}) {
  const { presence, placed } = row
  const trouble = attention(presence)
  const job = useJob(row.id)
  const shownJob = job && (presence.lifecycle === 'installing' || presence.lifecycle === 'updating' || job.failed) ? job : null
  /* The word at the end, only where the dot's colour is not enough: what the host itself is doing
     (asleep, starting, updating), and a module it cannot speak to. Plain "not running" gets no word —
     it is the resting state of the list. */
  const word = presence.lifecycle ?? (presence.condition === 'incompatible' ? 'incompatible' : null)
  const deprecated = deprecatedSaid(presence)
  const status =
    trouble || refused ? (
      <Status tone="warn" label={trouble ?? refused ?? undefined}>
        {word ?? 'needs you'}
      </Status>
    ) : word ? (
      <Status>{word}</Status>
    ) : placed ? (
      <Status>{HERE}</Status>
    ) : null
  const badges = [
    deprecated ? (
      <Hint key="deprecated" label={deprecated} side="top">
        <Badge variant="outline" className="cursor-default border-amber-600/50 px-1.5 py-0 text-[10px] font-normal text-amber-700 dark:text-amber-400">
          Deprecated
        </Badge>
      </Hint>
    ) : null,
    /* What its content belongs to (protocol 2.29.0): its default scope, the line and the others in the tooltip. */
    row.scope ? <ScopeChip key="scope" scope={row.scope} /> : null,
    row.mine ? <AddedByYou key="mine" repo={row.mine.repo} /> : null,
  ]
  return (
    <RowShell
      id={row.id}
      name={row.name}
      open={open}
      onToggle={onToggle}
      dot={<ConditionDot condition={presence.condition} lifecycle={presence.lifecycle} />}
      icon={<ModuleIcon id={row.id} name={row.name} className="text-muted-foreground size-3.5" />}
      status={status}
      progress={shownJob ? <StepProgress job={shownJob} /> : null}
      badges={badges}
      onIntro={onIntro}
    >
      <Sentence text={row.summary} />
      {refused ? (
        <p role="alert" className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
          {refused}
        </p>
      ) : null}
      {trouble ? (
        <p role="alert" className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
          {trouble}
        </p>
      ) : null}
      {placed ? null : (
        <Hint label="put it on this kehikko" side="bottom">
          <Button variant="secondary" size="sm" className="h-6 px-2 text-xs" data-row-primary="" onClick={onPlace}>
            Add to this kehikko
          </Button>
        </Hint>
      )}
      <Details row={row} shown={trouble} onRemove={onRemove} />
      <RowFoot>
        {placed ? (
          <FootButton hint={REMOVE_HINT} onClick={onUnplace}>
            Remove
          </FootButton>
        ) : null}
        <UninstallAsk name={row.name} own={presence.own === true} onUninstall={onUninstall} />
      </RowFoot>
    </RowShell>
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
            <dt>module protocol</dt>
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
      {/* The list can come to name another repository for a module that is already here. Nothing
          follows it there; the details say so. */}
      {row.elsewhere ? (
        <p className="mt-1 leading-relaxed break-words">
          The official list names {row.elsewhere.listed} for this module. This one comes from {row.elsewhere.from} and stays there.
        </p>
      ) : null}
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
/**
 * Uninstall: take the module off this computer, as against "remove", which takes it off this kehikko.
 * Asks once, in the words of `uninstallSaid`.
 */
function UninstallAsk({ name, own, onUninstall }: { name: string; own: boolean; onUninstall(): void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <FootButton hint={UNINSTALL_HINT} onClick={() => setAsking(true)}>
        Uninstall
      </FootButton>
    )
  }
  return (
    <p role="alert" className="text-muted-foreground basis-full text-[11px] leading-relaxed">
      {uninstallSaid(name, own)}{' '}
      <button
        type="button"
        className="text-foreground underline"
        onClick={() => {
          setAsking(false)
          onUninstall()
        }}
      >
        {own ? 'Unregister' : 'Uninstall'}
      </button>{' '}
      <button type="button" className="underline" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </p>
  )
}

function RemoveMine({ name, installed, onRemove }: { name: string; installed: boolean; onRemove(): void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button type="button" className="text-muted-foreground hover:text-foreground mt-1 block text-[11px] underline" onClick={() => setAsking(true)}>
        {installed ? 'Remove from this computer' : 'Remove from my modules'}
      </button>
    )
  }
  return (
    <p className="text-muted-foreground mt-1 basis-full text-[11px] leading-relaxed">
      {installed
        ? `This stops ${name}, deletes the copy Kehikot installed, and takes it off My modules. What it kept in your projects stays. `
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
        <dt>works with</dt>
        <dd className="break-all" title={checked.protocol ? protocolDetailSaid(checked.protocol) : undefined} data-works-with>
          {checked.protocol ? (checked.app ? `Kehikot ${checked.app} and later` : checked.newer ? 'a newer Kehikot than this one' : 'this Kehikot') : 'does not say'}
        </dd>
      </dl>
      {checked.newer ? (
        <p className="leading-relaxed text-amber-600 dark:text-amber-400">
          <span title={protocolDetailSaid(checked.newer.protocol, checked.newer.has)}>
            It needs {checked.newer.app ? `Kehikot ${checked.newer.app} or later` : 'a newer Kehikot than this one'}
          </span>
          , so it cannot be installed here.
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
