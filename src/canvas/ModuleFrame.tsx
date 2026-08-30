import { useEffect, useMemo, useRef } from 'react'
import type { ModuleContext } from 'roadmap-module-protocol'

import { Conversation, type ConversationWatcher } from '@/host/conversation.ts'
import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import type { EventBus } from '@/host/events.ts'
import type { FramedModule } from '@/host/registry.ts'

/**
 * A module's own page, embedded, and the conversation that goes with it.
 *
 * The frame and the conversation are created together and destroyed together,
 * and that is the whole reason they are one component. A conversation without
 * its frame has nobody to talk to; a frame without its conversation is a page
 * running inside the host that the host has never greeted, which is exactly the
 * state a module cannot recover from on its own.
 *
 * ## Greet on load, every load
 *
 * The greeting goes out on the frame's `load` event and not on mount. A module
 * greeted before its own script has run never hears the greeting, and a host
 * that guessed at a delay long enough to be safe would still lose on a slow
 * machine — the failure is silent on both sides, which is the worst kind. The
 * `load` event is the browser saying the document is there.
 *
 * And on EVERY load, because a frame that navigates or reloads itself has
 * forgotten the conversation. Greeting it again is cheaper than either side
 * wondering which of them is confused.
 */

export function ModuleFrame({
  module: framed,
  context,
  canvas,
  bus,
  watcher,
  state,
  pinned,
  prompt,
}: {
  module: FramedModule
  context: ModuleContext
  canvas: CanvasControls
  /**
   * Where events are delivered from, and where this frame signs up to hear
   * them. One bus for the whole canvas; see `host/events.ts`.
   */
  bus: EventBus
  watcher: ConversationWatcher
  /**
   * Whatever the host is keeping for this module, or null when it keeps
   * nothing. Handed straight into the greeting and never read here.
   */
  state: string | null
  /** Whether this pane is pinned. See the context effect below. */
  pinned: boolean
  /** What this kehikko says to this module, composed by the host. */
  prompt: string | null
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const conversationRef = useRef<Conversation | null>(null)

  /* Held in refs and read inside the effects rather than listed as
     dependencies. The conversation must survive a re-render caused by the
     context changing — tearing it down and rebuilding it would reload the
     module's page every time the person changed the subject, throwing away
     whatever they had typed in it. */
  /* The pin travels with the context, because to a module it IS part of the
     context: it says whether what it has just been told is the last it will
     hear. Merged here rather than upstream because the pin is per pane and the
     context is one object shared by every frame on the canvas.

     Memoised, and that is not a performance nicety. This object is the
     dependency of the effect that POSTS the context, so a fresh one per render
     is a `roadmap.context` per render — measured at seventeen identical
     broadcasts to three modules during one startup. Nothing looked wrong,
     because every module already ignores a context that tells it nothing new;
     it was still the host saying the same thing seventeen times, and the first
     module to react to context ARRIVING rather than to context CHANGING would
     have inherited a bug that looked like its own. */
  const told: ModuleContext = useMemo(
    () => ({ ...context, pinned, prompt }),
    [context, pinned, prompt],
  )

  const contextRef = useRef(told)
  contextRef.current = told
  /* Same reason as the context, and the timing matters more here: the kept
     state arrives with the registry sweep, which can land either side of the
     frame's load. A module greeted with `null` because the sweep had not
     returned yet would draw its defaults and never be told otherwise. */
  const stateRef = useRef(state)
  stateRef.current = state
  const watcherRef = useRef(watcher)
  watcherRef.current = watcher
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas
  /* What this module says it consumes, read through a ref for the same reason
     as everything else here: a manifest re-read that changed the array identity
     must not tear down the conversation and reload the page. The bus reads it
     on every emit rather than holding a copy, so a module whose manifest
     changed under a running frame is heard about the moment the sweep lands. */
  const consumesRef = useRef(framed.extensions.consumes)
  consumesRef.current = framed.extensions.consumes

  /*
   * A module that asked for storage gets its own origin back, and is therefore
   * addressable by it. One that did not runs opaque, has no origin string, and
   * is addressed by its window alone — see the essay in `conversation.ts`.
   *
   * `declares.storage` is the one field in a manifest that changes what this
   * host does, and it still decides nothing: the host chooses whether to hand
   * an origin back, and a host that always refused would be a conforming host.
   * This one honours it, because the alternative is a module whose own
   * localStorage is empty for a reason it can never discover.
   */
  const wantsOrigin = framed.declares.storage
  const origin = wantsOrigin ? new URL(framed.entry).origin : null

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    const conversation = new Conversation(
      frame,
      framed.id,
      origin,
      makeAsk(framed.id, {
        showEpic: (epic) => canvasRef.current.showEpic(epic),
        select: (refs) => canvasRef.current.select(refs),
        emit: (from, extension, payload) => canvasRef.current.emit(from, extension, payload),
        project: () => canvasRef.current.project(),
      }),
      {
        ready: (p) => watcherRef.current.ready(p),
        silent: (line) => watcherRef.current.silent(line),
        fault: (line) => watcherRef.current.fault(line),
        height: (px) => watcherRef.current.height(px),
      },
      { name: framed.name },
    )
    conversationRef.current = conversation

    /* One listener for this frame. The window receives messages from every
       frame on the page and from anything else with a handle on it; the
       conversation's own `receive` does the filtering, starting with the frame
       handle, and answers whether it took the message. */
    const onMessage = (event: MessageEvent) => {
      conversation.receive(event)
    }
    window.addEventListener('message', onMessage)

    const onLoad = () => conversation.greet(contextRef.current, stateRef.current)
    frame.addEventListener('load', onLoad)

    /*
     * Signed up for events for as long as this conversation exists, and on the
     * SAME lifetime as the conversation rather than in an effect of its own.
     *
     * The two must be created and destroyed together for the reason the whole
     * component exists: a receiver registered without a live conversation is an
     * entry in the bus posting into a window that has gone, and a conversation
     * without a receiver is a module the host greeted and then never delivered
     * anything to. Splitting them into two effects made both states reachable
     * for one render, which is long enough for an event to be lost.
     *
     * Joining regardless of whether this pane is on the OPEN canvas is
     * deliberate. Its page is loaded, its conversation is live, and the event
     * says which kehikko it happened on — so a module on another canvas can
     * still record it and decide for itself whether it is near or far. Hiding
     * it here would turn the module's filter into the host's rule.
     */
    bus.join(framed.id, {
      get consumes() {
        return consumesRef.current
      },
      send: (event) => conversation.sendEvent(event),
    })

    return () => {
      bus.leave(framed.id)
      frame.removeEventListener('load', onLoad)
      window.removeEventListener('message', onMessage)
      conversation.close()
      conversationRef.current = null
    }
  }, [framed.id, framed.name, framed.entry, origin, bus])

  /**
   * Context, re-sent whenever it changes — unless this pane is pinned.
   *
   * `sendContext` is a no-op before the greeting, so a change arriving while the
   * page is still loading is dropped here and carried in the greeting instead,
   * which is why `hello` carries the context at all.
   *
   * ## The pin, and the one message that still goes out after it
   *
   * A pinned pane keeps what it was last told and hears nothing more about this
   * canvas. That is the whole feature: two panes on two epics, side by side.
   *
   * But the pin itself is sent, in both directions, and that is not a
   * contradiction. The message announcing the freeze is the last one through and
   * the message lifting it is the first — because a module that was pinned and
   * never told would go on describing itself as showing the open epic while
   * showing a remembered one, with no way to tell a person's pin from the canvas
   * not having moved. That is precisely why this host refused to pin at all
   * until the protocol grew a word for it; see `pinned` in the protocol's
   * `wire.ts`.
   *
   * So: while pinned, send only when the pin itself changed. The ref remembers
   * what was last SENT rather than what is current, which is the distinction
   * that makes "the transition, and only the transition" expressible.
   */
  const sentPinned = useRef<boolean | null>(null)
  useEffect(() => {
    const froze = sentPinned.current !== pinned
    sentPinned.current = pinned
    if (pinned && !froze) return
    conversationRef.current?.sendContext(told)
  }, [told, pinned])

  return (
    <iframe
      ref={frameRef}
      title={framed.name}
      src={framed.entry}
      className="h-full w-full border-0 bg-white"
      /*
       * `allow-scripts` because a module is a program. `allow-forms` and
       * `allow-popups` because a module is a program somebody chose to run and
       * refusing those would break ordinary pages for no gain — there is no
       * untrusted publisher here; everything on this canvas belongs to the same
       * person.
       *
       * `allow-same-origin` only when the manifest declared storage. Without it
       * the document is on an opaque origin: it cannot reach its own cookies or
       * localStorage, and — the part that matters to the host — it has no
       * origin string, so the wire is addressed by window handle. With it, the
       * module gets its storage back and an origin the host can check as a
       * second condition.
       *
       * ## No `allow-modals`, and it costs a module author an afternoon
       *
       * `alert`, `confirm` and `prompt` are absent, deliberately. They block the
       * whole browser — not the pane, the browser — so one module could freeze
       * a canvas holding five other people's programs, and a host that let a
       * pane do that would not be a host.
       *
       * The reason it is written down here is the FAILURE MODE. A blocked
       * `confirm()` does not throw and does not warn: it returns `false`, which
       * is the same value a person clicking Cancel produces. The checklist
       * module guarded withdrawing an agreement behind one, and the button
       * simply did nothing, forever, with nothing in the console — a bug that
       * looks entirely like the module's own and is found only by measuring.
       *
       * A module wanting to confirm something builds it in its own page: a
       * two-press arm, an inline are-you-sure. Those are better anyway, since
       * they can say what will happen in the module's own words rather than in
       * a browser chrome dialog. And anything that must be BIGGER than a pane
       * belongs to the host — see `Prompts.tsx`.
       */
      sandbox={
        wantsOrigin
          ? 'allow-scripts allow-forms allow-popups allow-same-origin'
          : 'allow-scripts allow-forms allow-popups'
      }
      referrerPolicy="no-referrer"
    />
  )
}
