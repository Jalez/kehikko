import { LayoutGrid, Moon, PanelTop, PanelTopClose, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import type { Canvas } from '@/host/canvases.ts'
import type { Subject } from '@/host/context.ts'
import type { Epics as HeldEpics, Project, TrackerState } from '@/host/projects.ts'
import type { Part } from '@/host/parts.ts'
import { attention } from '@/host/moduleMenu.ts'
import type { RegistryView } from '@/host/registry.ts'
import type { Focus } from '@/host/focus.ts'
import type { Theme } from '@/host/theme.ts'
import { Canvases } from './Canvases.tsx'
import { Epics } from './Epics.tsx'
import { Parts, type Undividing } from './Parts.tsx'
import { Hint } from './Hint.tsx'
import { ModuleList } from './Modules.tsx'
import { Updates } from './Updates.tsx'
import { FeedbackButton } from './Feedback.tsx'
import { Projects } from './Projects.tsx'
import { ToolsMark } from './Tools.tsx'
import { KehikkoMark } from './Mark.tsx'
import { Trouble } from './Trouble.tsx'
import { TrackerReading } from './TrackerReading.tsx'

/**
 * The whole of the host's own interface.
 *
 * One hairline strip, thirty-two pixels tall. On the left, three controls in
 * the order the things themselves nest in — the PROJECT you are in, the EPIC
 * inside it, and then the KEHIKKO, which is a layout over both. On the right, a
 * way to change how the canvas is drawn and a way to put a module on it.
 *
 * The order is the argument. A project is a folder, its epics live inside it,
 * and a kehikko is one arrangement of containers over that pair — so reading the
 * strip left to right is reading the hierarchy outward-in, and changing a
 * control changes everything to its right and nothing to its left. Putting the
 * kehikko first, which is where it used to be, meant the narrowest thing on
 * screen was also the first, and the two selects that decide what it CONTAINS
 * came after it or, in the epic's case, was a box you typed a slug into. There is no dashboard, no home screen and no activity summary,
 * because the host has nothing to put on one — it holds no data about
 * anybody's work. A host that drew a home screen would be drawing one about
 * somebody else's programs. What it does carry is a list of the modules it
 * vouches for, in the module menu, so one that is not on the machine can be
 * found and installed without a terminal; see `Modules.tsx`.
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
 * be the only thing announcing that the host is a place. The containers have edges
 * of their own and those edges are the ones that mean something.
 */
export function Bar({
  registry,
  canvases,
  open,
  placed,
  subject,
  projects,
  project,
  held,
  onRetitleEpic,
  onCreateEpic,
  onDeleteEpic,
  onProject,
  onAddProject,
  onShareProject,
  onForgetProject,
  onOpen,
  onRename,
  onCreate,
  onDelete,
  onSubject,
  parts,
  pickedParts,
  onParts,
  undivided = null,
  onPlace,
  onUnplace,
  focus,
  onFocus,
  theme,
  onTheme,
  onTools,
  trouble,
  onLookAgain,
  looking,
  tracker = null,
  onRefreshTrackers = () => {},
}: {
  registry: RegistryView | null
  /** This project's kehikot, and no others. See `inProject`. */
  canvases: readonly Canvas[]
  open: Canvas | null
  placed: readonly string[]
  subject: Subject
  projects: readonly Project[]
  project: Project | null
  /** What this project holds, or null while it is still being read. */
  held: HeldEpics | null
  /**
   * Change what one of this project's epics is called. Never its slug — see
   * `Epics.tsx` on why those are two different operations and only one is here.
   */
  onRetitleEpic(slug: string, title: string): Promise<boolean>
  /** Make a new epic in this project and open it here. See `onCreateEpic` in `App.tsx`. */
  onCreateEpic(slug: string, title: string): Promise<boolean>
  /** Delete one epic's file from this project. See `onDeleteEpic` in `App.tsx`. */
  onDeleteEpic(slug: string): void
  onProject(id: number): void
  onAddProject(path: string): void
  /** Whether the open project's `.kehikot/` is committed with it. */
  onShareProject(id: number, shared: boolean): void
  /** Stop holding a folder as a project. Nothing on disk is deleted. */
  onForgetProject(id: number): void
  onOpen(id: number): void
  onRename(id: number, name: string): void
  onCreate(): void
  onDelete(id: number): void
  onSubject(subject: Subject): void
  /** The parts the open epic is divided into. Empty when it has none, and when no epic is open. */
  parts: readonly Part[]
  /** The ids of the ones the project is pointed at. Empty is the whole epic. */
  pickedParts: readonly string[]
  onParts(ids: string[]): void
  /** Where parts are made, and the press that goes there, for an epic with none. See `host/dividing.ts`. */
  undivided?: Undividing | null
  onPlace(id: string): void
  onUnplace(id: string): void
  /** Whether the container headers are out of the layout. See `host/focus.ts`. */
  focus: Focus
  onFocus(): void
  theme: Theme
  onTheme(): void
  /** Open the window about the host's own MCP door. See the plug below. */
  onTools(): void
  /** The host's own error line, or null. Drawn here; see `Trouble.tsx`. */
  trouble: string | null
  /** Sweep the registry now. */
  onLookAgain(): void
  looking: boolean
  /** The open project's tracker reading, or null with no project open. See `TrackerReading.tsx`. */
  tracker?: TrackerState | null
  onRefreshTrackers?(): void
}) {
  const presences = registry?.presences ?? []
  const onCanvas = new Set(placed)
  const needing = presences.filter((p) => attention(p) !== null).length

  return (
    /* One provider for the strip. Every `Hint` inside it brings its own as a
       fallback, so nothing depends on this being here; it is here so that
       moving between two controls shows the second tooltip immediately instead
       of waiting out the delay again, which is what makes a row of icons
       readable in one pass rather than four. */
    <TooltipProvider delayDuration={400} skipDelayDuration={300}>
      <header className="bg-background flex h-8 shrink-0 items-center gap-1 px-2">
        {/* Whose window this is, before anything it holds. The mark is the same
            one the update panel draws, still. */}
        <span className="text-foreground flex shrink-0 items-center gap-1.5 pr-1 text-xs font-medium select-none">
          <KehikkoMark working={false} className="size-4" />
          Kehikot
        </span>
        <span className="bg-border mx-1 h-4 w-px shrink-0" />

        {/*
         * The project. Everything else on this strip is inside it, so it comes
         * first — see `Projects.tsx`, and the essay above on why the order is
         * an argument rather than a preference.
         */}
        <Projects
          projects={projects}
          open={project}
          onOpen={onProject}
          onAdd={onAddProject}
          onShare={onShareProject}
          onForget={onForgetProject}
        />

        {/*
         * What the project is about. One epic, for every kehikko in it, and the
         * argument for there being exactly one is in `host/context.ts`. It sits
         * between the project and the kehikko and depends on only the first:
         * switching kehikko changes the layout and leaves this where it is.
         *
         * A select over the project's own epics rather than the field you used
         * to type a slug into. The host could not offer a list before, because
         * it had no project to read one from; now it has, and a field next to a
         * list of what exists is a way to make a typo authoritative.
         */}
        <Epics
          epic={subject.epic}
          held={held}
          hasProject={project !== null}
          onPick={(epic) => onSubject({ ...subject, epic })}
          /* Retitling does NOT touch the subject. The epic is the same epic; it
             is called something else. A control that moved the canvas onto what
             you had just renamed would be treating a label as an identity,
             which is the exact confusion this control is built around. */
          onRetitle={onRetitleEpic}
          /* Creating DOES move the subject, and `App.tsx` says why the two
             differ: a person who typed a title into a `+` has said which epic
             they want to be on. */
          onCreate={onCreateEpic}
          onDelete={onDeleteEpic}
        />

        {/*
         * Which parts of that epic. Directly after the epic and before the
         * kehikko, because it depends on the first and not on the second: a
         * kehikko is a layout and carries no focus. For an epic with no
         * parts it draws the way to make some. See `Parts.tsx`.
         */}
        <Parts parts={parts} picked={pickedParts} onPick={onParts} epic={subject.epic} undivided={undivided} />

        <span className="bg-border mx-1 h-4 w-px shrink-0" />

        <Canvases
          canvases={canvases}
          open={open}
          onOpen={onOpen}
          onRename={onRename}
          onCreate={onCreate}
          onDelete={onDelete}
        />

        <span className="flex-1" />

        <Trouble trouble={trouble} onLookAgain={onLookAgain} looking={looking} />

        {/* The project's shared tracker reading: its age, and "Refresh all". */}
        {tracker ? <TrackerReading tracker={tracker} onRefresh={onRefreshTrackers} /> : null}

        {/* The one number worth putting on the frame itself: how many modules
            need something from a person. Not how many are not running — modules
            sleep when nothing needs them, so that number was most of the list
            most of the time and said nothing. See `attention`. */}
        {needing > 0 ? (
          <Hint label="modules that need something from you — open Kehikko modules to see which, and what to do">
            <span className="cursor-default text-[11px] text-amber-600 dark:text-amber-400">
              {needing} {needing === 1 ? 'needs' : 'need'} attention
            </span>
          </Hint>
        ) : null}

        {/*
         * Light or dark. It says what it will DO rather than what it is —
         * "switch to light", with the sun on it — because an icon showing the
         * current state and an icon showing the destination are the same two
         * pictures, and half of everyone reads it the wrong way round. A label
         * settles it, and this control has room for one.
         *
         * The theme goes out to every module in `kehikot.context` as well, so
         * a page inside a container is not left bright inside a dark canvas.
         */}
        {/*
         * Focus mode: the container headers out of the layout, and back on hover.
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
              ? 'container headers are out of the way — they appear when you reach for them. Press to keep them drawn'
              : 'drop the container headers, and show one when the pointer is near the top of its container'
          }
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={focus === 'on' ? 'keep the container headers drawn' : 'drop the container headers'}
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

        {/*
         * The host's own MCP door, and whether an agent has been told about it.
         *
         * This strip is to the host what a container header is to a module, and
         * every module's header has this control — `ToolsMark`, the plug — so
         * a host that serves a door of its own (`server/mcp.ts`: what is on the
         * canvas and which containers are picked out) and offered nothing here
         * was the one door on the screen an agent could not be connected to
         * from the screen. The same component, deliberately: a second drawing
         * of "is the agent hearing this" would disagree with the first the day
         * either changed.
         *
         * Same weight as the module version and not louder for being the
         * host's. The essay in `Tools.tsx` is the argument: a connected door
         * gets the quietest control on the strip, and only an untold or a
         * stale one is loud. It sits with the right-hand cluster because that
         * is where the host talks about itself — how the canvas is drawn, what
         * is registered — and before the module list because the list is the
         * outermost thing on the strip and this is a fact about the host, not
         * about a module.
         *
         * `registry.host` is absent from a server older than this page, and
         * then nothing is drawn — the same silence a module with no door gets,
         * rather than a control that opens on a refusal.
         */}
        {/* Whether the host and its modules are behind GitHub. The tooltip
            says when that was last asked; a press asks now. See `Updates.tsx`. */}
        <Updates />

        <ToolsMark agent={registry?.host?.agent} name="this host" about="host" onOpen={onTools} />

        {/* Feedback on Kehikot itself, beside its plug — the same control every
            container header has for its module, filed in the host's own
            repository. See `Feedback.tsx`. */}
        <FeedbackButton module="host" name="Kehikot" kehikko={open?.name ?? null} epic={subject.epic} />

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
          <Hint label="Kehikko modules" align="end">
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Kehikko modules"
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
              onLookAgain={onLookAgain}
            />
          </PopoverContent>
        </Popover>
      </header>
    </TooltipProvider>
  )
}

