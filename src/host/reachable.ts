/**
 * The host's own server, not answering — and the one place that says so.
 *
 * ## Why this file exists
 *
 * This host is two processes on adjacent ports: `bun run server/server.ts`
 * answers `/host/*`, and Vite serves the page and proxies to it. `run.sh`
 * starts both and `server/ports.ts` claims them together, because a page
 * pointed at somebody else's API is worse than no page at all.
 *
 * The consequence nobody wrote down until now is that HALF of this host can
 * die. The page is a document that has already been served; it keeps running,
 * keeps drawing, keeps every module's frame alive — and every call it makes
 * to its own server is refused. `server/ports.ts` already has a name for that
 * state on the other side of the same coin: `half`, an API answering with no
 * page behind it. This is the mirror of it, and it is the one a person
 * actually sees, because the surviving half is the half they are looking at.
 *
 * Four separate places had each written their own sentence about it:
 * `App.tsx`'s sweep, `Tools.tsx` twice, and `Start.tsx`. All four said the
 * same thing in slightly different words, none of them said what to do about
 * it, and no one of them could be improved without finding the other three.
 * That is the copy-paste this workspace keeps arguing against, so detection,
 * wording and remedy live here, together, and the call sites relay.
 *
 * ## What actually causes it, which is why the remedy reads as it does
 *
 * Measured rather than guessed: `run.sh` starts the API in the background and
 * then blocks on Vite. If the API exits — a crash, an import that no longer
 * resolves, an agent's stray `kill` on the port — nothing noticed. The script
 * sat in `wait`, Vite carried on serving a perfectly good page, and the API
 * stayed dead until a person restarted the whole host by hand, losing every
 * module's document to do it.
 *
 * A single unresolved export in a file somebody was editing reproduced it on
 * the first attempt: the API printed a `SyntaxError` and exited, the page came
 * up, and the terminal filled with `ECONNREFUSED` from Vite's proxy while the
 * canvas showed the sentence below.
 *
 * `run.sh` now supervises the API and starts it again when it goes, backing
 * off and saying so — see the essay there. So the honest remedy for a person
 * reading this line is USUALLY to wait a moment, and the sentence says that
 * rather than offering a control. The page also retries on its own, with a
 * backoff, so the line clears itself when the server comes back.
 *
 * ## Why the page does not offer to restart the server
 *
 * Because it cannot, and a control that does nothing is worse than no control.
 * The page's only channel to the API is the API — the thing that is not
 * answering. Vite is alive and could in principle be given a middleware that
 * spawns a process, and the desktop shell's Rust side could in principle be
 * given a Tauri command; neither exists today (`kehikko-desktop` registers no
 * `invoke_handler` at all), and both would be a SECOND thing restarting a
 * server that `run.sh` is already restarting. One supervisor, in the script
 * that owns both halves, is the arrangement this host already argues for
 * everywhere else.
 *
 * What the page can honestly offer is to LOOK AGAIN, immediately, rather than
 * waiting for its own backoff — and that is what the footer offers.
 */

/**
 * The words every one of these sentences begins with.
 *
 * Exported so the footer can recognise its own line rather than guess from a
 * substring somebody might reword. This is not string-sniffing across a
 * boundary: the module that WRITES the sentence is the module that reads it
 * back, and `test/reachable.test.ts` fails if the two ever drift.
 */
export const NOT_ANSWERING = "This host's own server is not answering"

/**
 * What a person should do about it, which is mostly nothing.
 *
 * Deliberately says where the reason is rather than pretending to know it. The
 * page cannot see why the server died — the server is where that would have
 * been reported from — and the terminal the host was started from has both the
 * crash and `run.sh`'s own line about restarting it.
 */
export const WHAT_HAPPENS_NEXT =
  'The page and everything on the canvas are unharmed. run.sh starts the server again by itself and this '
  + 'line goes when it answers; if it stays, the reason is printed in the terminal the host was started from.'

/**
 * The sentence, given whatever was thrown.
 *
 * `also` is for the one caller that has something extra worth saying — the
 * sweep, whose failure means the host knows nothing about what is registered.
 * It goes between the reason and the remedy, so every one of these lines ends
 * the same way and a person who has read one has read them all.
 */
export function notAnswering(error: unknown, also?: string): string {
  return `${NOT_ANSWERING}: ${reason(error)}.${also ? ` ${also}` : ''} ${WHAT_HAPPENS_NEXT}`
}

/**
 * Is this line one of ours?
 *
 * The footer asks, because the offer to look again belongs to this fault and
 * to no other: a canvas that could not be saved and a `.gitignore` that was
 * not changed are also `trouble`, and re-sweeping the registry would do
 * nothing whatever about either.
 */
export function isNotAnswering(line: string | null | undefined): boolean {
  return typeof line === 'string' && line.startsWith(NOT_ANSWERING)
}

/**
 * The same fault, said to a MODULE rather than to a person.
 *
 * A separate sentence and not a wording of the one above, because it carries a
 * fact the others do not and that fact is the important one: the call was not
 * made. A module told only that something failed has to assume its request may
 * have landed; told this, it knows it did not, and may retry. The protocol is
 * explicit that `failed` and `unknown-method` mean different futures — this is
 * the `failed` kind, and it is worth retrying.
 *
 * It stays short. It is read by a program, and shown by whichever module
 * chooses to show it, inside a container that is not this host's to lay out.
 */
export const CALL_NOT_MADE =
  "The host's server did not answer. It may be restarting; the call was not made."

/**
 * The readable half of whatever was thrown.
 *
 * A thrown non-`Error` is a real possibility here — `fetch` rejects with a
 * `TypeError`, but a proxy in the middle can produce almost anything — and
 * `String(undefined)` in the middle of a sentence is how a fault message
 * becomes "This host's own server is not answering: undefined."
 *
 * The trailing full stop is stripped because the caller adds one. Browsers
 * disagree about whether their network errors end in a period, and the two
 * spellings of the same failure should not read as two failures.
 */
function reason(error: unknown): string {
  const said = (error instanceof Error ? error.message : String(error ?? '')).trim()
  return said.length > 0 ? said.replace(/\.+$/, '') : 'the request did not complete'
}
