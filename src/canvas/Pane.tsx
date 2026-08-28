import { ChevronsDownUp, ChevronsUpDown, Pin, PinOff, X } from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import type { Presence } from '@/host/registry.ts'
import { ConditionDot, ConditionPanel, ConnectingPanel } from './Conditions.tsx'
import { Hint } from './Hint.tsx'

/**
 * One thing on the canvas — or rather, the frame around one thing.
 *
 * A hairline border, a header thin enough to be a grip rather than a title bar,
 * and then a body that is either empty or filled with the sentence explaining
 * why there is nothing in it. The header is the drag handle and the body is
 * not: a pane whose body dragged would be a pane a person cannot click inside,
 * and clicking inside is the entire point of the thing.
 *
 * ## The module's page is not in here
 *
 * The body is hollow, and its only job is to be somewhere the canvas can
 * measure. The page itself is positioned over it from a layer that outlives
 * every pane — see the essay in `Frames.tsx` for why a module's document has to
 * be created once and never moved, and why switching canvases would otherwise
 * reload everything on both of them.
 *
 * That split is why this component takes no context, no controls and no
 * watcher any more. It draws a box and a sentence. Everything that talks to a
 * module happens somewhere else.
 *
 * ## Why a notice can sit over a page that is still loading
 *
 * When a module's manifest answered but its page has not spoken yet, the pane
 * shows a panel and the page keeps loading behind it. Unmounting would destroy
 * a document that is, as far as anyone knows, still on its way, and would make
 * "did not answer in four seconds" a death sentence rather than an observation.
 * A module that answers late simply clears the panel and appears, which is what
 * a person expects of something that was merely slow.
 */
