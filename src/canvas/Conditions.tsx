import { CircleSlash, Moon, PlugZap, Unplug } from 'lucide-react'
import type { ModuleCondition } from 'kehikot-module-protocol'

import { cn } from '@/lib/utils'
import { coverSentence, type Waiting } from '@/host/standing.ts'
import { dotOf, type RunLook, type RunShape } from '@/host/runState.ts'
import { ModuleIcon } from './ModuleIcon.tsx'
import { StepProgress, useJob } from './StepProgress.tsx'

/**
 * The three conditions, made distinguishable at a glance.
 *
 * A dot in a header and a panel where the module's page would be. The dot is
 * for scanning six containers at once; the panel is for the one that is wrong. They
 * carry the same fact, which is the whole idea — the design brief was "almost
 * absent while you are working in a module, completely legible when something
 * is wrong with one", and a host that whispered about a stopped program would
 * be failing the second half.
 *
 * ## The wording rule, which is the actual work here
 *
 * `silent` must never read as "this does not exist". A program that is not
 * running and a program that was never installed look identical from here —
 * both are an address with nothing on it — and the difference between them is
 * the difference between pressing start and searching the internet for
 * something that is not there. So every silent sentence this host writes names
 * the address, says the host expected a module at it, and says the program is
 * not running rather than not found. The word "missing" appears only with "not"
 * in front of it.
 *
 * The sentences themselves are not here. They are written where the fact is
 * established — `server/discover.ts` for a manifest that never came,
 * `src/host/conversation.ts` for a page that was greeted and did not answer —
 * because a sentence written next to the fact stays true when the fact changes,
 * and one written in a component drifts into being decoration.
 *
 * ## The fourth word that is not a fourth condition
 *
 * The host now stops a module nothing has needed for a while, and starts one
 * when a kehikko that has it is opened — see `server/lifecycle.ts`. Both leave
 * the module `silent`, because nothing is answering at its address, and both
 * would read as a fault if nothing else were said.
 *
 * They must not. "I stopped this on purpose and it comes back when you open a
 * canvas with it on" and "this is not running and I do not know why" are
 * different sentences leading to different actions, and a person who cannot
 * tell them apart goes looking for a fault that does not exist.
 *
 * So `lifecycle` travels beside `condition` rather than inside it. The
 * vocabulary a person learns stays at three words; what is added is not a new
 * kind of program state but a fact about what the HOST did, which is a
 * different sort of thing and is drawn like one — a moon rather than an unplugged
 * cable for a module put to sleep, and `ModuleCover` for everything that is on
 * its way: starting, installing, updating, restarting, loading.
 */

/** What the host has lately done, when it has done anything. See the essay above. */
export type Lifecycle = 'starting' | 'installing' | 'updating' | 'restarting' | 'asleep'

/**
 * The dot, and what it says in words.
 *
 * The meaning is `runStateOf` in `host/runState.ts`: green and a filled disc is "Running" and only
 * that; a pulsing grey disc is "Starting…"; a grey ring is asleep (it starts when a kehikko uses it);
 * a grey square is stopped or simply not running; an amber diamond is "Not answering"; a dashed ring is
 * "Not installed". The tooltip and the aria-label are the same sentence, so it is never colour alone.
 */
const SHAPE_CLASS: Record<RunShape, string> = {
  disc: 'size-1.5 rounded-full',
  ring: 'size-2 rounded-full border',
  square: 'size-1.5 rounded-[1px]',
  diamond: 'size-1.5 rotate-45 rounded-[1px]',
  dashed: 'size-2 rounded-full border border-dashed',
}

export function ConditionDot({
  condition,
  lifecycle,
  reached,
  stopped,
}: {
  condition: ModuleCondition
  lifecycle?: Lifecycle | 'loading'
  reached?: boolean
  stopped?: boolean
}) {
  const look = dotOf({ condition, lifecycle, reached, stopped })
  return <RunDot look={look} condition={condition} lifecycle={lifecycle} />
}

