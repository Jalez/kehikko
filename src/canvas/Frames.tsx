import type { ModuleContext } from 'roadmap-module-protocol'

import type { CanvasControls } from '@/host/ask.ts'
import type { ConversationWatcher } from '@/host/conversation.ts'
import type { FramedModule } from '@/host/registry.ts'
import { ModuleFrame } from './ModuleFrame.tsx'

/**
 * Every module's page, loaded once, positioned over the pane that asked for it.
 *
 * ## The problem this solves, and why SSR does not solve it
 *
 * A module on two canvases used to be two loads. Switching canvases unmounted
 * the panes, unmounting the panes destroyed the iframes, and coming back was a
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
 * which process wrote the canvas markup, and the module inside the pane would
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
 * goes. So the panes in the grid are CHROME — a header, a border, and a hollow
 * body — and every module's page lives here instead, in one flat layer that is
 * a sibling of the grid and outlives it. Each page is positioned over the body
 * of its pane, measured from the DOM rather than computed from the grid's own
 * arithmetic, so that changing the padding on a pane cannot silently put every
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
 *     which is the whole point; and it stops receiving the pointer.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Framing {
  module: FramedModule
  /** Where its pane's body is, or `null` if that pane is not on screen. */
  rect: Rect | null
  /** On the open canvas, greeted, and answering. Anything else is hidden. */
  shown: boolean
  /** Whatever the host keeps for this module, carried into its greeting. */
  state: string | null
  /** Whether this pane is pinned, and stops hearing about the canvas. */
  pinned: boolean
}

export function Frames({
  framings,
  context,
  canvas,
  watcherFor,
  moving,
}: {
  framings: readonly Framing[]
  context: ModuleContext
  canvas: CanvasControls
  watcherFor(id: string): ConversationWatcher
  /**
   * The pane being dragged or resized right now, if any.
   *
   * It turns the pointer off — for every page, not only the one being moved.
   * A drag is tracked by listeners on the host's own document, and a document
   * does not receive pointer events that happen over an iframe; they go to the
   * framed document instead. So a pane dragged across another module's page
   * would stick to the pointer the moment it crossed it, which reads as the
   * canvas freezing. Handing those events back for the duration costs a module
   * nothing: nobody clicks inside a pane they are in the middle of moving.
   *
   * It does NOT hide anything, and an earlier version did. The reasoning then
   * was that a page positioned from a measurement is always a frame behind a
   * pane positioned by the pointer, so the honest thing was to show an empty
   * box while you moved it. That traded a barely visible lag for a very visible
   * blank, which is the wrong way round: a module that goes blank whenever you
   * touch it looks like a module that crashed. Everything is measured on every
   * frame of the gesture instead, and stays where it belongs.
   */
  moving: string | null
}) {
  return (
    /* `pointer-events-none` on the layer and `auto` on each page, so that the
       gaps between panes belong to the canvas underneath rather than to an
       invisible sheet stretched across it. */
    <div className="pointer-events-none absolute inset-0" aria-hidden={false}>
      {framings.map(({ module, rect, shown, state, pinned }) => {
        const visible = shown && !!rect
        return (
        <div
          key={module.id}
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
            pointerEvents: visible && moving === null ? 'auto' : 'none',
          }}
        >
          <ModuleFrame
            module={module}
            context={context}
            canvas={canvas}
            watcher={watcherFor(module.id)}
            state={state}
            pinned={pinned}
          />
        </div>
        )
      })}
    </div>
  )
}