export function Pane({
  presence,
  condition,
  line,
  fault,
  settled,
  body,
  grow,
  onGrow,
  pinned,
  onPin,
  onRemove,
}: {
  presence: Presence
  /** The condition as the canvas currently understands it — see `App.tsx`. */
  condition: Presence['condition']
  line: string
  fault: string | null
  /**
   * Has the conversation reached a resting point?
   *
   * False from the moment the frame is mounted until the module answers the
   * greeting or the greeting times out. Discovery has already said `ready` by
   * then — it read the manifest — so `condition` alone cannot tell a page that
   * is still arriving from one that has arrived and is showing nothing.
   */
  settled: boolean
  /** Where the module's page goes. Handed to the canvas so it can be measured. */
  body: (element: HTMLElement | null) => void
  /** Whether this pane follows the height its module asks for. */
  grow: boolean
  onGrow(grow: boolean): void
  /** Whether this pane is pinned, and stops hearing about the canvas. */
  pinned: boolean
  onPin(pinned: boolean): void
  onRemove(): void
}) {
  const name = presence.name ?? presence.id

  return (
    /*
     * No background on the pane itself, and no pointer either.
     *
     * The module's page is painted UNDERNEATH this — see `App.tsx` — so
     * anything opaque here would hide it, and anything that takes the pointer
     * here would swallow clicks meant for it. The parts that need to be seen
     * and pressed opt back in one at a time: the header, the fault line, and
     * whichever notice is standing in for a page that is not there.
     *
     * The border stays, because the border is the pane. It is the only thing
     * that says where one module ends and the next begins.
     */
    <div className="pointer-events-none flex h-full flex-col overflow-hidden rounded-lg border">
      <header className="pane-grip bg-card pointer-events-auto flex h-8 shrink-0 cursor-move items-center gap-2 border-b px-2.5 select-none">
        <ConditionDot condition={condition} />
        {/*
         * The name, and the module's own description behind it.
         *
         * Every module used to print its name and its one-line summary at the
         * top of its own page, directly under this header, which said the name
         * again. Two costs: the name twice, and — the one that matters — a
         * fixed strip of prose at the top of a pane that is often only three
         * hundred pixels tall. In a short pane the description was competing
         * with the thing a person opened the module to look at.
         *
         * The host already has that sentence. `summary` is a manifest field and
         * this host reads it on every sweep, so nothing new crosses the wire and
         * no module has to be asked. It goes here, on the name, where a title
         * attribute belongs.
         *
         * Hover-only would be a real loss, so it is deliberately not the only
         * route: the modules list in the strip above shows every module's
         * sentence in full, always, next to its name. This is the convenience;
         * that is the place it is guaranteed to be readable.
         */}
        {presence.module?.summary ? (
          <Hint label={presence.module.summary} side="bottom" align="start">
            <span className="cursor-default truncate text-xs font-medium">{name}</span>
          </Hint>
        ) : (
          <span className="truncate text-xs font-medium">{name}</span>
        )}
        {presence.module?.version ? (
          <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
            {presence.module.version}
          </span>
        ) : null}
        <span className="flex-1" />

        {/*
         * Whether this pane follows the height its module asks for.
         *
         * Per pane rather than a setting somewhere, because it is a question
         * about how you want to read THIS thing: a list you scan wants to hold
         * its size and scroll, a summary you want all of wants to fit. The host
         * has no way to know which this is, so it asks by putting the switch on
         * the pane itself.
         *
         * It shows only when the module is actually speaking. Offering to
         * follow the height of a program that is not running would be offering
         * something that cannot happen.
         */}
        {condition === 'ready' ? (
          <Hint
            label={
              grow
                ? 'following the module’s height — press to keep this size instead'
                : 'holding the size you set — press to follow the module’s height'
            }
            side="left"
          >
            <Button
              variant="ghost"
              size="icon"
              aria-label={grow ? 'stop following the module’s height' : 'follow the module’s height'}
              aria-pressed={grow}
              className={
                grow
                  ? 'text-foreground size-6 cursor-default'
                  : 'text-muted-foreground hover:text-foreground size-6 cursor-default'
              }
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => onGrow(!grow)}
            >
              {grow ? <ChevronsDownUp className="size-3" /> : <ChevronsUpDown className="size-3" />}
            </Button>
          </Hint>
        ) : null}

        {/*
         * Pin: hold this pane where it is and stop telling it about the canvas.
         *
         * What it is for is two panes on two epics, side by side, to compare —
         * move the canvas and the pinned one keeps what it had.
         *
         * The module is told it is pinned, which is the whole reason this host
         * is allowed to have the button at all. A silent pin leaves a module
         * describing itself as showing the open epic while it shows a
         * remembered one, unable to tell a person's pin from the canvas not
         * having moved; this host refused to pin until the protocol grew a word
         * for it. See `pinned` in the protocol's `wire.ts`.
         *
         * Shown whatever the condition, unlike the height toggle: pinning is a
         * fact about the pane rather than a conversation with the program, and
         * a module that is not answering yet can still be pinned before it
         * does.
         */}
        <Hint
          label={
            pinned
              ? 'pinned — it keeps what it was last told, and is not hearing about this kehikko'
              : 'pin it — it will keep what it has while the rest of the kehikko moves'
          }
          side="left"
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={pinned ? 'let this pane follow the kehikko again' : 'pin this pane'}
            aria-pressed={pinned}
            className={
              pinned
                ? 'text-foreground size-6 cursor-default'
                : 'text-muted-foreground hover:text-foreground size-6 cursor-default'
            }
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onPin(!pinned)}
          >
            {pinned ? <Pin className="size-3" /> : <PinOff className="size-3" />}
          </Button>
        </Hint>

        <Hint label="take it off this kehikko — the program keeps running" side="left">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`take ${name} off the canvas`}
            className="text-muted-foreground hover:text-foreground -mr-1 size-6 cursor-default"
            /* Stops the grid reading the press as the start of a drag, which would
               make this button unpressable. */
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onRemove}
          >
            <X className="size-3" />
          </Button>
        </Hint>
      </header>

      {/* The hollow part. Its only jobs are to be measured — the page is
          positioned to match it — and to stay out of the way of what is
          showing through it. A notice, when there is one, is opaque and takes
          the pointer again; there is no page behind it worth seeing. */}
      <div ref={body} className="relative min-h-0 flex-1">
        {condition === 'ready' && !settled ? (
          <div className="bg-card pointer-events-auto absolute inset-0">
            <ConnectingPanel at={presence.at} />
          </div>
        ) : null}

        {condition === 'ready' ? null : (
          <div className="bg-card pointer-events-auto absolute inset-0">
            <ConditionPanel
              condition={condition}
              line={line}
              at={presence.at}
              protocols={presence.protocols}
            />
          </div>
        )}
      </div>

      {/* A fault is not a condition. The module is working; it did one thing the
          host could not make sense of, and a line under the pane is the right
          size for that — visible to whoever is looking at this module, invisible
          from across the canvas. */}
      {fault ? (
        <p
          className="text-muted-foreground bg-card pointer-events-auto shrink-0 truncate border-t px-2.5 py-1 text-[11px]"
          title={fault}
        >
          {fault}
        </p>
      ) : null}
    </div>
  )
}
