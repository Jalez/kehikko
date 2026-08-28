import { methodParams } from 'roadmap-module-protocol'
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
 */

const viewMethods = new Set<string>(ANSWERED_BY_THE_VIEW)
const params = new Map<string, (typeof methodParams)[keyof typeof methodParams]>(
  Object.entries(methodParams),
)

/** What the canvas can do when a module asks it to move. */
export interface CanvasControls {
  /** Make this the canvas's subject, and tell every module. */
  showEpic(epic: string): void
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
    if (viewMethods.has(method)) return answerInTheView(method, rawParams, canvas)

    try {
      const response = await fetch('/host/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ module: moduleId, method, params: rawParams ?? {} }),
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
function answerInTheView(method: string, rawParams: unknown, canvas: CanvasControls): Answer {
  const schema = params.get(method)
  if (!schema) return failed('The canvas claims to answer that method and has no shape for it.')

  const parsed = schema.safeParse(rawParams ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'params'
    return failed(`${method} was called with something the canvas will not accept: ${where} — ${issue?.message ?? 'malformed'}.`)
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
