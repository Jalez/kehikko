import { CircleSlash, Moon, PlugZap, Unplug } from 'lucide-react'
import type { ModuleCondition } from 'kehikot-module-protocol'

import { cn } from '@/lib/utils'
import { COVER_WORDS, type Waiting } from '@/host/standing.ts'
import { KehikkoMark } from './Mark.tsx'

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

const dots: Record<ModuleCondition, string> = {
  ready: 'bg-emerald-400',
  incompatible: 'bg-amber-400',
  silent: 'bg-neutral-500',
}

/**
 * The dot for a module the host put to sleep or has just run.
 *
 * Dimmer than `silent` for asleep, because it is the one state on this canvas
 * that is working as intended, and a pulse for starting, because it is the one
 * that is about to change on its own. Neither is a colour: `silent` is already
 * the absence of one, and asleep is less than that rather than other than it.
 */
const WAITING = 'bg-neutral-400 animate-pulse'
const lifecycles: Record<Lifecycle | 'loading', string> = {
  starting: WAITING,
  installing: WAITING,
  updating: WAITING,
  restarting: WAITING,
  loading: WAITING,
  asleep: 'bg-neutral-600',
}

export function ConditionDot({ condition, lifecycle }: { condition: ModuleCondition; lifecycle?: Lifecycle | 'loading' }) {
  const said = lifecycle ?? condition
  return (
    <span
      title={said}
      aria-label={said}
      data-condition={condition}
      data-lifecycle={lifecycle ?? undefined}
      className={cn('size-1.5 shrink-0 rounded-full', lifecycle ? lifecycles[lifecycle] : dots[condition])}
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
  line,
  detail,
  at,
  protocols,
  children,
}: {
  condition: ModuleCondition
  /** Only ever `asleep` here: every word that ends on its own is `ModuleCover`'s. */
  lifecycle?: 'asleep'
  line: string
  /** The last lines a module the host started printed, when its start failed. */
  detail?: string[]
  at: string
  protocols?: { host: number; module: number | null; range: string }
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
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto px-6 py-8 text-center">
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
      <p className="text-foreground max-w-[46ch] text-balance text-sm leading-relaxed">{line}</p>

      {/*
       * Both numbers, always, for an incompatible module — the brief's own
       * requirement and a good one. "This module is incompatible" is a sentence
       * a person can do nothing with. "It speaks 3, this host speaks 2" tells
       * them which of the two programs to update, which is the entire decision
       * in front of them.
       */}
      {condition === 'incompatible' && protocols ? (
        /* Left-aligned inside the centred column, on purpose: it is a table of
           three facts to be compared down the page, and centring the rows would
           put the numbers on a ragged edge where the eye cannot line them up. */
        <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-left font-mono text-xs">
          <dt>module protocol</dt>
          <dd className="text-foreground">{protocols.module ?? 'unstated'}</dd>
          <dt>module speaks</dt>
          <dd className="text-foreground">{protocols.range}</dd>
          <dt>this host</dt>
          <dd className="text-foreground">{protocols.host}</dd>
        </dl>
      ) : null}

      {/* What the program itself said before it stopped. Left-aligned and
          monospaced because it is output, not a sentence of the host's. */}
      {detail?.length ? (
        <pre
          data-testid="condition-detail"
          className="bg-muted text-muted-foreground max-h-32 w-full max-w-[64ch] overflow-auto rounded px-2 py-1.5 text-left font-mono text-[11px] leading-snug whitespace-pre-wrap"
        >
          {detail.join('\n')}
        </pre>
      ) : null}

      <p className="text-muted-foreground font-mono text-xs break-all">{at}</p>
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
 * The same mark, in the same place, for all of them, so a module that goes
 * from "Updating" to "Loading" does not redraw the container twice on the way.
 * The mark is keyed on nothing: it draws itself once when the cover goes up
 * and breathes after. Only the sentence changes (`COVER_WORDS`).
 *
 * It is drawn by the host, on the theme's own card colour, over a frame that
 * is hidden while it is up — so nothing a module's document does or does not
 * paint in its first moments is ever on screen.
 */
export function ModuleCover({ state, at, detail }: { state: Waiting; at: string; detail?: string }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center"
      data-testid="module-cover"
      data-state={state}
      role="status"
    >
      <KehikkoMark working className="text-muted-foreground size-10" />
      <p className="text-muted-foreground max-w-[46ch] text-balance text-sm leading-relaxed">{COVER_WORDS[state]}</p>
      {detail ? <p className="text-muted-foreground/80 max-w-[46ch] text-balance text-xs">{detail}</p> : null}
      <p className="text-muted-foreground/70 font-mono text-[11px]">{at}</p>
    </div>
  )
}
