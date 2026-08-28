import { known, LIMITS, MESSAGE, PROTOCOL, schemaFor } from 'roadmap-module-protocol'

/**
 * Who hears what one module emitted, and how much of it a canvas will carry.
 *
 * ## Why this is in the browser and not on the server
 *
 * `events.emit` was answered by the server for as long as the answer was a
 * refusal, because a refusal needs no frames. Delivery does. The server knows
 * which modules are registered and what each says it consumes, and it has no
 * window handle to post through — every `roadmap.event` goes out over
 * `postMessage` to an iframe that exists only on the canvas. Sending it from
 * the server would mean inventing a channel from the server back to the page
 * whose only cargo would be events the page then re-posts, which is the same
 * delivery with an extra hop and a second place for it to be dropped.
 *
 * So this is a view thing, in the same sense `selection.set` is: the canvas
 * holds the frames, the canvas composes what they are told, and the canvas is
 * therefore the only part of the host that can hand one module's sentence to
 * another. See `division.ts` for the split and `answers.ts` for what the server
 * used to say about it.
 *
 * ## The host is the one that says who sent it
 *
 * `from` is taken from the registry entry the call arrived on and never from
 * the payload — `emit` does not even accept a `from`, it is a parameter of the
 * bound emitter. A module that could name its own sender could post a line
 * saying "the tests passed" under the test runner's name, on a panel whose
 * whole job is to attribute. The protocol's essay on `eventSchema` is explicit
 * that `from` is the one field a receiver may attribute by, and it is only
 * worth that if no sender can touch it.
 *
 * The CONTENTS are not vouched for. The host checked that the payload fits the
 * format's own schema and nothing more; whether the tests really passed is the
 * sender's claim, and a receiver drawing it should say whose claim it is.
 */

/** The canvas an event happened on, as the wire spells it. */
export interface Kehikko {
  id: number
  name: string
}

/** What one framed module's conversation offers this bus. */
export interface Receiver {
  /** What its manifest says it consumes. Read on every emit, never cached here. */
  consumes: readonly string[]
  /** Post one `roadmap.event` into its frame. Not answered; see `Conversation`. */
  send(event: unknown): void
}

/**
 * What an emit came to.
 *
 * `ok: false` carries a sentence because the alternative — dropping quietly —
 * is the failure this whole file is against. A module whose events stop being
 * carried must be able to find out, in its own console, that they stopped and
 * why; that is the difference between a rate limit and a bug.
 */
export type Emitted =
  | { ok: true; delivered: number }
  | { ok: false; error: string }

/**
 * How fast one module may emit, and what happens when it goes faster.
 *
 * ## Why there is a limit at all
 *
 * Delivery is synchronous fan-out: one `emit` becomes one `postMessage` per
 * consumer, on the canvas's own main thread, in the middle of answering a
 * `roadmap.request`. A module in a loop — and the obvious loop is a module that
 * emits on every MCP call, wired to an agent that calls it in a loop — would
 * therefore not merely fill somebody's notification list; it would fill the
 * host's task queue, and a canvas that cannot get a frame in is a canvas that
 * has stopped repainting. The pane nobody is looking at takes the whole screen
 * down with it. That is not a hypothetical failure mode of postMessage; it is
 * what "the canvas froze" means every time it has been reported here.
 *
 * ## A bucket rather than a queue, and why nothing is buffered
 *
 * The tempting design is a queue: accept everything, drain it at a safe rate,
 * nobody loses anything. It is wrong for this message, and the protocol says
 * why in the essay on `eventSchema` — an event is not answered, has no
 * correlation id, and delivery is best-effort by design. A queue would make the
 * host the keeper of a history it has explicitly refused to keep, with the
 * added property that the events in it are stale by however long the queue is:
 * a notification panel drawing a five-minute-old backlog after a storm is
 * showing a person the past while calling it the present.
 *
 * So: a token bucket, and over-rate emits are REFUSED rather than buffered. The
 * sender is told, in a sentence, that this one was not carried and why. It is
 * the one place a module finds out — which is the whole point of refusing
 * rather than dropping, and is why the refusal names the rate rather than
 * saying "too many".
 *
 * A module that needs its history to survive a storm keeps it itself and says
 * so, which is exactly what the notifications module does.
 *
 * The numbers: `BURST` events available at once, refilled at `PER_SECOND`. A
 * burst is what a module legitimately does when an agent runs six tools in a
 * row; a sustained five a second is already far more than a person can read,
 * and a module wanting to say more than that per second is a module that should
 * be saying one thing about the batch.
 */
export const BURST = 20
export const PER_SECOND = 5

interface Bucket {
  /** Tokens left, fractional because the refill is continuous. */
  tokens: number
  /** When `tokens` was last true, as a millisecond clock reading. */
  at: number
  /** How many this module has been refused since it last got through. */
  refused: number
}

export class EventBus {
  private readonly receivers = new Map<string, Receiver>()
  private readonly buckets = new Map<string, Bucket>()

  /**
   * Injected so a test is a test.
   *
   * A rate limit whose tests had to sleep four real seconds to watch a bucket
   * refill is a rate limit that eventually gets an `it.skip` in front of it,
   * and this is the one behaviour here that must never stop being covered.
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * A framed module, present and listening.
   *
   * Called when a conversation is created and again for nothing else: joining
   * is about having a window to post into, not about being on the open canvas.
   * A module framed on another kehikko still hears — its page is loaded, its
   * conversation is live, and the event carries the kehikko it happened on so
   * the module can tell near from far itself. Withholding it here would make
   * "this kehikko" a rule the host imposed rather than a comparison the module
   * makes, which is the thing the protocol's `kehikko` field exists to avoid.
   */
  join(moduleId: string, receiver: Receiver): void {
    this.receivers.set(moduleId, receiver)
  }

