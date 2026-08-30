import { methodParams } from 'roadmap-module-protocol'
import type { Emitted } from './events.ts'
import { shaped } from './shape.ts'
import { ANSWERED_BY_THE_VIEW, assertEveryMethodIsAnswered } from './division.ts'
import type { Answer, Ask } from './conversation.ts'

/* The same check the server runs, run here too, because a method that neither
   half answers is a bug that has to be loud on whichever side notices first. */
assertEveryMethodIsAnswered()

/**
 * How a framed module's question gets answered.
 *
 * Two destinations and one rule for choosing between them.
 *
 * **Almost everything goes to the server.** The page RELAYS it — it does not
 * decide it. That boundary matters: the page is a document with a module's own
 * frame inside it, and a check written here would be a check running in the
 * same tab as the thing it is checking. The server is a process no module can
 * reach except through one endpoint, over material — the registry — that no
 * module can write to.
 *
 * **`view.goto` is answered here**, because it is the one method that is not
 * about the host's material at all. It asks the host to SHOW something, and
 * what is shown is a property of the canvas. A server has no view; sending it
 * there would mean the server answering a question about a screen it cannot
 * see, then pushing the answer back to the screen over a channel that would
 * have to be invented for the purpose.
 *
 * **`selection.set` and `events.emit` are answered here for the same reason,
 * one step further on.** Neither is about a screen exactly; both are about
 * something only this half of the host possesses. A selection becomes part of
 * the context every framed module is told, and the context is composed by the
 * canvas. An event has to arrive INSIDE a frame, and every frame is a window in
 * this page — the server has never held one and could not be given one. The
 * channel-invented-for-the-purpose argument above is the same argument, and it
 * bites harder here: that channel's entire cargo would be events the page then
 * re-posts.
 */

const viewMethods = new Set<string>(ANSWERED_BY_THE_VIEW)
const params = new Map<string, (typeof methodParams)[keyof typeof methodParams]>(
  Object.entries(methodParams),
)

/** What the canvas can do when a module asks it to move. */
export interface CanvasControls {
  /** Make this the canvas's subject, and tell every module. */
  showEpic(epic: string): void
  /**
   * Make this the canvas's selection, and tell every module.
   *
   * The canvas does not check these refs against anything, and could not: it
   * holds no trackers and has never heard of `gh#131`. What it can vouch for is
   * that these are the refs somebody picked, which is exactly what it goes on
   * to say. See the essay on `selection` in the protocol's `wire.ts`.
   */
  select(refs: string[]): void
  /**
   * Carry one module's event to whoever consumes the format.
   *
   * The sender is a parameter and is supplied by `makeAsk` out of the
   * registration this conversation was built on — it is deliberately NOT
   * reachable from anything the frame said. See the essay in `events.ts`: a
   * module that could name its own sender could post under another module's
   * name onto a panel whose whole job is attribution.
   */
  emit(from: string, extension: string, payload: unknown): Emitted
  /**
   * Which project the canvas is standing in, as an id, read at call time.
   *
   * A function rather than a value because it is read when the call is MADE,
   * not when the conversation was built. A module's page is loaded once and
   * shown on whichever kehikko asks for it, and a person switches project under
   * it without the frame being told anything — so a project captured at mount
   * would send every epic question to the project that happened to be open the
   * first time the module appeared, forever, and answer it correctly out of the
   * wrong folder.
   *
   * An id and never a path. This value ends up in the body of `/host/call`,
   * which is the one endpoint every framed module can reach; a path there would
   * be a way to name any folder on the disk. The server turns the id into a
   * folder out of its own table.
   */
  project(): number | null
}

/**
 * Build the `ask` for one module's conversation.
 *
 * Bound to a module id because every relayed call carries it and because the
 * server decides `unknown-module` from it. The id comes from the registration
 * — the host's own material — and never from anything the frame said.
 */
export function makeAsk(moduleId: string, canvas: CanvasControls): Ask {
  return async (method, rawParams) => {
    if (viewMethods.has(method)) return answerInTheView(moduleId, method, rawParams, canvas)

    try {
      const response = await fetch('/host/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          module: moduleId,
          method,
          params: rawParams ?? {},
          /* Where the canvas is standing, so the server reads this project's
             epics and not the one directory a variable named at startup. Read
             now rather than captured — see `project` on `CanvasControls`. */
          project: canvas.project(),
        }),
      })
      const body = (await response.json()) as Answer
      if (typeof body !== 'object' || body === null || typeof (body as Answer).ok !== 'boolean') {
        return failed("The host's server answered something that is not an answer.")
      }
      return body
    } catch {
      /* The host's own server is unreachable from the host's own page. Almost
         always the server restarting under a page left open. `failed` rather
         than `unknown-method`, because the protocol is explicit that the two
         mean different futures and this one is worth retrying. */
      return failed("The host's server did not answer. It may be restarting; the call was not made.")
    }
  }
}