/** A dot for a state already decided, such as "Not installed" on a module not on this machine. */
export function RunDot({ look, condition, lifecycle }: { look: RunLook; condition?: ModuleCondition; lifecycle?: string }) {
  return (
    <span
      title={look.label}
      aria-label={look.label}
      role="img"
      data-run-state={look.state}
      data-shape={look.shape}
      data-condition={condition}
      data-lifecycle={lifecycle ?? undefined}
      className={cn('shrink-0', SHAPE_CLASS[look.shape], look.colour)}
    />
  )
}

/**
 * What fills a container when there is no page to frame.
 *
 * Deliberately not styled as an error. An amber panel with a warning triangle
 * would say "something has gone wrong with your computer"; what has actually
 * happened, nearly always, is that a program is not started yet. The panel is
 * quiet, the sentence is the loud part, and the icon distinguishes the two
 * conditions without either shouting.
 */
export function ConditionPanel({
  condition,
  lifecycle,
  title,
  line,
  detail,
  more,
  at,
  children,
}: {
  condition: ModuleCondition
  /** Only ever `asleep` here: every word that ends on its own is `ModuleCover`'s. */
  lifecycle?: 'asleep'
  /**
   * A heading above the line, for a module that does not fit this Kehikot:
   * "Monitor needs a newer Kehikot". Text, never markup: it holds the
   * module's name as written. Then the line is the one fact that says why.
   */
  title?: string
  line: string
  /** The last lines a module the host started printed, when its start failed. */
  detail?: string[]
  /**
   * More about the line, folded under "Show details": the stack of the error
   * a module's page said it failed with. Text, never markup — it is the
   * module's own output.
   */
  more?: string
  at: string
  children?: React.ReactNode
}) {
  /* A moon for a module the host put down, and the unplugged cable only for
     silence nobody asked for. The icon is
     what a person reads before the sentence — a container that shows the fault
     symbol and then explains it is fine has already said the wrong thing. */
  const Icon =
    lifecycle === 'asleep'
      ? Moon
      : condition === 'incompatible'
        ? PlugZap
        : condition === 'silent'
          ? Unplug
          : CircleSlash
  return (
    /* Centred on both axes, and held to a column narrower than the container.
       A container can be dragged to any width, and a sentence set flush to both
       edges of a wide one is a sentence nobody finishes — so the text is capped
       at a readable measure and the whole block sits in the middle of whatever
       room it was given. Centred rather than top-aligned because there is one
       thing here: this is not a page with a heading and content below it, it is
       a single statement about why the container is empty. */
    <div className="flex h-full min-w-0 flex-col items-center justify-center gap-3 overflow-x-hidden overflow-y-auto px-6 py-8 text-center">
      <Icon
        className={cn(
          'size-6',
          condition === 'incompatible' ? 'text-amber-400' : 'text-neutral-500',
        )}
        aria-hidden
      />
      {/* The sentence, at the size of prose rather than of a caption. It is the
          only thing in this container worth reading and the layout should say so.
          `text-balance` so a two-line sentence breaks into two even lines
          instead of a long one and an orphan. */}
      {title ? (
        <h2 className="text-foreground max-w-[46ch] text-balance text-sm font-medium leading-snug" data-testid="condition-title">
          {title}
        </h2>
      ) : null}
      <p
        className={cn(
          'max-w-[46ch] text-balance leading-relaxed',
          title ? 'text-muted-foreground text-xs' : 'text-foreground text-sm',
        )}
      >
        {line}
      </p>

      {/* What the program itself said before it stopped. Left-aligned and
          monospaced because it is output, not a sentence of the host's. */}
      {detail?.length ? (
        <pre
          data-testid="condition-detail"
          className="bg-muted text-muted-foreground max-h-32 w-full max-w-[64ch] overflow-x-hidden overflow-y-auto rounded px-2 py-1.5 text-left font-mono text-[11px] leading-snug break-all whitespace-pre-wrap"
        >
          {detail.join('\n')}
        </pre>
      ) : null}

      {more ? (
        <details data-testid="condition-more" className="pointer-events-auto w-full max-w-[64ch] text-left">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-center text-xs">Show details</summary>
          <pre className="bg-muted text-muted-foreground mt-1.5 max-h-40 overflow-x-hidden overflow-y-auto rounded px-2 py-1.5 font-mono text-[11px] leading-snug break-all whitespace-pre-wrap">
            {more}
          </pre>
        </details>
      ) : null}

      <p className="text-muted-foreground/70 max-w-full font-mono text-[11px] break-all">{at}</p>
      {children}
    </div>
  )
}

