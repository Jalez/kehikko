import {
  clampHeight,
  LIMITS,
  looksLikeWireMessage,
  MESSAGE,
  moduleMessageSchema,
  PROTOCOL,
  type ModuleContext,
} from 'roadmap-module-protocol'

/**
 * One conversation with one frame.
 *
 * The host greets first, on every load; the module answers; the host sends
 * context and sends it again whenever it changes; the module asks questions and
 * the host answers exactly one per id. That is the whole arrangement, and this
 * class is the whole of the host's side of it.
 *
 * ## The identity is the window, not the origin
 *
 * This is the single most important line in the file and the easiest to get
 * wrong, because checking `event.origin` is what every tutorial about
 * `postMessage` tells you to do and it is the right advice about a different
 * situation.
 *
 * A module's page is framed with `sandbox` and — unless it asked for storage —
 * without `allow-same-origin`. That puts the document on an OPAQUE origin: it
 * has no origin string of its own. Everything it posts arrives with
 * `event.origin === "null"`, and "null" is not a name. Every opaque frame in
 * every tab in the browser shares it, so a host that compared origins would be
 * accepting messages from any opaque frame anywhere as if they were this
 * module's — and there is no `targetOrigin` string that matches an opaque
 * origin either, so the host must post with `'*'`.
 *
 * `'*'` sounds alarming and is not, because of what it means: the message goes
 * to THIS window handle and nowhere else. `postMessage` on a window reference
 * is addressed to that window; `targetOrigin` is a further condition on top,
 * not the address. `'*'` says "whatever origin this frame turns out to be on",
 * and the frame in question is one the host created, pointed at a URL it chose,
 * and holds the only handle to.
 *
 * So the check on the way in is `event.source === frame.contentWindow`. That
 * handle cannot be forged: no script in the page and no script in the frame can
 * make a message appear to come from a window it did not come from. When a
 * module DID ask for storage it has a real origin, and then the origin is
 * checked as well — as a second condition, never as the first.
 *
 * ## Silence is counted from the greeting
 *
 * A module that never answers must be reported as silent, and the wait must
 * start when the host said hello rather than when the frame was mounted. A
 * module cannot be silent in answer to a word nobody has said yet, and a host
 * that starts its clock at mount is a host that calls a slow-loading module
 * silent on a slow machine — which is the one failure mode that would teach a
 * person to ignore the word.
 */

/** What the host does with a question, wherever it is answered. */
export type Answer =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'unknown-module' | 'unknown-method' | 'failed'; error: string }

export type Ask = (method: string, params: unknown) => Promise<Answer>

/**
 * What a conversation reports back to the canvas.
 *
 * `silent` here is the client's own finding and is a different observation from
 * the server's: the server says silent when nothing served a manifest, and this
 * says silent when a page loaded, was greeted, and did not answer. Both are
 * true and both are the same word on screen, because the person's next move is
 * the same in either case — go and look at the program.
 */
export interface ConversationWatcher {
  ready(moduleProtocol: number): void
  silent(line: string): void
  /** Something the module did that is worth a line but is not a condition. */
  fault(line: string): void
  height(px: number): void
}

/** How long a module has to answer a greeting before it is reported silent. */
export const READY_TIMEOUT_MS = 4000

/**
 * How long the host waits for `roadmap.went`.
 *
 * The protocol is explicit that this timeout must mean the same thing as
 * `found: false`, and the reason is worth restating: `goto` is the only message
 * where the host depends on somebody else's program to reply, and a host
 * without a deadline here is a host where one unresponsive module can hang a
 * reference nobody can press. Shorter than the ready timeout, because this one
 * runs while a person is waiting for something to happen.
 */
export const WENT_TIMEOUT_MS = 1200

interface Pending {
  resolve(answer: { found: boolean; why: string }): void
  timer: ReturnType<typeof setTimeout>
}

export class Conversation {
  private readonly pending = new Map<string, Pending>()
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private greeted = false
  private answered = false
  private closed = false
  private nextGoto = 1

