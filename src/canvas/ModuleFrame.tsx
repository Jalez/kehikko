import { useEffect, useRef } from 'react'
import type { ModuleContext } from 'roadmap-module-protocol'

import { Conversation, type ConversationWatcher } from '@/host/conversation.ts'
import { makeAsk, type CanvasControls } from '@/host/ask.ts'
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
  watcher,
}: {
  module: FramedModule
  context: ModuleContext
  canvas: CanvasControls
  watcher: ConversationWatcher
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const conversationRef = useRef<Conversation | null>(null)

  /* Held in refs and read inside the effects rather than listed as
     dependencies. The conversation must survive a re-render caused by the
     context changing — tearing it down and rebuilding it would reload the
     module's page every time the person changed the subject, throwing away
     whatever they had typed in it. */
  const contextRef = useRef(context)
  contextRef.current = context
  const watcherRef = useRef(watcher)
  watcherRef.current = watcher
  const canvasRef = useRef(canvas)
  canvasRef.current = canvas

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

    const onLoad = () => conversation.greet(contextRef.current)
    frame.addEventListener('load', onLoad)

    return () => {
      frame.removeEventListener('load', onLoad)
      window.removeEventListener('message', onMessage)
      conversation.close()
      conversationRef.current = null
    }
  }, [framed.id, framed.name, framed.entry, origin])

  /* Context, re-sent whenever it changes. `sendContext` is a no-op before the
     greeting, so a change arriving while the page is still loading is dropped
     here and carried in the greeting itself instead — which is why `hello`
     carries the context at all. */
  useEffect(() => {
    conversationRef.current?.sendContext(context)
  }, [context])

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
