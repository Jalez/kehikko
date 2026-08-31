/**
 * When a module should be running, and when it should not.
 *
 * ## The measurement this exists because of
 *
 * Thirteen module servers on this machine, a little over a gigabyte resident,
 * all of them up all the time. The four kehikot here hold seven, five, one and
 * zero containers between them, three registered modules are on no kehikko at
 * all, and a person can look at exactly one kehikko at a time. So most of that
 * memory was serving a canvas nobody had open.
 *
 * VS Code solved the same problem with activation events — an extension
 * declares `onLanguage:python` and a person with fifty installed is running
 * eight. The equivalent sentence here is shorter and needs no new vocabulary:
 * **this module is on the kehikko I am looking at**. The host already knows
 * which kehikko each open page has (`open.ts`) and which modules are on it
 * (`canvases.ts`). Nothing had to be invented; only a policy had to be decided.
 *
 * ## The policy, in four lines
 *
 *  - A module on a kehikko an open page is looking at is NEEDED.
 *  - A needed module that nothing answers for is STARTED, if its registration
 *    says how.
 *  - A module that has not been needed for `GRACE_MS` is STOPPED — but only if
 *    this host process started it, and only if its owner has not said to keep it.
 *  - Nothing is started because it exists. Boot starts nothing.
 *
 * ## Why the grace period is five minutes
 *
 * The number is bounded from both sides and the bounds are far apart, which is
 * the only reason a single constant is honest here.
 *
 * From below: the cost of a wrong stop is a restart, and a restart of a Vite
 * dev server is one to six seconds of somebody watching a container say
 * "starting". Everything that makes a module momentarily unneeded is much
 * faster than five minutes — switching between two kehikot is a click, a page
 * reload is a second, restarting this host is ten. A grace of thirty seconds
 * would already survive all of those; five minutes survives them with two
 * orders of magnitude to spare, including a person who closes the tab to read
 * something and comes back.
 *
 * From above: the saving only arrives when the process actually exits, and a
 * person switches kehikko a handful of times an hour. An hour-long grace would
 * mean a canvas used all morning never releases anything, which is the eager
 * boot again wearing a timer. Five minutes returns the memory within a coffee
 * break and long after any plausible switch.
 *
 * It is deliberately NOT tuned to the fastest possible saving. The failure this
 * design must not have is thrashing — a module stopped and restarted while
 * somebody is working across two canvases — because that failure is loud,
 * repeated, and destroys state. Being slow to save memory is quiet and costs
 * nobody their afternoon.
 *
 * ## Why stopping is not the mirror image of starting
 *
 * Starting a program that is not running takes nothing away. Stopping one
 * destroys everything it was holding: a terminal's live shell, an editor's
 * unsaved buffer, a long-running build. The whole persistent-iframe design in
 * `Frames.tsx` exists to avoid exactly that class of loss, and a memory saving
 * that reintroduced it through the back door would be a bad trade made
 * invisibly. So stopping carries two gates that starting does not:
 *
 *  1. **The host may only stop what the host started.** See `Nursery` in
 *     `launch.ts`. Every module on this machine right now was started by hand in
 *     somebody's terminal, and their process is somebody's foreground job with a
 *     log they are reading. The host has no business killing those and, more to
 *     the point, no way to: the only thing that can be stopped is a process this
 *     host holds a pid for, because it spawned it.
 *
 *  2. **The owner may say "keep this one".** See `keep` in `registrations.ts`.
 *
 * ## Why "keep" is a field in the REGISTRATION and not in the manifest
 *
 * This was the tempting one, and it is wrong for three separate reasons.
 *
 * A manifest field would be a protocol change — a version bump, a schema in the
 * shared package, and every module in the workspace re-released before the host
 * could rely on it. That is a large bill for one boolean.
 *
 * It would also be the wrong program saying it. A manifest is a module
 * describing ITSELF; `keep` describes what this host is permitted to do to it.
 * A module that could exempt itself from being stopped would be a module
 * granting itself a permission, and every module author's honest answer to "may
 * I be stopped?" is no. The exemption has to come from the person, in a file
 * the person wrote.
 *
 * And the registration is already where the rest of this faculty lives. The
 * argument in `launch.ts` for why `dir` cannot be a manifest field — a manifest
 * is served by a running module, and the moment you need one is the moment
 * there is none — makes `keep` its natural neighbour. Starting and stopping are
 * one capability. The file that says the host MAY run this program is the file
 * that says it may not stop it. Nothing versions, nothing coordinates, and a
 * person reads both facts in the same four-line file.
 *
 * A host-side list of names was the third option and is the worst of the three:
 * it would put the names of somebody else's modules in this repository, which
 * is the catalogue this host has spent every other decision refusing to have.
 *
 * ## The one thing this cannot save, and it is worth saying out loud
 *
 * The whole policy hangs on a page reporting what it has open, and a page that
 * dies without running `pagehide` never withdraws its report. `open.ts` clears
 * a report after half a day, deliberately, so that nothing has to poll — which
 * means a browser killed rather than closed can hold a kehikko's modules alive
 * for twelve hours after the screen it was on stopped existing.
 *
 * That is the right trade and it is still a real hole. The alternative is a
 * heartbeat, and a page making a request every ten seconds to say nothing has
 * changed is the cost this codebase has refused everywhere else — paid forever,
 * by every open tab, to make an uncommon failure recover faster. The failure
 * itself is benign: the modules that were running keep running, exactly as they
 * did before any of this existed.
 *
 * ## What is in this file and what is not
 *
 * Everything here is a pure function of facts and a clock. Nothing in it
 * spawns, kills, fetches or reads a disk — `server.ts` gathers the facts,
 * `launch.ts` owns the processes, and this decides. That split is what lets the
 * policy be tested exhaustively without a single process being created.
 */