  /**
   * @param frame       The element the host mounted. The identity, and the only one.
   * @param moduleId    What the registration calls it. Used in sentences and in calls.
   * @param origin      The module's origin when it has one (it asked for storage), else null.
   * @param ask         How a question is answered. Injected so the wire can be
   *                    tested without a server and so the canvas can answer the
   *                    one method that is about the canvas.
   */
  readonly session: string
  /**
   * The name for a sentence, which is not the id for a lookup.
   *
   * A pane headed "Mute" whose sentence underneath says `example.mute` is one
   * program named two ways in two inches, and a person reading it has to work
   * out that they are the same thing. The id stays the identity everywhere it
   * is a key; this is only ever printed.
   */
  private readonly name: string
  private readonly readyTimeoutMs: number
  private readonly wentTimeoutMs: number

  constructor(
    private readonly frame: Pick<HTMLIFrameElement, 'contentWindow'>,
    readonly moduleId: string,
    private readonly origin: string | null,
    private readonly ask: Ask,
    private readonly watcher: ConversationWatcher,
    /**
     * The two deadlines, overridable — and only so that a test can be a test.
     * A test that had to wait four real seconds to find out that silence is
     * reported as silence is a test somebody eventually deletes, and this is
     * the one behaviour in the file that must never stop being covered.
     */
    options: {
      /** What the module calls itself, for the sentences a person reads. */
      name?: string
      session?: string
      readyTimeoutMs?: number
      wentTimeoutMs?: number
    } = {},
  ) {
    this.name = options.name ?? moduleId
    this.session = options.session ?? newSession()
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.wentTimeoutMs = options.wentTimeoutMs ?? WENT_TIMEOUT_MS
  }

  /**
   * Start listening, and say hello.
   *
   * Called on every frame LOAD rather than once: a frame that reloaded itself
   * has forgotten the conversation, and greeting it again is cheaper than
   * either side wondering which of them is confused.
   */
  greet(context: ModuleContext): void {
    if (this.closed) return
    this.greeted = true
    this.answered = false

    this.post({
      type: MESSAGE.HELLO,
      protocol: PROTOCOL,
      session: this.session,
      context,
    })

    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = setTimeout(() => {
      if (this.answered || this.closed) return
      this.watcher.silent(
        `${this.name} loaded its page and did not answer the host's greeting. The program is running at its address; the page inside this pane is not speaking.`,
      )
    }, this.readyTimeoutMs)
  }

  /** Which epic the canvas is about now. Sent on every change. */
  sendContext(context: ModuleContext): void {
    if (!this.greeted || this.closed) return
    this.post({ type: MESSAGE.CONTEXT, protocol: PROTOCOL, ...context })
  }

