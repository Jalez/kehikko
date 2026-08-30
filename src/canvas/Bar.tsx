import {
  ArrowDownLeft,
  ArrowUpRight,
  Compass,
  LayoutGrid,
  Moon,
  MousePointerClick,
  PanelTop,
  PanelTopClose,
  Sun,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import type { Canvas } from '@/host/canvases.ts'
import type { Subject } from '@/host/context.ts'
import type { Presence, RegistryView } from '@/host/registry.ts'
import type { Focus } from '@/host/focus.ts'
import {
  labelFor,
  relate,
  sentenceFor,
  type Placings,
  type Relationship,
} from '@/host/relations.ts'
import type { Theme } from '@/host/theme.ts'
import { Canvases } from './Canvases.tsx'
import { ConditionDot } from './Conditions.tsx'
import { Hint } from './Hint.tsx'

/**
 * The whole of the host's own interface.
 *
 * One hairline strip, thirty-two pixels tall. On the left, which canvas this is
 * and what it is about; on the right, a way to change how the canvas is drawn
 * and a way to put a module on it. There is no dashboard, no home screen, no activity summary and
 * no marketplace, because the host has nothing to put on one — it holds no data
 * about anybody's work, installs nothing, and updates nothing. A host that drew
 * a home screen would be drawing one about somebody else's programs.
 *
 * Every control here is an icon and every icon has a tooltip. See `Hint.tsx`
 * for why that is a rule rather than a nicety, and why `title` was not enough.
 *
 * The design intent is "almost absent while you are working in a module". This
 * strip is the concrete version of that: it is above the canvas rather than
 * around it, it is the colour of the canvas, and nothing in it moves or blinks.
 *
 * It carries no rule under it either. A border would draw a line between the
 * host and the work, and there is nothing on this side of that line worth
 * separating off -- the strip is the same colour as the canvas, so a rule would
 * be the only thing announcing that the host is a place. The panes have edges
 * of their own and those edges are the ones that mean something.
 */
export function Bar({
  registry,
  canvases,
  open,
  placed,
  subject,
  onOpen,
  onRename,
  onCreate,
  onDelete,
  onSubject,
  onPlace,
  onUnplace,
  focus,
  onFocus,
  theme,
  onTheme,
}: {
  registry: RegistryView | null
  canvases: readonly Canvas[]
  open: Canvas | null
  placed: readonly string[]
  subject: Subject
  onOpen(id: number): void
  onRename(name: string): void
  onCreate(): void
  onDelete(id: number): void
  onSubject(subject: Subject): void
  onPlace(id: string): void
  onUnplace(id: string): void
  /** Whether the pane headers are out of the layout. See `host/focus.ts`. */
  focus: Focus
  onFocus(): void
  theme: Theme
  onTheme(): void
}) {
  const presences = registry?.presences ?? []
  const onCanvas = new Set(placed)
  const notRunning = presences.filter((p) => p.condition !== 'ready').length

  return (
    /* One provider for the strip. Every `Hint` inside it brings its own as a
       fallback, so nothing depends on this being here; it is here so that
       moving between two controls shows the second tooltip immediately instead
       of waiting out the delay again, which is what makes a row of icons
       readable in one pass rather than four. */
    <TooltipProvider delayDuration={400} skipDelayDuration={300}>
      <header className="bg-background flex h-8 shrink-0 items-center gap-1 px-2">
        <Canvases
          canvases={canvases}
          open={open}
          onOpen={onOpen}
          onRename={onRename}
          onCreate={onCreate}
          onDelete={onDelete}
        />

        <span className="bg-border mx-1 h-4 w-px shrink-0" />

        {/*
         * What the canvas is about. One field, and the argument for there being
         * exactly one is in `host/context.ts`: a canvas has no open document, so
         * the honest reading of `roadmap.context` here is "what this workspace is
         * about", and six modules around one epic are six views of one thing.
         */}
        <Hint label="the epic every module on this kehikko is shown" align="start">
          <Input
            value={subject.epic ?? ''}
            onChange={(event) => onSubject({ ...subject, epic: event.target.value.trim() || null })}
            placeholder="what this kehikko is about"
            aria-label="the epic this kehikko is about"
            spellCheck={false}
            className="hover:border-input focus-visible:border-ring h-6 w-56 border-transparent bg-transparent font-mono text-xs"
          />
        </Hint>

        <span className="flex-1" />

        {/* The one number worth putting on the frame itself: how many registered
            programs are not answering. Silence is the common condition and the one
            a person can act on, and a canvas full of working modules shows nothing
            here at all. */}
        {notRunning > 0 ? (
          <Hint label="registered programs that are not answering at their address">
            <span className="text-muted-foreground cursor-default text-[11px]">{notRunning} not running</span>
          </Hint>
        ) : null}

        {/*
         * Light or dark. It says what it will DO rather than what it is —
         * "switch to light", with the sun on it — because an icon showing the
         * current state and an icon showing the destination are the same two
         * pictures, and half of everyone reads it the wrong way round. A label
         * settles it, and this control has room for one.
         *
         * The theme goes out to every module in `roadmap.context` as well, so
         * a page inside a pane is not left bright inside a dark canvas.
         */}
        {/*
         * Focus mode: the pane headers out of the layout, and back on hover.
         *
         * Beside the theme rather than in a menu, because it is the same kind
         * of thing — a statement about how you want the canvas drawn while you
         * look at it, kept in a cookie, and true of the whole application
         * rather than of one kehikko.
         *
         * The label says what it does to the headers rather than naming the
         * mode. "Focus mode" is a phrase that means something different in
         * every program that has one, and this control has room for a sentence.
         */}
        <Hint
          label={
            focus === 'on'
              ? 'pane headers are out of the way — they appear when you reach for them. Press to keep them drawn'
              : 'drop the pane headers, and show one when the pointer is near the top of its pane'
          }
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={focus === 'on' ? 'keep the pane headers drawn' : 'drop the pane headers'}
            aria-pressed={focus === 'on'}
            className={
              focus === 'on'
                ? 'text-foreground size-6'
                : 'text-muted-foreground hover:text-foreground size-6'
            }
            onClick={onFocus}
          >
            {focus === 'on' ? <PanelTopClose className="size-3" /> : <PanelTop className="size-3" />}
          </Button>
        </Hint>

        <Hint label={theme === 'dark' ? 'switch to light' : 'switch to dark'}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={theme === 'dark' ? 'switch to light' : 'switch to dark'}
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={onTheme}
          >
            {theme === 'dark' ? <Sun className="size-3" /> : <Moon className="size-3" />}
          </Button>
        </Hint>

        {/*
         * There used to be a ↻ here, and it is worth writing down why it went.
         *
         * It swept the registry: it asked every registered program again what
         * it is, without reloading the page. That capability is NOT redundant
         * and has not been removed — see `App.tsx`, which now does it on its
         * own. A reload would sweep too, and would also destroy every module's
         * document: a terminal session mid-command, a half-typed item, every
         * scroll position on the canvas. The whole persistent-iframe design in
         * `Frames.tsx` exists to prevent exactly that, and the button was the
         * only thing that could re-read the registry without it.
         *
         * What was wrong with it was the button, not the sweep. Its purpose was
         * not guessable from an icon in a strip — the person who owns this asked
         * what it was for — and a control nobody can name is a control that gets
         * pressed by accident or never. The sweep now happens when the window
         * comes back to the front and after anything that changes what is
         * registered, which are the two moments somebody would have pressed it.
         */}

        <Popover>
          <Hint label="what is registered, and what is on this kehikko" align="end">
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="modules"
                className="text-muted-foreground hover:text-foreground size-6"
              >
                <LayoutGrid className="size-3" />
              </Button>
            </PopoverTrigger>
          </Hint>
          <PopoverContent align="end" className="w-96 p-0">
            <ModuleList
              registry={registry}
              onCanvas={onCanvas}
              canvases={canvases}
              open={open}
              onPlace={onPlace}
              onUnplace={onUnplace}
            />
          </PopoverContent>
        </Popover>
      </header>
    </TooltipProvider>
  )
}

/**
 * Everything registered, whether or not it is on the canvas.
 *
 * This is a list of what the person put on their own machine, not a catalogue
 * of what they could install — the host has no such catalogue and will not grow
 * one. A module that is registered and not on the canvas is here waiting; a
 * module that is registered and not running is here saying so, which is the
 * whole reason `silent` is a condition rather than an absence.
 */
function ModuleList({
  registry,
  onCanvas,
  canvases,
  open,
  onPlace,
  onUnplace,
}: {
  registry: RegistryView | null
  onCanvas: Set<string>
  canvases: readonly Canvas[]
  open: Canvas | null
  onPlace(id: string): void
  onUnplace(id: string): void
}) {
  if (!registry) return <p className="text-muted-foreground p-4 text-sm">Asking the host…</p>

  const { presences, sweep } = registry

  if (!presences.length) {
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

  return (
    <div className="max-h-[70vh] overflow-auto">
      <ul className="divide-y">
        {presences.map((presence) => (
          <ModuleRow
            key={presence.id}
            presence={presence}
            placed={onCanvas.has(presence.id)}
            relationships={relationships.get(presence.id) ?? []}
            onPlace={() => onPlace(presence.id)}
            onUnplace={() => onUnplace(presence.id)}
          />
        ))}
      </ul>
      <div className="space-y-2 border-t p-3">
        <p className="text-muted-foreground font-mono text-[11px] break-all">{sweep.dir}</p>
        <Rejected rejected={sweep.rejected} />
      </div>
    </div>
  )
}

function ModuleRow({
  presence,
  placed,
  relationships,
  onPlace,
  onUnplace,
}: {
  presence: Presence
  placed: boolean
  /** What this module touches, and how. Empty for most of them, honestly. */
  relationships: readonly Relationship[]
  onPlace(): void
  onUnplace(): void
}) {
  return (
    <li className="flex items-start gap-2.5 p-3">
      <span className="mt-1.5">
        <ConditionDot condition={presence.condition} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{presence.name ?? presence.id}</span>
          {presence.condition !== 'ready' ? (
            <Badge variant="outline" className="text-muted-foreground shrink-0">
              {presence.condition}
            </Badge>
          ) : null}
        </div>
        {/* The sentence, in the list as well as in the pane. A person deciding
            what to put on the canvas is deciding about a program that may not be
            running, and finding that out after placing it is a worse order. */}
        <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{presence.line}</p>
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
         * a two-hundred pixel pane an eleven-hundred pixel floor. Nothing in a
         * badge here is longer than a module's name; the sentence is in the
         * tooltip, where there is room for it.
         */}
        {relationships.length ? (
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
            {relationships.map((relationship) => (
              <RelationBadge
                key={`${relationship.kind}:${relationship.extension ?? ''}`}
                relationship={relationship}
                module={presence.name ?? presence.id}
              />
            ))}
          </div>
        ) : null}
        {presence.module?.mcp ? (
          <p className="text-muted-foreground mt-1 font-mono text-[11px] break-all">
            agents: {presence.module.mcp.url}
          </p>
        ) : null}
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
  const Icon =
    relationship.kind === 'emits'
      ? ArrowUpRight
      : relationship.kind === 'consumes'
        ? ArrowDownLeft
        : relationship.kind === 'navigation'
          ? Compass
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
