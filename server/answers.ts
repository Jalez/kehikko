import {
  LIMITS,
  METHOD_NAMES,
  methodParams,
  type ResponseFailureReason,
} from 'roadmap-module-protocol'
import {
  ANSWERED_BY_THE_SERVER,
  ANSWERED_BY_THE_VIEW,
  assertEveryMethodIsAnswered,
} from '../src/host/division.ts'
import { shaped } from '../src/host/shape.ts'
import { epicsIn, listEpics, readEpic, readLive, readSteps } from './holdings.ts'

/**
 * What this host answers, and — much more of the file — what it does not.
 *
 * The protocol package names the questions and gives each one a shape a caller
 * must construct. It deliberately says nothing about what comes back, because
 * that is the host's material and two honest hosts differ in it. This file is
 * this host's material, and this host has none: it installs nothing, stores
 * nothing, and reads no tracker. Everything below is therefore an answer about
 * emptiness, and the whole design problem is that there are two completely
 * different kinds of emptiness and a module has to be able to tell them apart.
 *
 * ## "Nothing to show" and "not mine to say"
 *
 * **Nothing to show** is a successful answer whose content is empty. The host
 * looked in its own holdings, the holdings are empty, and the empty list is the
 * true answer. A module receiving it can draw "no epics yet" and get on with
 * its life. `epics.list` is this: this host holds no epics, so the list of
 * epics it holds is the empty list, and that is not an evasion.
 *
 * **Not mine to say** is a refusal. The host is not the authority on the
 * question at all, so there is no empty answer to give — an empty one would be
 * a claim, and a false one. What the trackers last reported is not this host's
 * to say, because this host does not read trackers; a `data: null` there would
 * tell a module "the trackers reported nothing", which is a different and
 * untrue sentence.
 *
 * Collapsing the two is the failure worth naming. A host that answered
 * everything with `ok: true, data: null` would be a host that never refuses and
 * never lies outright, and a module written against it would draw an empty
 * panel for a question nobody ever answered. `ok: false` with a sentence is
 * what stops that: the refusal reaches the module author's console with the
 * name of the call in it.
 *
 * ## Writes are refused rather than absorbed
 *
 * `stage.report` asks this host to record something. It cannot. The tempting
 * answer is `ok: true` — nothing breaks, the module's button turns green,
 * everybody is happy — and it is the worst answer available, because the module
 * now believes a report exists that does not. Every write this host cannot
 * perform is refused, with a sentence saying what did not happen.
 *
 * `events.emit` used to be the second of those and is no longer refused by
 * anybody: the protocol grew a message that carries an event into a frame, and
 * the call moved to the half of the host that HAS frames. The note where it
 * used to stand, further down, says what changed and why the answer did not
 * simply appear here.
 */

/** What one answer looks like before it becomes a `roadmap.response`. */
export type Answer =
  | { ok: true; data: unknown }
  | { ok: false; reason: ResponseFailureReason; error: string }

/**
 * A successful answer, held to the shape the protocol names for that method.
 *
 * `shaped` returns the PARSED value, so a field the protocol gives a default
 * gets one. A host whose own answer does not fit says so as a `failed` rather
 * than sending it: an unreadable answer to the front door is worse than a
 * refusal, because a refusal has a sentence in it.
 */
const nothingToShow = (method: string, data: unknown): Answer => {
  const held = shaped(method, data)
  return held.ok ? { ok: true, data: held.data } : { ok: false, reason: 'failed', error: held.why }
}
const notMineToSay = (error: string): Answer => ({ ok: false, reason: 'failed', error })

/* Which half answers what, and the check that nothing falls between them, live
   in `src/host/division.ts` — one file, because the failure worth catching is a
   method that NEITHER half claims. This runs at load and throws. */
assertEveryMethodIsAnswered()

/**
 * The parameter schemas, as a Map.
 *
 * A `Map` rather than `methodParams[method]`, and the protocol package is
 * emphatic about why: a method name arrives from somebody else's program, and
 * `constructor` is a perfectly legal string. On a plain object that lookup
 * answers with a function — truthy, so the caller believes it holds a schema,
 * and the lie surfaces later as a TypeError somewhere nothing is catching. A
 * Map has no prototype chain to fall through.
 */
const params = new Map<string, (typeof methodParams)[keyof typeof methodParams]>(
  Object.entries(methodParams),
)

const answeredHere = new Set<string>(ANSWERED_BY_THE_SERVER)
const answeredByTheView = new Set<string>(ANSWERED_BY_THE_VIEW)

/**
 * Answer one call.
 *
 * `knownModule` is asked rather than assumed, and it is the caller's job to
 * make that a lookup that does not fall through a prototype — see `callers` in
 * `server.ts`. A module the host no longer has is the ordinary case of somebody
 * removing a registration while a frame was still open, and it earns
 * `unknown-module` rather than `failed`: "ask again" and "never" are different
 * futures and the module's code should not have to read English to tell them
 * apart.
 */