  leave(moduleId: string): void {
    this.receivers.delete(moduleId)
    this.buckets.delete(moduleId)
  }

  /** Who would hear this format right now. For tests and for sentences. */
  consumersOf(extension: string): string[] {
    const heard: string[] = []
    for (const [id, receiver] of this.receivers) {
      if (receiver.consumes.includes(extension)) heard.push(id)
    }
    return heard
  }

  /**
   * One module's event, checked, and handed to everybody who consumes it.
   *
   * The two checks are the ones the server used to run and they were right: the
   * host must know the format before it will carry a payload, and it must
   * validate the payload against that format, because an event delivered
   * unvalidated is one every future consumer has to distrust. They moved here
   * with the delivery rather than being left behind, so that the thing that
   * checks and the thing that sends are the same thing and cannot drift apart.
   *
   * @param from     The sender, from the host's registry. Never from the payload.
   * @param kehikko  The canvas it happened on, or null if the host has none open.
   */
  emit(from: string, extension: string, payload: unknown, kehikko: Kehikko | null): Emitted {
    if (!known(extension)) {
      return {
        ok: false,
        error:
          'This host does not know that extension format, so it cannot check the payload and will not carry it. ' +
          'An event delivered unvalidated is one every consumer would have to distrust.',
      }
    }

    const format = schemaFor(extension)
    const checked = format?.safeParse(payload)
    if (!checked?.success) {
      const issue = checked?.error.issues[0]
      const where = issue?.path.length ? issue.path.join('.') : 'payload'
      return {
        ok: false,
        error: `The payload does not match that extension's format: ${where} — ${clip(issue?.message ?? 'malformed')}. It was not delivered.`,
      }
    }

    const allowed = this.spend(from)
    if (!allowed.ok) return allowed

    /*
     * Delivered to every consumer EXCEPT the sender, even when the sender's own
     * manifest consumes the format it emits.
     *
     * That combination is legitimate — a module can perfectly well both post
     * notifications and show them — and echoing one back to it is still wrong.
     * A module that receives its own event has to recognise and discard it, and
     * the only thing it has to recognise it BY is `from`, which is its own id;
     * so every such module would carry the same three lines of "is this me",
     * and the first one to get them wrong draws each of its own sentences
     * twice. Worse, a module that reacts to what it consumes by emitting is
     * then a loop with the host in the middle of it, and the rate limit above
     * is the only thing that would stop it — a bound doing the work a rule
     * should have done. So the rule: a sender is not an audience.
     */
    const message = {
      type: MESSAGE.EVENT,
      protocol: PROTOCOL,
      extension,
      /* The PARSED payload, not the one that arrived: the format's schema fills
         its own defaults, so a receiver reading `level` finds `info` there
         rather than nothing because the sender left it off. */
      payload: checked.data,
      from,
      /* The host's clock, not the sender's, and stated once here so that every
         consumer of one event agrees on when it happened. A receiver ordering
         by arrival would be ordering by its own scheduler. */
      at: new Date().toISOString(),
      kehikko,
    }

    let delivered = 0
    for (const [id, receiver] of this.receivers) {
      if (id === from) continue
      if (!receiver.consumes.includes(extension)) continue
      /* One bad receiver must not stop the rest. A frame that has navigated
         away throws on post, and that is its own problem rather than the
         sender's — the sender is told how many heard it either way. */
      try {
        receiver.send(message)
        delivered += 1
      } catch {
        /* Nothing to report to: there is no correlation id on an event and
           nobody is waiting. The count is the report. */
      }
    }

    return { ok: true, delivered }
  }

  /**
   * Take a token, or explain why there is not one.
   *
   * The refusal counts what has been refused SINCE THE LAST ONE GOT THROUGH,
   * because that number is the useful one: "this is the 340th event you have
   * emitted in the last minute" tells an author they are in a loop, where "rate
   * limited" tells them to add a retry.
   */
  private spend(from: string): { ok: true; delivered: number } | { ok: false; error: string } {
    const at = this.now()
    const bucket = this.buckets.get(from) ?? { tokens: BURST, at, refused: 0 }
    /* Continuous refill from elapsed time rather than a timer. A timer per
       module is a timer per module to clear, and the arithmetic is exact. */
    const elapsed = Math.max(0, at - bucket.at) / 1000
    bucket.tokens = Math.min(BURST, bucket.tokens + elapsed * PER_SECOND)
    bucket.at = at

    if (bucket.tokens < 1) {
      bucket.refused += 1
      this.buckets.set(from, bucket)
      return {
        ok: false,
        error:
          `This canvas carries at most ${PER_SECOND} events a second from one module, in bursts of ${BURST}. ` +
          `This one was NOT delivered, and neither were the ${bucket.refused - 1} before it since the last that was. ` +
          'Nothing is queued — an event held back until the storm passed would arrive describing the past. ' +
          'Say less, or say one thing about the batch.',
      }
    }

    bucket.tokens -= 1
    bucket.refused = 0
    this.buckets.set(from, bucket)
    return { ok: true, delivered: 0 }
  }
}

/** Keep a sentence inside the bound the protocol puts on a refusal. */
function clip(sentence: string): string {
  const room = LIMITS.REASON - 160
  return sentence.length > room ? `${sentence.slice(0, room)}…` : sentence
}
