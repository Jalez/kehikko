import { METHOD_NAMES } from 'roadmap-module-protocol'

/**
 * Which half of the host answers which method — and the check that nothing
 * falls between them.
 *
 * The host is two programs: a server that knows what is registered, and a page
 * that is the canvas. Nearly every method a module can call is about the host's
 * material and is answered by the server. Exactly one is about the host's VIEW
 * — `view.goto` asks the host to show something — and a view is not a thing a
 * server has. So the canvas answers that one, in the browser, where the canvas
 * is.
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
  'events.emit',
] as const

export const ANSWERED_BY_THE_VIEW = ['view.goto'] as const

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
