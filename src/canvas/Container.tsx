import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Pin,
  PinOff,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import type { Presence } from '@/host/registry.ts'
import { ConditionDot, ConditionPanel, ConnectingPanel } from './Conditions.tsx'
import { Hint } from './Hint.tsx'
import { PromptButton } from './Prompts.tsx'
import { Start } from './Start.tsx'
import { ToolsMark } from './Tools.tsx'

/**
 * One thing on the canvas — or rather, the frame around one thing.
 *
 * A hairline border, a header thin enough to be a grip rather than a title bar,
 * and then a body that is either empty or filled with the sentence explaining
 * why there is nothing in it. The header is the drag handle and the body is
 * not: a container whose body dragged would be a container a person cannot click inside,
 * and clicking inside is the entire point of the thing.
 *
 * ## The module's page is not in here
 *
 * The body is hollow, and its only job is to be somewhere the canvas can
 * measure. The page itself is positioned over it from a layer that outlives
 * every container — see the essay in `Frames.tsx` for why a module's document has to
 * be created once and never moved, and why switching canvases would otherwise
 * reload everything on both of them.
 *
 * That split is why this component takes no context, no controls and no
 * watcher any more. It draws a box and a sentence. Everything that talks to a
 * module happens somewhere else.
 *
 * ## Why a notice can sit over a page that is still loading
 *
 * When a module's manifest answered but its page has not spoken yet, the container
 * shows a panel and the page keeps loading behind it. Unmounting would destroy
 * a document that is, as far as anyone knows, still on its way, and would make
 * "did not answer in four seconds" a death sentence rather than an observation.
 * A module that answers late simply clears the panel and appears, which is what
 * a person expects of something that was merely slow.
 */