/**
 * `view.goto`, answered by the canvas.
 *
 * An epic is honoured: the canvas has a subject, and "show that one" is exactly
 * what a subject is for, so the canvas moves and answers `moved`.
 *
 * A step or a reference is declined. There is no document open on a canvas and
 * so no page with anchors for a reference to land on — and `declined` is the
 * word for that rather than `no-such-target`, which would send a module looking
 * for a target that was never the problem. Neither branch is an error: the call
 * was well-formed and was understood, and the protocol gives the outcome a
 * shape precisely so that "I moved" and "I would rather not" do not both have
 * to arrive as failures.
 */
function answerInTheView(
  /**
   * Who is asking, from the registration this conversation was built on.
   *
   * Threaded down here for one reason and it is `events.emit`: the sender's
   * name has to come from the host's own material. The frame never sees this
   * string in a place it could change it.
   */
  moduleId: string,
  method: string,
  rawParams: unknown,
  canvas: CanvasControls,
): Answer {
  const schema = params.get(method)
  if (!schema) return failed('The canvas claims to answer that method and has no shape for it.')

  const parsed = schema.safeParse(rawParams ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'params'
    return failed(`${method} was called with something the canvas will not accept: ${where} — ${issue?.message ?? 'malformed'}.`)
  }

  /*
   * A selection, which is not a movement and so is not a `view.goto`.
   *
   * It is answered here rather than by the server because it changes the
   * context, and the context is the canvas's to compose. What comes back is a
   * plain success: unlike a walk, there is no outcome to report — the canvas
   * has no grounds to decline, since it is not being asked to find anything,
   * only to hold what it was handed and repeat it.
   */
  if (method === 'selection.set') {
    const { refs } = parsed.data as { refs: string[] }
    canvas.select(refs)
    return succeeded(method, { selection: refs })
  }

  /*
   * An event, handed to the canvas to deliver.
   *
   * A REFUSAL when it is not carried, rather than `ok: true` with a count of
   * zero, in the two cases where the host itself declined: a format it does not
   * know, and a payload that does not fit the format. Those are faults in the
   * call and the author needs the sentence. The rate limit refuses for the same
   * reason — an event silently not carried is indistinguishable, from inside
   * the sender, from an event nobody happened to be listening for.
   *
   * `delivered: 0` with `ok: true` is a different sentence and an honest one:
   * the event was fine, the host carried it, and nothing on this canvas
   * consumes that format. A module emitting into an empty room has not failed,
   * and telling it so would send its author looking for a bug in their payload.
   */
  if (method === 'events.emit') {
    const { extension, payload } = parsed.data as { extension: string; payload: unknown }
    const out = canvas.emit(moduleId, extension, payload)
    return out.ok ? succeeded(method, { delivered: out.delivered }) : failed(out.error)
  }

  const target = parsed.data as { epic?: string; step?: number; ref?: string }

  /*
   * `view.goto` reports an OUTCOME, and the protocol gives the outcome a shape
   * for a reason worth honouring: `ok: false` here would tell a module its call
   * went wrong, when what actually happened is that the call was understood and
   * the host said no. Those are different sentences and they send a person to
   * different places, so both of the branches below succeed and differ in
   * `outcome`.
   */
  if (target.epic) {
    canvas.showEpic(target.epic)
    /* `moved`, and not `no-such-target`: the canvas moved its subject and told
       every module. It did NOT verify that an epic by that name exists, because
       this host holds no epics and has nothing to check against — and
       `no-such-target` would be a claim it is in no position to make. */
    return succeeded(method, { outcome: 'moved', epic: target.epic, why: '' })
  }

  /* `declined`, which is the honest word. The ask was well-formed and this host
     is a canvas: nothing is open in it, so there is no page with anchors for a
     step or a reference to land on. A module told `no-such-target` would go
     looking for a target that was never the problem. */
  return succeeded(method, {
    outcome: 'declined',
    epic: null,
    why: 'This host is a canvas, not a document: nothing is open in it, so a step or a reference has nowhere to land. Name an epic and the canvas will make it its subject.',
  })
}

/** A successful answer, held to the shape the protocol names for that method. */
function succeeded(method: string, data: unknown): Answer {
  const held = shaped(method, data)
  return held.ok ? { ok: true, data: held.data } : failed(held.why)
}

const failed = (error: string): Answer => ({ ok: false, reason: 'failed', error })
