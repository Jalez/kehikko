import type { FilterChoice, ModuleContext, ModuleScope } from 'kehikot-module-protocol'
import { useLayoutEffect, type CSSProperties } from 'react'

import type { CanvasControls } from '@/host/ask.ts'
import type { ConversationWatcher } from '@/host/conversation.ts'
import type { EventBus } from '@/host/events.ts'
import type { Presses } from '@/host/presses.ts'
import type { FramedModule } from '@/host/registry.ts'
import { ModuleFrame, type DocumentEvent } from './ModuleFrame.tsx'

/**
 * Every module's page, loaded once, positioned over the container that asked for it.
 *
 * ## The problem this solves, and why SSR does not solve it
 *
 * A module on two canvases used to be two loads. Switching canvases unmounted
 * the containers, unmounting the containers destroyed the iframes, and coming back was a
 * cold start: the page fetched again, the handshake ran again, and whatever the
 * person had scrolled to or typed into was gone. For a module that takes a
 * second to wake up, moving between two canvases became something you avoid.
 *
 * The instinct is that server rendering would fix it, and it would not — not a
 * little, but not at all, and it is worth saying exactly why because the two
 * things sound related.
 *
 * SSR decides who writes the FIRST HTML of a document: a server, or a script in
 * the browser. What is happening here is not a first render. It is a document
 * being DESTROYED. When an `<iframe>` element leaves the DOM the browser tears
 * down the document inside it, and there is nothing to be done afterwards —
 * moving the element to a new parent does not carry the document across either;
 * a reparented iframe reloads from its `src`, which is specified behaviour and
 * not a bug anybody can route around. Server rendering the HOST would change
 * which process wrote the canvas markup, and the module inside the container would
 * still be a fresh document every time, because it is a different origin
 * fetching its own page over HTTP either way. The host would be marginally
 * faster to first paint and every module would still reload.
 *
 * So the fix is not about rendering. It is about ownership: an iframe must be
 * created once, parented once, and never moved.
 *
 * ## What that costs, which is the interesting part
 *
 * The pages cannot live inside the grid, because the grid is what comes and
 * goes. So the containers in the grid are CHROME — a header, a border, and a hollow
 * body — and every module's page lives here instead, in one flat layer that is
 * a sibling of the grid and outlives it. Each page is positioned over the body
 * of its container, measured from the DOM rather than computed from the grid's own
 * arithmetic, so that changing the padding on a container cannot silently put every
 * module four pixels out of place.
 *
 * Two consequences follow and both are deliberate:
 *
 *   - **The order here never changes.** The list is sorted by module id, not by
 *     where things sit on a canvas. React moves DOM nodes when a keyed list is
 *     reordered, and moving one of these nodes would reload the document inside
 *     it — the exact failure this file exists to prevent. Sorting by something
 *     that has nothing to do with the layout is what makes that impossible
 *     rather than merely unlikely.
 *
 *   - **A page that is switched away from is hidden, not removed.** It keeps
 *     its size, so it is not reflowed to nothing and back; it keeps running,
 *     which is the whole point; and it stops receiving the pointer. It is
 *     `inert` too, so no Tab lands in a page nobody can see, and it is not
 *     told the open kehikko's context (`away`, `whileAway`).
 *
 *   - **Kept, within a bound.** The pages of the open kehikko and of the last
 *     `KEPT_KEHIKOT` kehikot left are kept (`framesKept`); a page on none of
 *     those is let go, oldest kehikko first, and loads again when its kehikko
 *     is opened. A dev server's page holds tens of megabytes, and a person who
 *     has visited every kehikko of three projects is not looking at them.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Framing {
  module: FramedModule
  /**
   * Counts the restarts the host has done to this module while its frame stayed
   * mounted. In the key, so each one is a new document from the new server —
   * see `restarted` in `host/standing.ts`.
   */
  generation: number
  /** Where its container's body is, or `null` if that container is not on screen. */
  rect: Rect | null
  /** On the open canvas, greeted, and answering. Anything else is hidden. */
  shown: boolean
  /** Its module is on no container of the open kehikko: kept, hidden, and not re-pointed. */
  away: boolean
  /** Whatever the host keeps for this module, carried into its greeting. */
  state: string | null
  /** Whether this container is pinned, and stops hearing about the canvas. */
  pinned: boolean
  /** What this kehikko has to say to this module, composed by the host. */
  prompt: string | null
  /**
   * Which of the filters this module offered are chosen for this container.
   *
   * Reconciled against what the module is offering right now before it gets
   * here — see `host/filters.ts` — so a module is never told about a group or
   * an option it does not currently have.
   */
  filters: FilterChoice
  /**
   * What this container is told in `context.scope` (protocol 2.29.0): its
   * scope, the person's pick or its module's default, and `project` on "All
   * epics" for one at Epic or Part. See `scopeToTell` in `host/scope.ts`.
   */
  scope: ModuleScope
}