/** Five minutes. The argument is above, and it is the whole of the tuning. */
export const GRACE_MS = 5 * 60 * 1000

/**
 * How long a module is described as "starting" before the host stops claiming so.
 *
 * Longer than `ANSWERS_WITHIN_MS` in `launch.ts`, because that is how long the
 * host waits before REPORTING and this is how long the word stays true on a
 * container. A dev server that is compiling for twelve seconds is starting; one
 * that has said nothing for a minute is not starting, it is failing, and the
 * container should go back to saying so with a button on it.
 */
export const STARTING_FOR_MS = 30_000

/**
 * Everything the policy is allowed to know about one registered module.
 *
 * Deliberately flat booleans rather than the objects they were derived from.
 * A policy that took a `Presence` and a `Registration` could ask them new
 * questions later, and the set of things it may consider would stop being
 * readable in one place.
 */
export interface Standing {
  id: string
  /** On a kehikko that some live page says it has open. */
  needed: boolean
  /**
   * Something answered at its address — anything at all, including a 404 or a
   * document that was not a manifest.
   *
   * Not `condition === 'ready'`, and the difference is a port collision. Three
   * different failures are spelled `silent` by `discover.ts`, and two of them
   * mean a process IS listening there. Starting a module because its neighbour
   * has taken its port would spawn a second server that cannot bind and dies,
   * every sweep, forever.
   */
  answering: boolean
  /** Its registration names a directory with an executable run.sh in it. */
  startable: boolean
  /** This host process spawned the process that is there, and still holds it. */
  ours: boolean
  /** The owner wrote `keep: true` in its registration. */
  keep: boolean
  /**
   * When it was last needed — or, for a module that has never been needed since
   * this host started it, when the host started it.
   *
   * `null` means the host has no such moment to measure from, which is every
   * module it did not start. Those can never be stopped anyway; the null is
   * there so that nothing has to invent a zero and accidentally make "never
   * seen" mean "idle since the epoch".
   */
  idleSince: number | null
  /** A start this host asked for is still in flight. */
  starting: boolean
}

/**
 * Which modules to start, right now.
 *
 * Only ever a module somebody is looking at the container of. There is no
 * warming, no prediction, and no starting of the other twelve because one was
 * wanted — a host that ran programs on a guess is the thing `launch.ts` refuses
 * in its own essay, and a guess dressed as an optimisation is still a guess.
 */
export function toStart(standings: readonly Standing[]): string[] {
  return standings
    .filter((s) => s.needed && !s.answering && s.startable && !s.starting)
    .map((s) => s.id)
}

