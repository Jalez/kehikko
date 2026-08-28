import {
  known,
  LIMITS,
  METHOD_NAMES,
  methodParams,
  schemaFor,
  type ResponseFailureReason,
} from 'roadmap-module-protocol'
import {
  ANSWERED_BY_THE_SERVER,
  ANSWERED_BY_THE_VIEW,
  assertEveryMethodIsAnswered,
} from '../src/host/division.ts'
import { shaped } from '../src/host/shape.ts'

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
 * `stage.report` and `events.emit` ask this host to record or to deliver
 * something. It can do neither. The tempting answer is `ok: true` — nothing
 * breaks, the module's button turns green, everybody is happy — and it is the
 * worst answer available, because the module now believes a report exists that
 * does not. Every write this host cannot perform is refused, with a sentence
 * saying what did not happen.
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

  switch (method) {
  /**
   * Nothing to show. This host holds no epics, so the list of epics it holds
   * is empty, and the empty list is true rather than evasive. A module can
   * draw "no epics" from it and be right.
   */
  case 'epics.list':
    /* `{ epics: [] }` rather than `[]`, because the package gives this one
       answer a shape and this is it. The empty list is the true answer: this
       host holds no epics, so the list of epics it holds is empty, and a module
       can draw "no epics" from it and be right. */
    return nothingToShow('epics.list', { epics: [] })

  /**
   * Not found, rather than not mine: `epics.list` already said the host holds
   * none, so a named one not being here is the consistent answer and not a new
   * claim.
   *
   * The slug is not quoted back, and that is the protocol package's argument
   * rather than a bound: a refusal that names what it could not find is one
   * step from a refusal that names what it could, and a host whose "no such
   * epic" lists the epics that do exist has enumerated its holdings in an error
   * message. The habit of not quoting is what keeps that from being written.
   */
  case 'epic.get':
    return notMineToSay('This host holds no epics of its own, so there is nothing here under that name.')

  case 'steps.list':
    return notMineToSay('This host holds no epics of its own, so there are no steps here to read.')

  /**
   * Not mine to say, and the clearest case of it. An empty answer here would
   * mean "the trackers reported nothing about this epic", which is a claim
   * about GitHub and GitLab that this host is in no position to make. It does
   * not refresh anything and never has.
   */
  case 'live.get':
    return notMineToSay(
      'This host does not read the trackers, so what they last reported is not this host\'s to say.',
    )

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
   * The interesting refusal, and the one worth reading the protocol against.
   *
   * `events.emit` is how a module sends a notification or a report of its own
   * calls to whichever other module consumes that format. This host can do
   * every part of that except the last: it can check the extension is one it
   * knows, it can validate the payload against the format's own schema, it
   * knows from each manifest which modules `consume` the name — and then there
   * is no message to deliver it with. The wire has eight messages and none of
   * them carries an extension payload from the host to a module. `hello`,
   * `context`, `response` and `goto` are the whole of what a host may say.
   *
   * So the honest answer is a refusal that says what did not happen, and this
   * is the host's principal piece of feedback on the protocol itself.
   */
  case 'events.emit': {
    const { extension, payload } = parsed.data as { extension: string; payload: unknown }
    if (!known(extension)) {
      return notMineToSay(
        'This host does not know that extension format, so it cannot check the payload and will not carry it.',
      )
    }
    const format = schemaFor(extension)
    const checked = format?.safeParse(payload)
    if (!checked?.success) {
      const issue = checked?.error.issues[0]
      const where = issue?.path.length ? issue.path.join('.') : 'payload'
      return notMineToSay(
        `The payload does not match that extension's format: ${where} — ${clip(issue?.message ?? 'malformed')}.`,
      )
    }
    return notMineToSay(
      'This host has nowhere to deliver an extension payload: the wire carries hello, context, response and goto from a host, and none of them carries an event. The payload was valid and was not delivered.',
    )
  }

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
