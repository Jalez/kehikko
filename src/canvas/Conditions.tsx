import { CircleSlash, PlugZap, Unplug } from 'lucide-react'
import type { ModuleCondition } from 'roadmap-module-protocol'

import { cn } from '@/lib/utils'

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
 */

const dots: Record<ModuleCondition, string> = {
  ready: 'bg-emerald-400',
  incompatible: 'bg-amber-400',
  silent: 'bg-neutral-500',
}

export function ConditionDot({ condition }: { condition: ModuleCondition }) {
  return (
    <span
      title={condition}
      aria-label={condition}
      data-condition={condition}
      className={cn('size-1.5 shrink-0 rounded-full', dots[condition])}
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
  line,
  at,
  protocols,
  children,
}: {
  condition: ModuleCondition
  line: string
  at: string
  protocols?: { host: number; module: number | null; range: string }
  children?: React.ReactNode
}) {
  const Icon = condition === 'incompatible' ? PlugZap : condition === 'silent' ? Unplug : CircleSlash
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
        className={cn('size-6', condition === 'incompatible' ? 'text-amber-400' : 'text-neutral-500')}
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

      <p className="text-muted-foreground font-mono text-xs break-all">{at}</p>
      {children}
    </div>
  )
}

/**
 * A module whose page is loading, and which has not answered yet.
 *
 * ## Why this is not a condition
 *
 * `ready`, `incompatible` and `silent` are what the host knows about a program.
 * This is not one of them: discovery has already said `ready`, the manifest read
 * fine, and the only thing outstanding is that the page has not finished
 * arriving and speaking. Making it a fourth condition would put a transient
 * fact into the vocabulary a person uses for lasting ones.
 *
 * ## Why it may exist at all
 *
 * The rule is that nothing moves on a timer nobody asked for, and that no
 * spinner is shown which cannot resolve. This one resolves both ways and
 * quickly: the module answers and the container becomes its page, or the greeting
 * goes unanswered and the conversation's own timeout turns this into the silent
 * notice, which says so in a sentence. There is no third outcome and no path
 * where this stays on screen.
 *
 * So it is allowed to move — one slow pulse, no spinner, nothing that suggests
 * progress is being measured, because none is. What it must not do is imply
 * that waiting longer will help.
 */
export function ConnectingPanel({ at }: { at: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      {/* The same size and place the icon takes in `ConditionPanel`, so the
          swap from this to a notice does not move anything the eye is on. */}
      <Unplug className="size-6 animate-pulse text-neutral-600" aria-hidden />
      <p className="text-muted-foreground max-w-[46ch] text-balance text-sm leading-relaxed">
        Loading its page, and waiting for it to answer.
      </p>
      <p className="text-muted-foreground/70 font-mono text-[11px]">{at}</p>
    </div>
  )
}