/**
 * Which modules to stop, right now.
 *
 * Read the conditions as a list of things that must ALL be true, because that
 * is what makes this safe: every one of them is a separate reason not to stop a
 * program, and the order they are written in is the order of how bad it would
 * be to get each one wrong.
 */
export function toStop(standings: readonly Standing[], now: number, grace = GRACE_MS): string[] {
  return standings
    .filter((s) => {
      /* Not ours: somebody else's process, quite possibly in a terminal they
         are watching. This is the gate that matters most and it is doubled —
         `Nursery.stop` refuses on the same fact, from the map that would have
         to hold the pid. */
      if (!s.ours) return false
      /* The owner said no. */
      if (s.keep) return false
      /* Somebody is looking at it. */
      if (s.needed) return false
      /* Still coming up. Killing a module mid-start would leave a half-booted
         dev server and a container that had said "starting" and then lied. */
      if (s.starting) return false
      /* Nothing is answering there anyway; there is nothing to stop, and the
         pid we hold is a corpse. Forgetting it is `Nursery`'s job. */
      if (!s.answering) return false
      if (s.idleSince === null) return false
      return now - s.idleSince >= grace
    })
    .map((s) => s.id)
}

/**
 * What the host has to say about a module that is not answering because of
 * something the host itself did.
 *
 * `discover.ts` establishes the three conditions and writes the sentence for
 * each, and its `silent` sentence is careful and correct: it names the address,
 * says the host expected a module there, and says the program is not running
 * rather than not found. It is still the wrong sentence for a module THIS HOST
 * stopped, because it describes a state of affairs the reader is invited to fix
 * — and there is nothing here to fix.
 *
 * Asleep and silent must not read alike. Silent is "it is not running and I do
 * not know why". Asleep is "I stopped it, on purpose, for a reason, and it
 * comes back on its own". A person who cannot tell those apart goes looking for
 * a fault that does not exist, and this workspace's whole style is that two
 * different facts get two different sentences.
 *
 * Neither is a fourth condition. The vocabulary stays at three words — see the
 * essay in `Conditions.tsx` — and this is a fact about what the host did,
 * carried beside the condition rather than inside it, the same way
 * `ConnectingPanel` is a state of the page rather than a state of the program.
 */
export type Lifecycle = 'starting' | 'asleep'

/** Said on a container whose module the host has just run. */
export function startingLine(id: string, at: string): string {
  return (
    `${id} is starting. This kehikko has it, so the host ran its run.sh; ` +
    `it has not answered at ${at} yet. This resolves on its own — the container becomes the module, ` +
    `or says the module was run and did not answer.`
  )
}

/** Said on a container whose module the host stopped because nothing used it. */
export function asleepLine(id: string, at: string): string {
  return (
    `${id} is asleep. The host started it, then stopped it because no open kehikko had it for ` +
    `${Math.round(GRACE_MS / 60_000)} minutes. Nothing is wrong with it: open a kehikko it is on ` +
    `and the host starts it again at ${at}.`
  )
}

/**
 * When each module was last needed.
 *
 * A map and a clock, kept by the server for as long as its process lives, and
 * deliberately not written down. It is a claim about what somebody has been
 * looking at in the last few minutes; a host that restarted and read that off a
 * file would be asserting something about a screen it has never seen. A fresh
 * process simply has nothing it may stop, which is the correct answer.
 */
export class Idleness {
  #lastNeeded = new Map<string, number>()

  /** Everything on an open kehikko has been needed as of `now`. */
  noted(needed: Iterable<string>, now = Date.now()): void {
    for (const id of needed) this.#lastNeeded.set(id, now)
  }

  /**
   * The moment to measure idleness from, given when the host started it.
   *
   * The later of the two, and the fallback matters: a module the host started
   * for a kehikko that was closed a second later has never been "last needed"
   * after the fact, and measuring from the epoch would stop it on the next tick.
   */
  since(id: string, startedAt: number | null): number | null {
    const last = this.#lastNeeded.get(id)
    if (last === undefined) return startedAt
    if (startedAt === null) return last
    return Math.max(last, startedAt)
  }

  /** A module that is no longer registered stops being remembered. */
  forgetAllBut(ids: Iterable<string>): void {
    const keep = new Set(ids)
    for (const id of [...this.#lastNeeded.keys()]) if (!keep.has(id)) this.#lastNeeded.delete(id)
  }
}