export function answer(
  moduleId: string,
  method: string,
  rawParams: unknown,
  knownModule: (id: string) => boolean,
  /**
   * Where a module's kept state goes.
   *
   * Injected, like `knownModule`, so this file stays a decision table rather
   * than something that opens a database. Everything here is testable by
   * calling it; a `Database` in the signature would mean a temp file per test
   * for the sake of one branch.
   */
  keep: (module: string, state: string) => void = () => {},
  /**
   * Which project folder this call is about, or null.
   *
   * A parameter, and never an environment variable read in here. It used to be
   * the latter — `holdingsDir()` off `KEHIKKO_ROADMAP_DIR` — and that made
   * every epic answer be about one folder for the life of the process, however
   * many projects the person had open and whichever one they were looking at.
   * The host would have shown them the thesis and answered `epics.list` out of
   * the roadmap, correctly, with no symptom.
   *
   * Null is the ordinary state and not a failure: a host with no project open,
   * a call from a frame on a project that has no `data/epics`, or a test that
   * has deliberately given it nothing. Every branch below already had to answer
   * for a host holding nothing, so null needs no new sentence.
   */
  root: string | null = null,
): Answer {
  if (!knownModule(moduleId)) {
    return {
      ok: false,
      reason: 'unknown-module',
      /* The module's own id is quoted back, and it is the one string from the
         caller that appears in an answer. It is bounded by MODULE_ID having
         matched on the way in — 64 characters of lowercase — so there is no
         document to round-trip here. */
      error: `This host has no module registered as ${moduleId}. Its registration may have been removed while its frame was open.`,
    }
  }

  if (answeredByTheView.has(method)) {
    /* Reachable only if the canvas forwarded something it should have kept.
       Named plainly rather than dressed as an unknown method, because the fault
       is the host's and the sentence goes to the module author's console. */
    return notMineToSay(
      `${method} is answered by the canvas, not by the host's server. This host forwarded it to the wrong side of itself.`,
    )
  }

  if (!answeredHere.has(method)) {
    /* The method name is NOT quoted back. It is bounded at LIMITS.METHOD on the
       way in, so quoting it would be safe — and it is still not worth it: a
       module asking for a method that does not exist already knows what it
       asked for, and a host that echoes strangers' strings by habit is a host
       that will echo an unbounded one the day somebody adds a field without a
       max. The habit is the thing being avoided. */
    return {
      ok: false,
      reason: 'unknown-method',
      error: `This host speaks ${METHOD_NAMES.length} methods and that is not one of them. Nothing here answers it, now or later.`,
    }
  }

  const schema = params.get(method)
  if (!schema) {
    return notMineToSay('This host has no parameter schema for a method it claims to answer.')
  }

  const parsed = schema.safeParse(rawParams ?? {})
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'params'
    return {
      ok: false,
      reason: 'failed',
      /* The zod message, and not the value that failed. zod's own enum and
         literal messages echo what they were given, which is how twenty
         thousand characters of somebody's bad input became twenty thousand
         characters of a row under their own name in the implementation this
         protocol was distilled from. `where` is a path built from the schema,
         not from the input, so it is the host's own string. */
      error: `${method} was called with something this host will not accept: ${where} — ${clip(issue?.message ?? 'malformed')}.`,
    }
  }

  /**
   * Where this call's holdings are, if there are any.
   *
   * Checked per call rather than once at startup, because a refresh rewrites
   * those files underneath a running host, because `data/epics` can appear
   * under a project that did not have it a minute ago, and because which
   * project is being asked about is now a property of the call rather than of
   * the process.
   */
  const dir = epicsIn(root)

  switch (method) {
  /**
   * The list, from the holdings when there are any.
   *
   * `{ epics: [] }` rather than `[]`, because the package gives this one answer
   * a shape and this is it. A host with nowhere to read from still answers the
   * empty list, and that is still true — it holds no epics, so the list of
   * epics it holds is empty. This is the one question where emptiness is honest
   * without a source, and a module can draw "no epics" from it and be right
   * either way.
   */
  case 'epics.list':
    return nothingToShow('epics.list', { epics: dir ? listEpics(dir) : [] })

  /**
   * One epic, or a refusal that does not describe its neighbours.
   *
   * The slug is not quoted back, and that is the protocol package's argument
   * rather than a bound: a refusal that names what it could not find is one
   * step from a refusal that names what it could, and a host whose "no such
   * epic" lists the epics that do exist has enumerated its holdings in an error
   * message. The habit of not quoting is what keeps that from being written.
   */
  case 'epic.get': {
    if (!dir) {
      return notMineToSay('This host holds no epics of its own, so there is nothing here under that name.')
    }
    const { epic } = parsed.data as { epic: string }
    const found = readEpic(dir, epic)
    if (!found) return notMineToSay('There is no epic here under that name.')
    return nothingToShow('epic.get', found)
  }

  case 'steps.list': {
    if (!dir) {
      return notMineToSay('This host holds no epics of its own, so there are no steps here to read.')
    }
    const { epic } = parsed.data as { epic: string }
    const steps = readSteps(dir, epic)
    if (steps === null) return notMineToSay('There is no epic here under that name.')
    return nothingToShow('steps.list', { steps })
  }

  /**
   * What the trackers last reported.
   *
   * Answered out of `data/state/`, which a refresh writes and nobody edits by
   * hand — so this host relays a reading rather than making a claim of its own.
   * `generated` travels with it and is the most important field in the answer:
   * tracker state with no date on it is last week presented as now.
   *
   * With nowhere to read from this stays a refusal rather than becoming an
   * empty answer. "The trackers reported nothing about this epic" is a claim
   * about GitHub and GitLab that a host reading no trackers cannot make.
   */
  case 'live.get': {
    if (!dir) {
      return notMineToSay(
        'This host does not read the trackers, so what they last reported is not this host\'s to say.',
      )
    }
    const { epic } = parsed.data as { epic: string }
    const live = readLive(dir, epic)
    if (!live) {
      /* The epic may be real and simply never refreshed. Either way nothing
         here has read a tracker about it, and empty bags would say they were
         read and found nothing. */
      return notMineToSay('Nothing has been read from the trackers for that epic.')
    }
    return nothingToShow('live.get', live)
  }

  /**
   * A module's own state, kept and handed back at the next greeting.
   *
   * The first write this host actually performs, and it is worth noticing how
   * small the thing being written is. The host does not parse it, does not
   * validate its contents past a length, and has no name for what is in it —
   * see `state.set` in the protocol package for why that opacity is the design
   * rather than laziness. A host that knew a module had "filters" would have
   * made every module's preferences the protocol's business.
   *
   * Keyed by the module that asked, which is the id already checked against the
   * registry at the top of this function. A module cannot write another's state
   * because it has no way to name one: the id comes from the registry, not from
   * the call.
   */
  case 'state.set': {
    const { state } = parsed.data as { state: string }
    keep(moduleId, state)
    return nothingToShow('state.set', { kept: true })
  }

  /**
   * A write, refused. `ok: true` would cost nothing today and would mean a
   * module's button turning green over a report that exists nowhere — the
   * module believes work was filed, the person believes it was filed, and there
   * is no file. A refusal reaches the author's console with the call in it.
   */
  case 'stage.report':
    return notMineToSay(
      'This host has no store to file a stage report in. Nothing was recorded — and saying otherwise would have been the more useful lie.',
    )

  /**
   * The refusal that was answered, and the one worth reading the protocol
   * against. It is not here any more, and this note is what it left behind.
   *
   * ## What it used to say, because the reasoning was right
   *
   * `events.emit` is how a module sends a notification or a report of its own
   * calls to whichever other module consumes that format. This host could do
   * every part of that except the last: it could check the extension was one it
   * knew, it could validate the payload against the format's own schema, it
   * knew from each manifest which modules `consume` the name — and then there
   * was no message to deliver it with. The wire had eight messages and none of
   * them carried an extension payload from a host to a module. So the honest
   * answer was a refusal that said what had not happened, and it stood here as
   * this host's principal piece of feedback on the protocol itself.
   *
   * ## What changed
   *
   * The protocol grew the ninth message. `roadmap.event` carries an extension
   * payload from the host into a frame — unanswered, with no correlation id,
   * because a host that waited for acknowledgement could be hung by a pane
   * nobody is looking at. The gap this refusal named is closed, and the refusal
   * is gone rather than being left in place with a comment saying it is stale.
   *
   * ## Why the answer did not simply appear here instead
   *
   * Because delivery is not a thing this half of the host can do. Every frame
   * on this canvas is a window in the browser, and the server has never held a
   * window handle. `events.emit` therefore moved to the VIEW — see
   * `ANSWERED_BY_THE_VIEW` in `src/host/division.ts`, and `src/host/events.ts`
   * for the deciding — and it is answered in the same place and for the same
   * reason as `selection.set`: the canvas is what has the frames.
   *
   * The two checks moved with it, unchanged, because they were correct. They
   * travel WITH the sending rather than being left behind as a server-side
   * pre-flight, so that the thing that validates and the thing that delivers
   * are one thing and cannot drift into disagreeing about what is deliverable.
   * A call arriving here now is the canvas having forwarded something it should
   * have kept, and the guard at the top of this function says exactly that.
   */

  default:
    /* Unreachable: `answeredHere` and this switch are the same list, and the
       load-time assertion above fails the process if they drift from the
       protocol's. Present because a `default` that throws would turn a rename
       into a crash in a request handler. */
    return notMineToSay('This host claims to answer that method and does not.')
  }
}

/**
 * Keep a sentence inside the bound the protocol puts on a refusal.
 *
 * Applied to text that came from zod rather than from the host, because zod's
 * messages quote what they were given. Clipping is right for a sentence and
 * wrong for a ref — a clipped sentence is still the sentence, a clipped ref is
 * a different ref — and this is only ever used on sentences.
 */
function clip(sentence: string): string {
  const room = LIMITS.REASON - 120
  return sentence.length > room ? `${sentence.slice(0, room)}…` : sentence
}
