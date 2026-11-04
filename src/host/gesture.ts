/**
 * Whether the person has just pressed something in this page or in a frame
 * inside it (protocol 2.50.0, `messages.say`).
 *
 * `navigator.userActivation.isActive` is the browser's own word for a fresh
 * press — a click, a key, a tap — and it is TRANSIENT: true for a few seconds
 * after one, then false. A press inside a module's frame activates this
 * document too (activation is propagated to the ancestors of the frame that
 * was pressed), so the host can tell that a request from a frame arrived while
 * the person's press there was fresh. A module cannot make one: a script's
 * events, a message, a timer or an agent's relayed header press activate
 * nothing.
 *
 * Read synchronously, when the frame's request arrives (`Conversation.receive`),
 * before anything is awaited. Fails closed: a webview without the API answers
 * false, and a person's message is then refused rather than sent unproven.
 */
export function pressFresh(nav: unknown = globalThis.navigator): boolean {
  const activation = (nav as { userActivation?: { isActive?: unknown } } | undefined)?.userActivation
  return activation?.isActive === true
}
