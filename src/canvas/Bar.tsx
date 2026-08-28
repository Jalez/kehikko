import { LayoutGrid, RotateCw } from 'lucide-react'

import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import type { Canvas } from '@/host/canvases.ts'
import type { Subject } from '@/host/context.ts'
import type { Presence, RegistryView } from '@/host/registry.ts'
import { Canvases } from './Canvases.tsx'
import { ConditionDot } from './Conditions.tsx'
import { Hint } from './Hint.tsx'

/**
 * The whole of the host's own interface.
 *
 * One hairline strip, thirty-two pixels tall. On the left, which canvas this is
 * and what it is about; on the right, a way to look again and a way to put a
 * module on it. There is no dashboard, no home screen, no activity summary and
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
  onLookAgain,
  looking,
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
  onLookAgain(): void
  looking: boolean
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
        <Hint label="the epic every module on this canvas is shown" align="start">
          <Input
            value={subject.epic ?? ''}
            onChange={(event) => onSubject({ ...subject, epic: event.target.value.trim() || null })}
            placeholder="what this canvas is about"
            aria-label="the epic this canvas is about"
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

        <Hint label="ask every registered program again what it is">
          <Button
            variant="ghost"
            size="icon"
            aria-label="look again"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={onLookAgain}
            disabled={looking}
          >
            <RotateCw className={looking ? 'size-3 animate-spin' : 'size-3'} />
          </Button>
        </Hint>

        <Popover>
          <Hint label="what is registered, and what is on this canvas" align="end">
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
            <ModuleList registry={registry} onCanvas={onCanvas} onPlace={onPlace} onUnplace={onUnplace} />
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
  onPlace,
  onUnplace,
}: {
  registry: RegistryView | null
  onCanvas: Set<string>
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

  return (
    <div className="max-h-[70vh] overflow-auto">
      <ul className="divide-y">
        {presences.map((presence) => (
          <ModuleRow
            key={presence.id}
            presence={presence}
            placed={onCanvas.has(presence.id)}
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
  onPlace,
  onUnplace,
}: {
  presence: Presence
  placed: boolean
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
        {presence.module?.mcp ? (
          <p className="text-muted-foreground mt-1 font-mono text-[11px] break-all">
            agents: {presence.module.mcp.url}
          </p>
        ) : null}
      </div>
      <Hint
        label={
          placed
            ? 'take it off this canvas — it stays registered, and stays on any other canvas'
            : 'put it on this canvas'
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
