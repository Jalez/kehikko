/**
 * A sweep that began after a moment: the one out when it did, else the next one.
 *
 * Sweeps are shared — a sweep asked for while one is out gets that one (`sweep` in `server.ts`).
 * That is right for "what is there", and wrong for the one question a start asks: "now that it
 * answered, what does it look like?". The sweep out may have begun before the module answered,
 * and then it says the module is silent and starting. That reading was handed to the page as the
 * answer to a restart, and the page held "Starting…" over a module that had been answering for
 * half a minute, until the thirty-second watch happened to look — long enough that a person
 * pressed Restart again, and the next restart moved the module to another port. Measured on a
 * scratch host: thirty-five seconds of "Starting…" after a restart that took half a second.
 *
 * So a start asks for a sweep that BEGAN after it answered: the one out when it did, else the
 * next after it. `out` is the sweep out, with when it began.
 */
export function sweepAfter<T>(
  out: () => { running: Promise<T>; since: number } | null,
  at: number,
  start: () => Promise<T>,
): Promise<T> {
  const now = out()
  if (!now) return start()
  if (now.since >= at) return now.running
  return now.running.catch(() => null).then(() => sweepAfter(out, at, start))
}