export function Container({
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
  collapsed,
  onCollapse,
  selected,
  onSelect,
  onPrompts,
  onTools,
  onStarted,
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
  /** Whether this container follows the height its module asks for. */
  grow: boolean
  onGrow(grow: boolean): void
  /** Whether this container is pinned, and stops hearing about the canvas. */
  pinned: boolean
  onPin(pinned: boolean): void
  /**
   * Whether this container is folded down to its header.
   *
   * The module keeps running and its page keeps its document; it is simply not
   * drawn. See the essay on `onCollapse` in `App.tsx`, and `Frames.tsx` for why
   * hiding a page and destroying one are nowhere near the same thing.
   */
  collapsed: boolean
  onCollapse(collapsed: boolean): void
  /**
   * Whether this container has been picked out as a target on this kehikko.
   *
   * A fact about the canvas, not about the module: nothing crosses the wire and
   * the program inside is not told. See the essay on `onSelect` in `App.tsx`.
   */
  selected: boolean
  onSelect(selected: boolean): void
  /** Open the host's prompt dialog for this container. */
  onPrompts(): void
  /** Open the host's tools window for this module. */
  onTools(): void
  /** Look again, after this module has been started. */
  onStarted(): void
  onRemove(): void
}) {
  const name = presence.name ?? presence.id

  return (
    /*
     * No background on the container itself, and no pointer either.
     *
     * The module's page is painted UNDERNEATH this — see `App.tsx` — so
     * anything opaque here would hide it, and anything that takes the pointer
     * here would swallow clicks meant for it. The parts that need to be seen
     * and pressed opt back in one at a time: the header, the fault line, and
     * whichever notice is standing in for a page that is not there.
     *
     * The border stays, because the border is the container. It is the only thing
     * that says where one module ends and the next begins.
     */
    <div
      /*
       * A folded container is as tall as its header and no taller.
       *
       * The grid gives it two rows — fifty-six pixels, the smallest that can
       * hold a thirty-two pixel header. The first version of this folded to TWO
       * rows and drew only its own thirty-four pixels, leaving the rest of the
       * row as canvas — on the reasoning that a header with twenty-two pixels
       * of empty card under it reads as a container that failed to load.
       *
       * That reasoning was right about the card and wrong about the space. The
       * emptiness did not go away; it moved outside the container, where the grid
       * was still holding fifty-six pixels for something drawing thirty-four.
       * The person folding a container to reclaim space got twenty-two pixels of
       * nothing between it and its neighbour, which is the same waste with a
       * transparent background — and it looked, in their words, weird.
       *
       * So a folded container is ONE row, and the header fills it exactly. Nothing
       * is reserved that is not drawn. One row is twenty-four pixels against a
       * header that wants thirty-two, so the header goes dense when folded
       * rather than the grid going coarse: the controls shrink, which is a
       * change to one CSS rule, instead of every container on every canvas getting
       * taller to make room for the folded case.
       */
      /*
       * The ring is the selection, and the checkbox is only how you set it.
       *
       * A tick in a thirty-two pixel header is legible when you are reading
       * that header and invisible from across a canvas of eight containers,
       * which is exactly the distance the question "which ones did I pick?" is
       * asked from. So the border of the selected container changes colour and
       * grows a ring — the border being, as the essay above says, the one thing
       * that says where one module ends and the next begins.
       *
       * `ring-inset`, because a ring drawn outside the border would be painted
       * over the eight pixels of margin the grid puts between containers and
       * would touch its neighbour.
       */
      className={
        selected
          ? 'border-primary ring-primary/60 pointer-events-none relative flex h-full flex-col overflow-hidden rounded-lg border ring-2 ring-inset'
          : 'pointer-events-none relative flex h-full flex-col overflow-hidden rounded-lg border'
      }
    >
      {/*
       * The header, inside a wrapper that does nothing at all most of the time.
       *
       * In focus mode the wrapper becomes the thing that detects a pointer
       * near the top of this container, and the header lifts out of the layout and
       * hangs from it — see the `.focus-mode` rules in `index.css` for why the
       * reveal has to be an element with `pointer-events: auto` rather than a
       * `:hover` on the container, and for the eight pixels that costs.
       *
       * Outside focus mode this div is a plain block in the column and changes
       * nothing. It is not conditional on the mode: a wrapper that appeared and
       * disappeared would remount the header, and remounting a drag handle
       * mid-canvas is a good way to lose a gesture.
       */}
      <div
        className={collapsed ? 'container-reveal min-h-0 flex-1' : 'container-reveal shrink-0'}
        data-collapsed={collapsed ? 'true' : undefined}
        /*
         * A SELECTED container keeps its header in focus mode, exactly as a
         * folded one does, and the reason is a cousin of that one.
         *
         * Focus mode hides headers to give space back to the modules, and the
         * cost it accepts is that a control is a hover away. That is a fair
         * trade for a control — you know you have a pin because you pressed it,
         * and it is where you left it. It is not a fair trade for a STATE
         * somebody else can change: an agent selects two containers through the
         * MCP door, and in focus mode the person watching would see nothing at
         * all happen. Worse in the other direction — a selection you cannot see
         * is a selection you will forget you made, and the next tool call you
         * ask for lands on containers you no longer meant.
         *
         * The ring is drawn either way, because the ring is on the container
         * and not in the header. So this exemption is not what makes the
         * selection visible; it is what keeps the box you untick it with
         * reachable, on the one container where reaching for it is likely.
         */
        data-selected={selected ? 'true' : undefined}
      >
      <header
        data-dense={collapsed ? 'true' : undefined}
        className={
          collapsed
            ? 'container-grip bg-card pointer-events-auto flex h-full cursor-move items-center gap-1.5 px-2 select-none'
            : 'container-grip bg-card pointer-events-auto flex h-8 shrink-0 cursor-move items-center gap-2 border-b px-2.5 select-none'
        }
      >
        {/*
         * The box that says this container is one of the ones being aimed at.
         *
         * ## Leftmost, before the dot
         *
         * Everything else in this header is a control that does something to
         * this container — grow it, fold it, pin it, take it off — and they are
         * gathered on the right. This is not one of those. It marks the row,
         * the way the box at the start of a table row does, and a person
         * scanning a canvas for what they picked reads down a column of them.
         *
         * ## Why it cannot start a drag
         *
         * The header IS the drag handle — `draggableHandle=".container-grip"`
         * — so a press that reaches the grid begins a gesture, and a checkbox
         * that moved the container instead of ticking would be a control that
         * looks broken. `onMouseDown` is stopped here for the same reason every
         * button in this header stops it.
         *
         * ## Why it does not squeeze the row
         *
         * `shrink-0` on the box and `truncate` on the name: the name is the one
         * thing in this header that gives way, which it already did for six
         * controls. Measured at a 220px container, folded and unfolded, the row
         * does not wrap — a flex row does not wrap by default and nothing here
         * asks it to; what a narrow container costs is letters off the end of a
         * name, and the name is in a tooltip and in the modules list besides.
         */}
        <Hint
          label={
            selected
              ? 'picked out as a target on this kehikko — press to unpick it'
              : 'pick this container out as a target on this kehikko'
          }
          side="bottom"
          align="start"
        >
          <Checkbox
            checked={selected}
            aria-label={selected ? `unpick ${name}` : `pick ${name} out as a target`}
            className="shrink-0 cursor-default"
            onMouseDown={(event) => event.stopPropagation()}
            onCheckedChange={(next) => onSelect(next === true)}
          />
        </Hint>

        <ConditionDot condition={condition} lifecycle={presence.lifecycle} />
        {/*
         * The name, and the module's own description behind it.
         *
         * Every module used to print its name and its one-line summary at the
         * top of its own page, directly under this header, which said the name
         * again. Two costs: the name twice, and — the one that matters — a
         * fixed strip of prose at the top of a container that is often only three
         * hundred pixels tall. In a short container the description was competing
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

        {/* Whenever this module has an MCP door at all — loud when nothing is
            configured for it, quiet when something is. It opens the host's tools
            window; see the essay in `Tools.tsx` for why the quiet one exists now
            and why there is still no green tick. */}
        <ToolsMark agent={presence.agent} name={name} onOpen={onTools} />

        {/*
         * Whether this container follows the height its module asks for.
         *
         * Per container rather than a setting somewhere, because it is a question
         * about how you want to read THIS thing: a list you scan wants to hold
         * its size and scroll, a summary you want all of wants to fit. The host
         * has no way to know which this is, so it asks by putting the switch on
         * the container itself.
         *
         * It shows only when the module is actually speaking. Offering to
         * follow the height of a program that is not running would be offering
         * something that cannot happen.
         */}
        {condition === 'ready' && !collapsed ? (
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
         * Fold this container down to its header, or open it again.
         *
         * Shown whatever the condition, like the pin and unlike the height
         * toggle. Folding is a fact about the container rather than a conversation
         * with the program, and a container whose module is not running is exactly
         * one somebody might want out of the way.
         *
         * The tooltip says what happens to the MODULE, because that is the
         * question a person actually has: a control sitting beside a close
         * button has to say, before it is pressed, that nothing is being
         * stopped.
         */}
        <Hint
          label={
            collapsed
              ? 'folded — the module is still running. Press to put it back at the height it had'
              : 'fold it down to this header. The module keeps running and keeps what is in it'
          }
          side="left"
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={collapsed ? 'unfold this container' : 'fold this container down to its header'}
            aria-expanded={!collapsed}
            className={
              collapsed
                ? 'text-foreground size-6 cursor-default'
                : 'text-muted-foreground hover:text-foreground size-6 cursor-default'
            }
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onCollapse(!collapsed)}
          >
            {collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          </Button>
        </Hint>

        <PromptButton wanted={presence.module?.declares.prompt === true} onOpen={onPrompts} />

        {/*
         * Pin: hold this container where it is and stop telling it about the canvas.
         *
         * What it is for is two containers on two epics, side by side, to compare —
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
         * fact about the container rather than a conversation with the program, and
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
            aria-label={pinned ? 'let this container follow the kehikko again' : 'pin this container'}
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
      </div>

      {/*
        Everything below the header, and it is absent entirely when folded.

        Not merely empty: a zero-height body would still be measured, and the
        module's page would be positioned over a one-pixel rectangle and told it
        had been resized to nothing. The page is hidden in the frames layer
        instead — the same path a page on another kehikko takes — so the
        document is untouched and comes back exactly as it was.
      */}
      {collapsed ? null : (
      <>
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
              lifecycle={presence.lifecycle}
              line={line}
              at={presence.at}
              protocols={presence.protocols}
            >
              {/* Only for silence. An incompatible module is running and
                  answering — starting it again would change nothing, and the
                  panel already says which protocol each side speaks, which is
                  the thing to act on.

                  And not while the host is already starting it. The button
                  would offer to do the thing being done, and pressing it would
                  spawn a second copy racing the first for the port. `asleep`
                  keeps the button: the host will start it when this kehikko
                  next asks, and somebody who would rather not wait for that has
                  every right to say so now. */}
              {condition === 'silent' && presence.lifecycle !== 'starting' ? (
                <Start module={presence.id} onStarted={onStarted} />
              ) : null}
            </ConditionPanel>
          </div>
        )}
      </div>

      {/* A fault is not a condition. The module is working; it did one thing the
          host could not make sense of, and a line under the container is the right
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
      </>
      )}
    </div>
  )
}