export function Frames({
  framings,
  context,
  contextsFor,
  canvas,
  bus,
  presses,
  watcherFor,
  onDocument,
  moving,
  still = false,
  layer,
}: {
  framings: readonly Framing[]
  context: ModuleContext
  /**
   * A context of its own for a module the person switched a connection off into, on the open
   * kehikko (`receiverContext`, `host/connectionContext.ts`). Every other frame is sent `context`.
   */
  contextsFor?: Readonly<Record<string, ModuleContext>>
  canvas: CanvasControls
  /**
   * The one bus every frame on this page joins.
   *
   * It belongs to this layer for the same reason the pages do: the layer
   * outlives the grid, so a module framed on a kehikko nobody is currently
   * looking at is still joined and still hears. A bus owned by the container would
   * come and go with the container, and a module would fall silent the moment
   * somebody switched canvases.
   */
  bus: EventBus
  /**
   * The register of frames a header control can press.
   *
   * Here for the same reason the bus is: this layer outlives the grid, so what
   * has to be reachable is the FRAME and not the container. A register owned by
   * a container would come and go with the container, and a press would land on
   * nothing the moment somebody switched canvases and came back.
   */
  presses: Presses
  watcherFor(id: string): ConversationWatcher
  /** A frame's document was mounted, finished loading, or went away — what arms the cover. */
  onDocument(id: string, event: DocumentEvent): void
  /**
   * The container being dragged or resized right now, if any.
   *
   * It turns the pointer off — for every page, not only the one being moved.
   * A drag is tracked by listeners on the host's own document, and a document
   * does not receive pointer events that happen over an iframe; they go to the
   * framed document instead. So a container dragged across another module's page
   * would stick to the pointer the moment it crossed it, which reads as the
   * canvas freezing. Handing those events back for the duration costs a module
   * nothing: nobody clicks inside a container they are in the middle of moving.
   *
   * It does NOT hide anything, and an earlier version did. The reasoning then
   * was that a page positioned from a measurement is always a frame behind a
   * container positioned by the pointer, so the honest thing was to show an empty
   * box while you moved it. That traded a barely visible lag for a very visible
   * blank, which is the wrong way round: a module that goes blank whenever you
   * touch it looks like a module that crashed. Everything is measured on every
   * frame of the gesture instead, and stays where it belongs.
   */
  moving: string | null
  /**
   * Whether a switch of kehikko is under way (`canvas/useCalmSwitch.ts`): the
   * pages on screen are the ones being left, held where they were, and none
   * of them takes the pointer.
   */
  still?: boolean
  /** The layer's own opacity and fade, for the same switch. */
  layer?: CSSProperties
}) {
  /* A page that is hidden while it has the focus gives it back: `inert` makes
     it unfocusable, but a browser leaves the focus where it was, and a module
     that focused itself (a terminal does) would go on taking keystrokes on a
     kehikko the person has left — typing into a shell nobody can see. */
  const hiddenKey = framings
    .filter((one) => !(one.shown && one.rect))
    .map((one) => one.module.id)
    .join('\n')
  useLayoutEffect(() => {
    const hidden = new Set(hiddenKey ? hiddenKey.split('\n') : [])
    giveBackFocus(document, hidden)
    /* And when a hidden page takes the focus itself, later: measured, an
       agent module's terminal focuses itself 0.7 s after its kehikko was
       left, `inert` notwithstanding. The page sees only its own window lose
       the focus, with the iframe left as the active element. */
    const blurred = () => setTimeout(() => giveBackFocus(document, hidden), 0)
    window.addEventListener('blur', blurred)
    return () => window.removeEventListener('blur', blurred)
  }, [hiddenKey])

  return (
    /* `pointer-events-none` on the layer and `auto` on each page, so that the
       gaps between containers belong to the canvas underneath rather than to an
       invisible sheet stretched across it. */
    <div className="pointer-events-none absolute inset-0" aria-hidden={false} style={layer}>
      {framings.map(({ module, generation, rect, shown, away, state, pinned, prompt, filters, scope }) => {
        const visible = shown && !!rect
        return (
        <div
          /* The entry is in the key, so a page whose container switched version
             — a different address, on the version's own port — is a new
             document rather than the old one pointed somewhere else. */
          key={`${module.id}|${module.entry}|${generation}`}
          data-frame={module.id}
          /* Held while a switch hands over (`still`): the page being left,
             fading out where it was, is no more a target than a hidden one. */
          {...hiddenFrame(visible && !still)}
          className="absolute top-0 left-0 overflow-hidden rounded-b-lg"
          style={{
            transform: `translate(${rect?.x ?? 0}px, ${rect?.y ?? 0}px)`,
            width: rect?.width ?? 0,
            height: rect?.height ?? 0,
            /* `visibility`, not `display`. A page laid out at its real size and
               hidden comes back exactly as it was; one collapsed to nothing
               reflows to zero, reflows back, and hands the module two resize
               events it did nothing to deserve. */
            visibility: visible ? 'visible' : 'hidden',
            pointerEvents: visible && moving === null && !still ? 'auto' : 'none',
          }}
        >
          <ModuleFrame
            module={module}
            context={contextsFor?.[module.id] ?? context}
            canvas={canvas}
            bus={bus}
            presses={presses}
            watcher={watcherFor(module.id)}
            onDocument={onDocument}
            state={state}
            pinned={pinned}
            prompt={prompt}
            filters={filters}
            scope={scope}
            away={away}
          />
        </div>
        )
      })}
    </div>
  )
}

/**
 * What a page that is not shown carries: `inert`, so it takes no focus and no
 * pointer and is out of the accessibility tree, and `aria-hidden` for the
 * readers that do not know `inert` yet. A shown page carries neither.
 */
export function hiddenFrame(visible: boolean): { inert?: boolean; 'aria-hidden'?: true } {
  return visible ? {} : { inert: true, 'aria-hidden': true }
}

/**
 * Take the focus out of a hidden page. True when it had to: the focused
 * element was inside the frame of a module in `hidden`.
 */
export function giveBackFocus(doc: Pick<Document, 'activeElement'>, hidden: ReadonlySet<string>): boolean {
  const active = doc.activeElement as (Element & { blur?(): void }) | null
  const id = active?.closest?.('[data-frame]')?.getAttribute('data-frame')
  if (!id || !hidden.has(id)) return false
  active?.blur?.()
  return true
}
