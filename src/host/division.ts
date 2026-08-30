import { METHOD_NAMES } from 'roadmap-module-protocol'

/**
 * Which half of the host answers which method — and the check that nothing
 * falls between them.
 *
 * The host is two programs: a server that knows what is registered, and a page
 * that is the canvas. Most methods a module can call are about the host's
 * material and are answered by the server. Three are about the host's VIEW —
 * `view.goto` asks the host to show something, `selection.set` changes what
 * every pane is told, and `events.emit` has to reach a frame — and none of
 * those is a thing a server has. So the canvas answers those, in the browser,
 * where the frames are.
 *
 * Both lists live in this one file rather than each half keeping its own,
 * because the failure worth catching is a method that neither half answers.
 * With two separate lists, that method gets `unknown-method` from the server —
 * a refusal that means "never, this does not exist", sent about a call that is
 * perfectly well-formed, to an author who cannot see the host's code. With one
 * file, it fails at startup with the method's name in the message.
 *
 * This matters more than it usually would because the protocol package is under
 * active development beside this host. A method renamed there and not here is
 * the exact shape of the bug above.
 */

export const ANSWERED_BY_THE_SERVER = [
  'epics.list',
  'epic.get',
  'steps.list',
  'live.get',
  'stage.report',
  /* A module's own kept state. Storage, so the half that has a database. */
  'state.set',
] as const

/**
 * The methods that are about the VIEW rather than about material.
 *
 * `view.goto` asks the host to show something. `selection.set` says what the
 * person has picked out, which becomes part of the context every framed module
 * receives — and context is composed by the canvas.
 *
 * `selection.set` is answered here even though it is also written down, and the
 * ORDER is what makes it a view method: the canvas changes, every module is
 * told, and the storing happens afterwards through the same debounced path that
 * stores an arrangement. A selection that waited for a round trip before the
 * other panes heard about it would put a visible delay on a click for no gain —
 * nothing is lost if the write lands a moment later, and the person is looking
 * at the result either way.
 *
 * ## `passage.set` is here for exactly the reason `selection.set` is
 *
 * A passage — a file, a page, a byte range, and the words that were there —
 * goes into `roadmap.context`, and the context is the canvas's to compose.
 * There is no second argument to make and no first one to weaken: the server
 * holds no view, has no frames, and would have to push the composed context
 * back to the page over a channel invented for the purpose, whose entire cargo
 * would be contexts the page then re-posts.
 *
 * It differs from `selection.set` in one way that does NOT move it, and the
 * difference is worth writing down because it looks like it might: a passage is
 * never written down. It is not stored with the arrangement, so there is no
 * "the storing happens afterwards" half to the paragraph above. See the essay
 * on `passage` in `src/App.tsx` for why a remembered passage would be a claim
 * about a file that nothing on the canvas is in a position to renew.
 *
 * ## `events.emit` moved here, and the move is the interesting part
 *
 * It sat in the server's list for as long as the server's answer was a refusal,
 * and a refusal needs nothing: no frames, no windows, no canvas. Delivery needs
 * all three. An event goes out as a `postMessage` into an iframe, and every
 * iframe in this host exists on the canvas — the server has never held a window
 * handle and cannot be given one. A server that answered this would have to
 * push the result back to the page over a channel invented for the purpose,
 * whose entire cargo would be events the page then re-posts: the same delivery
 * with an extra hop and a second place to lose it.
 *
 * So the rule that puts a method on this list is not "it changes the screen".
 * It is "answering it requires something only the canvas has", and a live frame
 * is such a thing. `src/host/events.ts` is where the deciding lives.
 */
export const ANSWERED_BY_THE_VIEW = ['view.goto', 'selection.set', 'passage.set', 'events.emit'] as const

/** Methods the protocol names that neither half has claimed. Should be empty. */
export function unanswered(): string[] {
  const covered = new Set<string>([...ANSWERED_BY_THE_SERVER, ...ANSWERED_BY_THE_VIEW])
  return METHOD_NAMES.filter((name) => !covered.has(name))
}

/**
 * Fail now, with the names in it.
 *
 * Called at the top of both halves. A host that will not start is a bad
 * morning; a host that refuses correct calls with the wrong reason is a week of
 * somebody else's time spent looking in their own code for a fault that is
 * here.
 */
export function assertEveryMethodIsAnswered(): void {
  const missing = unanswered()
  if (missing.length) {
    throw new Error(
      `the protocol names methods this host does not answer: ${missing.join(', ')}. ` +
        'Add each to ANSWERED_BY_THE_SERVER or ANSWERED_BY_THE_VIEW in src/host/division.ts, ' +
        'and give it a case in server/answers.ts or src/host/ask.ts.',
    )
  }
}