  /**
   * Ask the module to walk to a reference, and wait — briefly — to hear whether
   * it found anything.
   *
   * Resolves `found: false` on timeout, and that is not a fallback bolted on:
   * the protocol says the timeout must MEAN `found: false`, so that a caller
   * has exactly two cases to handle rather than three, and so that a module
   * which never answers cannot leave a reference in a third state where nothing
   * happens and nobody is told.
   */
  goto(target: { ref?: string; step?: number; epic?: string }): Promise<{ found: boolean; why: string }> {
    if (!this.greeted || this.closed) {
      return Promise.resolve({ found: false, why: 'the module has not been greeted' })
    }
    const id = `g${this.nextGoto++}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ found: false, why: `${this.name} did not answer the walk in time` })
      }, this.wentTimeoutMs)
      this.pending.set(id, { resolve, timer })
      this.post({ type: MESSAGE.GOTO, id, ...target })
    })
  }

  /**
   * One message off the window. The canvas subscribes once and routes by frame.
   *
   * Returns whether this conversation took the message, so a caller holding
   * several conversations can stop at the first that did.
   */
  receive(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>): boolean {
    if (this.closed) return false

    /* The identity check, and it is first because everything after it is a
       decision about a message whose sender has already been established. */
    if (!this.frame.contentWindow || event.source !== this.frame.contentWindow) return false

    /* The second check, and only when there is something to check. A module
       that asked for storage runs on its own origin and can be addressed by it;
       one that did not has no origin, and `"null"` is what every opaque frame
       in the browser reports. Comparing against `"null"` would be a check that
       passes for anything, which is worse than no check because it looks like
       one. */
    if (this.origin !== null && event.origin !== this.origin) return false

    if (!looksLikeWireMessage(event.data)) return false

    const parsed = moduleMessageSchema.safeParse(event.data)
    if (!parsed.success) {
      /* A message with the right prefix and the wrong shape. Reported, because
         the alternative is a module author whose call vanishes with no trace
         anywhere — and reported without echoing the message, which is a
         document a stranger wrote. */
      this.watcher.fault(
        `${this.name} sent a ${String((event.data as { type: string }).type).slice(0, LIMITS.METHOD)} the host could not read.`,
      )
      return true
    }

    const message = parsed.data

    switch (message.type) {
    case MESSAGE.READY: {
      this.answered = true
      if (this.readyTimer) clearTimeout(this.readyTimer)
      /* The id in `ready` is the module's own claim about its name. It is not
         how the host identifies it — that is the frame — so a mismatch is a
         fault to report and not an impersonation to defend against. Treating
         it as security would teach somebody to lean on a check that is not
         one. */
      if (message.id !== this.moduleId) {
        this.watcher.fault(
          `The page framed as ${this.moduleId} answered as ${message.id}. The host is talking to the frame it mounted; the name is wrong somewhere.`,
        )
      }
      this.watcher.ready(message.protocol)
      return true
    }

    case MESSAGE.REQUEST: {
      /* Answered asynchronously, and the id is carried through so that exactly
         one response goes back for exactly one question. Nothing is queued and
         nothing is deduplicated: a module that asks twice gets two answers,
         which is what it asked for. */
      void this.ask(message.method, message.params).then((answer) => {
        if (this.closed) return
        this.post(
          answer.ok
            ? { type: MESSAGE.RESPONSE, id: message.id, ok: true, data: answer.data }
            : {
              type: MESSAGE.RESPONSE,
              id: message.id,
              ok: false,
              reason: answer.reason,
              error: answer.error,
            },
        )
      })
      return true
    }

    case MESSAGE.RESIZE: {
      /* The host runs its own copy of the arithmetic over the raw value, which
         is what the protocol package says to do and why `clampHeight` is
         offered as a prediction rather than as the check. The schema has
         already refused a non-finite height; the clamp is what keeps a module
         from being two pixels tall or taller than the screen. */
      this.watcher.height(clampHeight(message.height))
      return true
    }

    case MESSAGE.WENT: {
      const waiting = this.pending.get(message.id)
      if (!waiting) return true
      clearTimeout(waiting.timer)
      this.pending.delete(message.id)
      waiting.resolve({ found: message.found, why: message.why })
      return true
    }

    default:
      return true
    }
  }

  /** Stop. Every timer cleared, every promise settled rather than dropped. */
  close(): void {
    this.closed = true
    if (this.readyTimer) clearTimeout(this.readyTimer)
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.resolve({ found: false, why: 'the frame was taken off the canvas' })
    }
    this.pending.clear()
  }

  private post(message: unknown): void {
    const target = this.frame.contentWindow
    if (!target) return
    /* See the essay above: `'*'` is the only address an opaque frame has, and
       the frame handle is the address that matters. */
    target.postMessage(message, this.origin ?? '*')
  }
}

/**
 * A name for one conversation with one frame.
 *
 * Not a credential, and it must never become one. A module holds no token; every
 * question it asks is decided by the host out of the host's own registry, and a
 * session id that unlocked anything would be a secret sitting in a frame that
 * any script in that frame can read.
 */
export function newSession(): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `s${Date.now()}-${Math.random().toString(36).slice(2)}`
  return raw.slice(0, LIMITS.SESSION)
}