/**
 * The one cover for every moment a module's page is not ready yet.
 *
 * ## Why this is not a condition
 *
 * `ready`, `incompatible` and `silent` are what the host knows about a program.
 * This is none of them: something is on its way — the host ran the script, it
 * is installing, it is being restarted for an update, or the page is loading
 * and has not answered — and each of those ends on its own, as the module's
 * page or as a notice saying why not. Making them conditions would put
 * transient facts into the vocabulary a person uses for lasting ones.
 *
 * ## One design, and the sentence says which
 *
 * The same icon, in the same place, for all of them, so a module that goes
 * from "Updating" to "Loading" does not redraw the container twice on the way.
 * The icon is the MODULE's own (`CoverIcon`), breathing, so a person sees whose
 * page is coming; only the sentence changes (`coverSentence`). A page that is
 * loading says it in its own words when it gave some (protocol 2.84.0,
 * "Loading the plan…"), else "Loading <module>…".
 *
 * It is drawn by the host, on the theme's own card colour, over a frame that
 * is hidden while it is up — so nothing a module's document does or does not
 * paint in its first moments is ever on screen.
 *
 * This is the full size. A small or folded container draws the same facts
 * smaller (`Standing.tsx`, `host/coverFit.ts`), with the address in a tooltip.
 */
export function ModuleCover({
  state,
  at,
  detail,
  id,
  name,
  label,
}: {
  state: Waiting
  at: string
  detail?: string
  /** Whose cover: the icon is looked up by it. */
  id: string
  name: string
  /** The module's own words for `loading` (protocol 2.84.0). Text. */
  label?: string | null
}) {
  const job = useJob(id)
  return (
    <div
      className="flex h-full min-w-0 flex-col items-center justify-center gap-3 overflow-x-hidden overflow-y-auto px-6 py-8 text-center"
      data-testid="module-cover"
      data-state={state}
      role="status"
    >
      <CoverIcon id={id} name={name} className="size-10" />
      <p className="text-muted-foreground max-w-[46ch] text-balance text-sm leading-relaxed">{coverSentence(state, name, label)}</p>
      {/* An update under way says its step, how long, and a bar — never just "Updating". */}
      {job && (state === 'updating' || state === 'restarting' || state === 'installing') ? <StepProgress job={job} className="w-full max-w-[18rem] text-left" /> : null}
      {detail ? <p className="text-muted-foreground/80 max-w-[46ch] text-balance text-xs">{detail}</p> : null}
      <p className="text-muted-foreground/70 max-w-full font-mono text-[11px] break-all">{at}</p>
    </div>
  )
}

/**
 * The module's own icon, breathing: what every cover draws, at every size, so
 * the cover says whose page is on its way. Still under reduced motion
 * (`index.css`). Decorative: the sentence beside it, or the label of an
 * icon-only cover, says what it means.
 */
export function CoverIcon({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <span className={cn('module-cover-icon text-muted-foreground inline-flex shrink-0', className)} data-cover-icon={id} aria-hidden>
      <ModuleIcon id={id} name={name} className="size-full" />
    </span>
  )
}
