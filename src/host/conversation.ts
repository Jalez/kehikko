import {
  clampHeight,
  FOOTER_KINDS,
  HOLD_COVER_MS,
  HOST_MESSAGES,
  LOADING_COVER_AFTER_MS,
  LIMITS,
  looksLikeWireMessage,
  MESSAGE,
  MODULE_MESSAGES,
  moduleMessageSchema,
  PROTOCOL,
  type Build,
  type FileDrag,
  type PagePoint,
  type FilterGroup,
  type FooterItem,
  type HeaderItem,
  type ModuleContext,
  type PressValue,
} from 'kehikot-module-protocol'
import { pressFreshFor } from './gesture.ts'
import { CARRIES } from './carry.ts'
import { fitContext } from './fitContext.ts'

/**
 * Every message type this host's build of the protocol names, in either
 * direction. A `kehikot.` type that is not here was added by a LATER protocol
 * than this host was built on — see `receive`.
 */
const NAMED = new Set<string>([...HOST_MESSAGES, ...MODULE_MESSAGES])

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
  | {
      ok: false
      reason: 'unknown-module' | 'unknown-method' | 'failed'
      error: string
      /** Protocol 2.22.0: the method is newer than this host (`declinedFields`). Posted as it is. */
      declined?: 'host-too-old'
    }

/**
 * `how` (protocol 2.50.0): what only the moment of arrival can say — whether
 * the person's press was fresh when the request came (`pressFreshFor`). Read by
 * `messages.say` and `view.expand`.
 */
export type Ask = (method: string, params: unknown, how?: { pressed: boolean }) => Promise<Answer>

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
  /**
   * `build` is what served the page, when it says: see `isStale` in `standing.ts`.
   * `hold` (protocol 2.70.0): the page asked for the cover to stay up until it is
   * drawn; `drawn` follows, when it says so or `holdCoverMs` passes.
   */
  ready(moduleProtocol: number, build?: Build | null, hold?: boolean): void
  /**
   * The page that answered with `hold: true` is drawn (`kehikot.drawn`), or the
   * host stopped waiting for it (`holdCoverMs`): take the cover off. Called once
   * per held greeting, never for a `ready` that did not hold.
   */
  drawn?(): void
  /**
   * Protocol 2.84.0: cover the page, saying `label` (the module's own words, or
   * `null` for the host's), until `drawn`. Called inside a held greeting with the
   * words `ready.label` or `kehikot.loading` gave it; and after a context, when
   * the page said `kehikot.loading` and did not say `kehikot.drawn` within
   * `loadingAfterMs` — a quick redraw is never covered. `drawn` ends it.
   */
  loading?(label: string | null): void
  /**
   * `more` (protocol 2.59.0): the first lines of the stack of the error the
   * page said it failed with (`kehikot.page.error`), for "Show details".
   */
  silent(line: string, more?: string): void
  /** Something the module did that is worth a line but is not a condition. */
  fault(line: string): void
  height(px: number): void
  /**
   * What this module says it can be narrowed by, right now.
   *
   * The whole offer every time, replacing whatever was last said — including an
   * empty one, which is a module WITHDRAWING the control rather than a module
   * saying nothing. A merge could never take a group away, so a module that
   * stopped offering something would leave a control behind that a person could
   * press and nothing would answer.
   *
   * Reported like `height` rather than answered like a request, because it is
   * the same kind of thing: a module saying something about itself that the
   * host may act on, with no reply and nothing waiting on it.
   */
  filters(groups: FilterGroup[]): void
  /**
   * What this module says can be cleared of what it is showing, right now.
   *
   * A label in the module's own words, or `null` — which is a module saying
   * there is nothing on screen to clear, and is the reason the host takes the
   * control away rather than leaving a button that deletes nothing. Reported
   * like `filters` and `height`, with no reply and nothing waiting on it.
   *
   * The host never learns what is behind the label and never asks. See
   * `sendClear` for the other half.
   */
  clearable(label: string | null): void
  /**
   * What this module says about being refreshed: whether it can be, when it
   * last was, and whether it is reading right now.
   *
   * Reported like `filters` and `clearable`, with no reply and nothing waiting
   * on it. The middle field is the one that could not have come from anywhere
   * else: this host knows when it ASKED, and when it asked is not when the data
   * is from — the module may have answered out of a cache, the read may have
   * failed over a reading it is still showing, or it may have refreshed itself
   * for a reason nothing here can see. A freshness line that can be wrong is
   * worse than no freshness line, so the host prints what it was told and never
   * a guess of its own.
   *
   * `null` for `at` is a real answer meaning "I cannot say", and it is not the
   * same as `can: false`, which is the withdrawal. See `sendRefresh` for the
   * other half.
   */
  refreshable(state: { can: boolean; at: string | null; busy: boolean }): void
  /**
   * What this module declares for its container's menus, right now
   * (`kehikot.header`, protocol 1.1.0): its view switches, toggles, jumps and
   * runs.
   *
   * The whole list every time, replacing the last — `[]` takes the module's
   * menus away — and the module owns all the state in it: which option a
   * switch is on, whether a run is busy. The host holds the latest and
   * remembers nothing else. Reported like `filters`, with no reply.
   */
  header(items: HeaderItem[]): void
  /**
   * What this module declares for its container's footer, right now
   * (`kehikot.footer`, protocol 2.38.0): status text, meters, and the
   * header's kinds of item. Whole, replacing the last, like `header`; `[]`
   * takes the footer away.
   */
  footer?(items: FooterItem[]): void
  /**
   * The person pressed, or let go, inside this module's page
   * (`kehikot.pointer`, protocol 2.49.0): `at` is the page's own clock, for
   * the length of a press. How a container's rows are revealed on a click or
   * a held press inside its page (`host/rows.ts`).
   */
  pointer?(phase: 'down' | 'up' | 'cancel', at: number): void
  /**
   * Load the frame's page again, once, before it is reported silent: asked when
   * the greeting went unanswered and the host's server says the module answers
   * now. A page that loaded before its module listened was given the proxy's
   * refusal, and nothing else ever loads it again. Absent: never retried.
   */
  retry?(): void
  /**
   * Read the modules again: the host's server says the frame holds a page from an address the
   * module no longer answers at (`moved` in `server/quiet.ts`) — it was started again elsewhere
   * since. A fresh reading gives the frame the new address. Absent: the sentence is said instead.
   */
  behind?(): void
  /**
   * What a search came to (`kehikot.find.result`, protocol 2.69.0): the count,
   * or `unsupported`, for the `kehikot.find` whose id it carries. See `host/find.ts`.
   */
  findResult?(result: { id: string; total: number; current: number; unsupported: boolean }): void
  /**
   * The person pressed ⌘F (or ⌘G, `step`) inside this module's page
   * (`kehikot.find.open`, protocol 2.69.0): open the find bar for its container.
   */
  findOpen?(open: { query?: string; step?: 'next' | 'prev' }): void
  /**
   * The page is dragging a file of the project, or let go of it (`kehikot.drag`, protocol 2.94.0):
   * where, in its own coordinates, and whether anything took it. See `host/drops.ts`.
   */
  drag?(drag: { phase: 'start' | 'end'; file: FileDrag; at?: PagePoint; dropped: boolean }): void
}

/**
 * How long a page has to answer a greeting before the host LOOKS — asks its server what it can
 * see (`server/quiet.ts`) — and before a page loaded ahead of its module is loaded once again.
 * Not a verdict: a page that is only slow is not complained about at this point.
 */
export const READY_TIMEOUT_MS = 4000

/**
 * How long a page whose module is up, and whose page and scripts all load, may stay quiet before
 * the container says so. The last resort, not the judgement: a heavy page on a machine that is
 * starting fifteen others is slow, not broken, and saying it was broken — then starting it again —
 * made the start slower still. Every fact found before this (the module not running, a page that
 * failed and said why, a script that does not load, a page from before a restart) is said at once.
 */
export const QUIET_FOR_MS = 60_000

/** Said when a page will not answer this window (`kehikot.refused`, protocol 2.93.0). The origins are text. */
export function refusedLine(name: string, origin: string, allowed: readonly string[]): string {
  const list = allowed.filter((one) => one.length > 0)
  return (
    `${name} refused this window: it was started for ${list.length ? list.join(', ') : 'other windows'}, and this window is ${origin || 'one with no origin'}. `
    + 'Restarting it gives it this window’s address.'
  )
}

/** Said when a page whose module is up has said nothing for `QUIET_FOR_MS`. */
export function quietForLine(name: string, ms: number, found?: string | null): string {
  return (
    `${name} loaded its page and has said nothing for ${Math.round(ms / 1000)} seconds. `
    + (found ? `${found} ` : '')
    + 'Reload the page; Kehikot does not start it again for this, because the program is running.'
  )
}

/**
 * How long the host waits for `kehikot.went`.
 *
 * The protocol is explicit that this timeout must mean the same thing as
 * `found: false`, and the reason is worth restating: `goto` is the only message
 * where the host depends on somebody else's program to reply, and a host
 * without a deadline here is a host where one unresponsive module can hang a
 * reference nobody can press. Shorter than the ready timeout, because this one
 * runs while a person is waiting for something to happen.
 */
export const WENT_TIMEOUT_MS = 1200

/**
 * What a walk is answered with when the frame has not been greeted yet.
 *
 * A constant because one caller has to recognise it: a walk sent to a module
 * that was put on the canvas a moment ago is not a walk that found nothing,
 * it is a walk to try again when the page has loaded.
 */
export const NOT_GREETED = 'the module has not been greeted'

/**
 * How long the host waits for `kehikot.pressed`.
 *
 * Longer than the client's own backstop, and that order is the point. The
 * protocol's client answers every press itself — `ok: false` after
 * `PRESS_BACKSTOP_MS`, two seconds, when the module's listener has not said —
 * so a module built on it always answers inside two seconds. A host that gave
 * up at the same moment would race that answer and sometimes report "did not
 * answer" for a press the module was just then refusing with a reason. What
 * is left for this deadline is a page that is not listening at all: built
 * before 1.1.0, or hung.
 */
export const PRESSED_TIMEOUT_MS = 3000
/** How long an opened item waits for a page that has not answered its greeting yet (`sendOpened`). */
export const OPENED_HOLD_MS = 20_000

interface Pending {
  resolve(answer: { found: boolean; why: string }): void
  timer: ReturnType<typeof setTimeout>
}

interface PendingPress {
  resolve(answer: { ok: boolean; why: string }): void
  timer: ReturnType<typeof setTimeout>
}

export class Conversation {
  private readonly pending = new Map<string, Pending>()
  private readonly presses = new Map<string, PendingPress>()
  private nextPress = 1
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  /* The page answered with `hold: true` and has not said it is drawn (protocol 2.70.0). */
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  /* Protocol 2.84.0: the page said `kehikot.loading` after a context. `loadShow`
     puts the cover up if `kehikot.drawn` is late, `loadEnd` stops waiting for
     it; `loadShown` is whether the cover went up. */
  private loadShow: ReturnType<typeof setTimeout> | null = null
  private loadEnd: ReturnType<typeof setTimeout> | null = null
  private loadShown = false
  private loadLabel: string | null = null
  private greeted = false
  /** An opened item waiting for the page to answer its greeting (`sendOpened`). */
  private openedLater: { item: string; at: number } | null = null
  /* What the host's rows cover of this frame now, for a module that says `reveal: 'over'`, and what the page was last told. */
  private covered = { top: 0, bottom: 0 }
  private coveredTold = '0,0'
  /* Whether the host has this frame's page on screen now (`kehikot.visible`), and what the page was last told; `null` after a greeting. */
  private visible = true
  private visibleTold: boolean | null = null
  private answered = false
  /* Whether this frame's page was loaded again for an unanswered greeting (`retry`); cleared by an answer. */
  private retried = false
  /* When this frame's page was first greeted and has not answered since: what `QUIET_FOR_MS` counts from. */
  private quietSince: number | null = null
  /* Whether the greeting's first deadline has passed unanswered: a failure the page reports after it is said at once. */
  private looked = false
  /** Whether the greeting's deadline has passed with no answer, so the container says so now. */
  private silenced = false
  /**
   * What the page said it failed with since the greeting (protocol 2.59.0,
   * `kehikot.page.error`), the first one: what failed first is what the rest
   * followed from. Cleared by the next greeting; said only while unanswered.
   */
  private failure: { message: string; where: string; stack: string } | null = null
  private closed = false
  private nextGoto = 1
  private nextFind = 1

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
   * A container headed "Mute" whose sentence underneath says `example.mute` is one
   * program named two ways in two inches, and a person reading it has to work
   * out that they are the same thing. The id stays the identity everywhere it
   * is a key; this is only ever printed.
   */
  private readonly name: string
  /** The address the frame was given (`server/quiet.ts` checks that one), or null when not said. */
  private readonly entry: string | null
  private readonly readyTimeoutMs: number
  private readonly quietForMs: number
  private readonly holdCoverMs: number
  private readonly loadingAfterMs: number
  private readonly wentTimeoutMs: number
  private readonly pressedTimeoutMs: number
  private readonly pressed: () => boolean

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
      /** The address the frame was given, for the server to check when it goes quiet (`server/quiet.ts`). */
      entry?: string
      session?: string
      readyTimeoutMs?: number
      /** How long a page whose module is up may stay quiet before it is said (`QUIET_FOR_MS`). */
      quietForMs?: number
      /** How long a cover held by `ready { hold: true }` waits for `kehikot.drawn` (`HOLD_COVER_MS`). */
      holdCoverMs?: number
      /** How long after `kehikot.loading` the cover waits for `kehikot.drawn` before it goes up (`LOADING_COVER_AFTER_MS`). */
      loadingAfterMs?: number
      wentTimeoutMs?: number
      pressedTimeoutMs?: number
      /** Whether the person's press into this frame is fresh now (`pressFreshFor`); replaced in tests. */
      pressed?: () => boolean
    } = {},
  ) {
    this.pressed = options.pressed ?? (() => pressFreshFor(moduleId))
    this.name = options.name ?? moduleId
    this.entry = options.entry ?? null
    this.session = options.session ?? newSession()
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.quietForMs = options.quietForMs ?? QUIET_FOR_MS
    this.holdCoverMs = options.holdCoverMs ?? HOLD_COVER_MS
    this.loadingAfterMs = options.loadingAfterMs ?? LOADING_COVER_AFTER_MS
    this.wentTimeoutMs = options.wentTimeoutMs ?? WENT_TIMEOUT_MS
    this.pressedTimeoutMs = options.pressedTimeoutMs ?? PRESSED_TIMEOUT_MS
  }

  /**
   * Start listening, and say hello.
   *
   * Called on every frame LOAD rather than once: a frame that reloaded itself
   * has forgotten the conversation, and greeting it again is cheaper than
   * either side wondering which of them is confused.
   */
  greet(context: ModuleContext, state: string | null = null, answers: readonly string[] | null = null): void {
    if (this.closed) return
    this.greeted = true
    this.answered = false
    this.letHold()
    this.silenced = false
    this.looked = false
    this.failure = null

    this.post({
      type: MESSAGE.HELLO,
      protocol: PROTOCOL,
      session: this.session,
      /* Within the protocol's limits, or a page built before 2.93.0 drops the greeting unread and
         is called silent a minute later (`fitContext`). */
      context: this.fitted(context),
      /*
       * Whatever this module last asked the host to keep, handed back before it
       * has drawn anything. The host has not read it and does not know what is
       * in it — see `state.set` in the protocol package.
       *
       * In the greeting rather than fetched afterwards, because a module that
       * had to ask would render its defaults first and correct them, which is
       * the same visible-flicker failure as a theme applied after first paint.
       */
      state,
      /* Protocol 1.4.0. The methods this host will answer for THIS module,
         or nothing at all when it has not read the module's manifest: absent
         means "unknown" to the module, and a wrong list would be a claim. A
         module built on 1.3.0 or earlier has these two keys stripped by its
         own schema, so they are safe to send to every module. */
      ...(answers ? { answers: [...answers] } : {}),
      /* Every container this host frames has its header drawn by it
         (`HeaderMenus`), so the module need not draw a "⋯" of its own. */
      header: true,
      /* Protocol 2.38.0: and its declared footer, as one row at the bottom
         of the container (`FooterBar`). A module draws its own only when
         this is not said. */
      footer: true,
      /* Protocol 2.40.0: the acts this host carries out for a run in the person's click (`host/carry.ts`). */
      carries: [...CARRIES],
      /* Protocol 2.46.0: the footer kinds `FooterBar` draws, a field among them. A host that names
         none draws the 2.38.0 kinds, so a module sends a field only to a host that says so. */
      footerKinds: [...FOOTER_KINDS],
      /* Protocol 2.49.0: tell me when the person presses inside the page, so a container's rows can be
         revealed on a click or a held press in it (`host/rows.ts`). An older module sends nothing. */
      pointer: true,
      /* Protocol 2.69.0: this host draws a find bar over the container (`host/find.ts`), so the
         page hears ⌘F and answers `kehikot.find`. An older module strips it and searches nothing. */
      find: true,
    })

    if (this.quietSince === null) this.quietSince = Date.now()
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = setTimeout(() => this.deadline(), this.readyTimeoutMs)
  }

  /**
   * The greeting went unanswered for `readyTimeoutMs`: look, and say only what is found.
   *
   * ## What this used to do, and why it stopped
   *
   * It said "did not answer the host's greeting" at four seconds, then improved the sentence
   * with what the server found — which, when everything loaded, was that the page was "choosing
   * not to answer" and the fault was the module's. On a cold start the machine is starting a
   * dozen modules at once and a heavy page is simply slow; on a restart the page in the frame
   * was the OLD process's. Both were reported as a broken module, a person pressed Restart, and
   * the restart made the next start slower. Slow is not broken, so a page that is only slow is
   * not complained about until `QUIET_FOR_MS`; everything that is a fact is said at once.
   */
  private deadline(): void {
    if (this.answered || this.closed) return
    this.looked = true
    /* The page said why (protocol 2.59.0): that, rather than a guess. */
    if (this.failure) {
      this.silenced = true
      this.sayFailure()
      return
    }
    void this.judge()
  }

  private async judge(): Promise<void> {
    const said = await this.quiet()
    /* It answered while the host was asking, or the container went away: the sentence below
       would be describing a moment that has passed. */
    if (this.answered || this.closed) return
    if (this.failure) {
      this.silenced = true
      this.sayFailure()
      return
    }
    /* The frame holds a page from before the module was started again elsewhere: read the
       modules again and the frame is given the address it answers at now. */
    if (said?.kind === 'moved') {
      if (this.watcher.behind) {
        this.watcher.behind()
        this.again(this.quietForMs)
        return
      }
      this.say(said.line)
      return
    }
    /* Not running: no page to wait for. */
    if (said?.kind === 'gone') {
      this.say(said.line)
      return
    }
    /* Once: a page loaded before its module listened was given a refusal, and nothing else ever
       loads it again. The server says the module answers now, so the page is loaded again. */
    if (!this.retried && said && this.watcher.retry) {
      this.retried = true
      this.silenced = false
      this.watcher.retry()
      return
    }
    const waited = Date.now() - (this.quietSince ?? Date.now())
    /* Everything it needs loads (or the server could not say): as far as anything can tell, the
       page is slow. Not said until it has been quiet for `QUIET_FOR_MS`. */
    if ((said === null || said.kind === 'module') && waited < this.quietForMs) {
      this.again(this.quietForMs - waited)
      return
    }
    this.say(said === null || said.kind === 'module' ? quietForLine(this.name, this.quietForMs, said?.line ?? null) : said.line)
  }

  /** Look again after `ms`, unless an answer or a new greeting comes first. */
  private again(ms: number): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = setTimeout(() => this.deadline(), Math.max(1, ms))
  }

  private say(line: string): void {
    this.silenced = true
    this.watcher.silent(line)
  }

  /**
   * What the host's server makes of this quiet module, or null when it did not
   * say. Never throws: a host that threw while explaining a quiet module would
   * be a worse failure than the one being explained. `framed` is the address
   * the frame was given; the server holds it to the module's own addresses.
   *
   * The page cannot look for itself. A module is framed cross-origin and sets
   * no CORS headers on purpose, so `fetch` from here to a module's origin is
   * refused before it leaves. The server has no such limit and already fetches
   * every module's manifest on every sweep, so it does the looking.
   */
  private async quiet(): Promise<{ kind: string; line: string } | null> {
    try {
      const framed = this.entry ? `&framed=${encodeURIComponent(this.entry)}` : ''
      const response = await fetch(`/host/quiet?id=${encodeURIComponent(this.moduleId)}${framed}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return null
      const said = (await response.json()) as { ok?: boolean; kind?: unknown; line?: unknown }
      if (!said?.ok || typeof said.line !== 'string' || said.line.length === 0) return null
      return { kind: typeof said.kind === 'string' ? said.kind : '', line: said.line }
    } catch {
      return null
    }
  }

  /**
   * The container's sentence for a page that said why it failed: the
   * module's name, then the error as the page put it, and where it was thrown
   * when the stack says. The module's words are text in a sentence; nothing
   * here reads them as anything else.
   */
  private sayFailure(): void {
    const failure = this.failure
    if (!failure) return
    const at = whereThrown(failure.stack, failure.message)
    this.watcher.silent(
      `${possessive(this.name)} page failed to start: ${failure.message}${at ? ` (${at})` : ''}`,
      failure.stack || undefined,
    )
  }

  /** Which epic the canvas is about now. Sent on every change. */
  sendContext(context: ModuleContext): void {
    if (!this.greeted || this.closed) return
    this.post({ type: MESSAGE.CONTEXT, protocol: PROTOCOL, ...this.fitted(context) })
  }

  /** What `fitContext` cut last, so the same cut is said once and not on every context. */
  private cutSaid = ''

  /** The context as every page can read it (`fitContext`), and a word in the console when something had to be cut. */
  private fitted(context: ModuleContext): ModuleContext {
    const { context: fitted, cut } = fitContext(context)
    const said = cut.join(', ')
    if (said && said !== this.cutSaid) {
      console.warn(`Kehikot: what ${this.name} is told was over the protocol's limits and was cut to fit: ${said}.`)
    }
    this.cutSaid = said
    return fitted
  }

  /**
   * Hand this frame one event another module emitted.
   *
   * ## Not answered, and therefore not correlated
   *
   * Every other message this class sends either expects a reply or IS one, and
   * each carries an id to match the two ends up. This one carries none, and the
   * absence is the design rather than an omission: the protocol's essay on
   * `eventSchema` is explicit that a module which ignores every event it is
   * sent is a conforming module. So there is nothing to wait for, nothing to
   * time out, and nothing in `pending` — which also means a canvas holding a
   * frame that has quietly stopped listening is not accumulating promises about
   * it. A host that waited for acknowledgement here could be hung by a container
   * nobody is looking at.
   *
   * ## Only after the greeting, and that is where events are lost
   *
   * Guarded on `greeted` like `sendContext`, and unlike the context there is no
   * second chance: a context that arrives too early is carried in the greeting
   * instead, and an event that arrives before the greeting is simply gone. That
   * is best-effort delivery meaning what it says, and it is why the consuming
   * module keeps its own store — see the protocol's note that a receiver
   * needing history should keep it rather than expect the wire to hold it.
   *
   * The message is composed by `events.ts` rather than here, because the fields
   * a receiver may trust — `from`, `at`, `kehikko` — are the host's own words
   * and belong where the host decides them, not where it posts them.
   */
  sendEvent(event: unknown): void {
    if (!this.greeted || this.closed) return
    this.post(event)
  }

  /**
   * Tell this module to clear what it is showing. The only destructive thing
   * this host ever says.
   *
   * ## What it does not carry, and why each absence matters
   *
   * No ids, because the host does not know what is on the page and must not
   * find out — it sees rows it does not render, in a document it cannot read,
   * in a frame on another origin. No copy of the filter choice, because the
   * module already has that from `kehikot.context` and a second copy would be a
   * second answer to one question, disagreeing after any race. No correlation
   * id, because there is no answer: the only thing this host could do with an
   * acknowledgement is display it, and displaying it would mean reporting a
   * number it did not count about data it cannot see.
   *
   * What comes back instead is a new `kehikot.clearable` with a smaller count
   * in its label, or with `null` because there is nothing left. That is the
   * module reporting on its own work in its own words, which is the only
   * reporting anybody here is entitled to.
   *
   * ## Guarded on `greeted`, and it must be
   *
   * Like `sendEvent`, and here the guard is doing more than tidiness. The host
   * only draws this control for a module that announced `clearable`, and a
   * module can only have announced it after being greeted — so a press before
   * the greeting is a press on a button that should not exist. Dropping it is
   * the right answer to a state that should be unreachable.
   *
   * The arm that decides WHEN this is called is in `Clearing.tsx`. It has to be
   * on this side of the frame: `confirm()` in a sandbox without `allow-modals`
   * returns `false` silently, so a module guarding its own deletion would have
   * built a guard that always says no.
   */
  sendClear(): void {
    if (!this.greeted || this.closed) return
    this.post({ type: MESSAGE.CLEAR, protocol: PROTOCOL })
  }

  /**
   * Tell this module the person opened one of its Inbox items (protocol
   * 2.35.0, `kehikot.opened`): pressed it in the Inbox, on a toast or with
   * Next, and the host has come to its place. Carries the item's id and nothing
   * else, and is not answered: the module shows that thing and counts it as
   * seen, and says what became of the item in its next list.
   *
   * A page that has not answered its greeting yet — loading, or reloading
   * because the person's arrival put it on screen — is told once it does, if
   * that is within `OPENED_HOLD_MS`; only the latest item is held. A module
   * before 2.35.0 drops the message unread.
   */
  /**
   * Hand this module a file another module's page was dragging and let go over this frame
   * (`kehikot.drop`, protocol 2.94.0), with where in this page. Only to a page that answered its
   * greeting; the caller sends it only to a module that opens files. A drop is a moment: nothing is
   * held for a page that is not there yet.
   */
  sendDrop(file: FileDrag, at: PagePoint): void {
    if (this.closed || !this.greeted || !this.answered) return
    this.post({ type: MESSAGE.DROP, protocol: PROTOCOL, file, at })
  }

  sendOpened(item: string): void {
    if (this.closed) return
    if (!this.greeted || !this.answered) {
      this.openedLater = { item, at: Date.now() }
      return
    }
    this.openedLater = null
    this.post({ type: MESSAGE.OPENED, protocol: PROTOCOL, item })
  }

  /**
   * Tell this module the person's Inbox changed, or that they asked for the next thing that needs
   * them (protocol 2.79.0, `kehikot.inbox`). Only to a page that has answered its greeting: a page
   * still loading reads the Inbox when it is ready anyway, and a `next` it missed is the person's
   * to press again. The caller sends it only to a module that declares `inbox:person`.
   */
  sendInbox(signal: { kind: 'changed' | 'next'; rev: number; next?: { module: string; id: string } | null }): void {
    if (this.closed || !this.greeted || !this.answered) return
    this.post({
      type: MESSAGE.INBOX,
      protocol: PROTOCOL,
      kind: signal.kind,
      rev: signal.rev,
      ...(signal.kind === 'next' ? { next: signal.next ?? null } : {}),
    })
  }

  /**
   * Ask this module to search what it shows (protocol 2.69.0, `kehikot.find`),
   * for the find bar over its container. Returns the id the answer will carry,
   * or `null` when there is no page that has answered its greeting to ask — the
   * bar then says the module cannot be searched. A `close` is sent likewise and
   * not answered. See `host/find.ts`.
   */
  sendFind(ask: { query: string; caseSensitive: boolean; wholeWord: boolean; direction: 'first' | 'next' | 'prev' | 'close' }): string | null {
    if (this.closed || !this.greeted || !this.answered) return null
    const id = `find-${this.nextFind++}`
    this.post({ type: MESSAGE.FIND, protocol: PROTOCOL, id, query: ask.query.slice(0, LIMITS.FIND_QUERY), caseSensitive: ask.caseSensitive, wholeWord: ask.wholeWord, direction: ask.direction })
    return id
  }

  /**
   * Tell this module how much of its frame the host's own rows cover now
   * (protocol 2.42.0, `kehikot.covered`), for a module whose manifest says
   * `reveal: 'over'`: its frame keeps its size when focus mode reveals the
   * header and footer, and the rows are drawn over its top and bottom. STATE,
   * not a press: the latest is kept, sent only when it differs from what the
   * page was told, and sent again after a greeting while anything is covered
   * (a page starts from nothing covered on every greeting). See
   * `host/reveal.ts`.
   */
  sendCovered(covered: { top: number; bottom: number }): void {
    if (this.closed) return
    this.covered = { top: covered.top, bottom: covered.bottom }
    if (!this.greeted || !this.answered) return
    this.tellCovered()
  }

  private tellCovered(): void {
    const key = `${this.covered.top},${this.covered.bottom}`
    if (key === this.coveredTold) return
    this.coveredTold = key
    this.post({ type: MESSAGE.COVERED, protocol: PROTOCOL, ...this.covered })
  }

  /**
   * Tell this module whether its page is on screen (protocol 2.45.0,
   * `kehikot.visible`). The host keeps a page alive and hidden with CSS when
   * the person leaves for a kehikko its module is not on, or folds its
   * container — and inside a CSS-hidden frame no `visibilitychange` fires, so
   * this is the only way the page can know nobody is looking at it. `true`
   * after `false` is the person arriving back at it.
   *
   * STATE, like `sendCovered`: the latest is kept, a change is told, and the
   * page is told once after every greeting whatever it is. A module before
   * 2.45.0 drops the message unread.
   */
  sendVisible(visible: boolean): void {
    if (this.closed) return
    this.visible = visible
    if (!this.greeted || !this.answered) return
    this.tellVisible()
  }

  private tellVisible(): void {
    if (this.visibleTold === this.visible) return
    this.visibleTold = this.visible
    this.post({ type: MESSAGE.VISIBLE, protocol: PROTOCOL, visible: this.visible })
  }

  /**
   * Tell this module to read its material again.
   *
   * `sendClear`'s twin in shape and its opposite in consequence: that one is
   * the only destructive thing this host says, and this one is the only thing
   * it says that a CLOCK can cause. Both carry nothing and neither is answered.
   *
   * ## Two callers, one message
   *
   * A person pressed the control, or the interval on this container elapsed.
   * The module is not told which, deliberately — a flag saying "this one was
   * automatic" would be used to behave differently, which is a module setting
   * its own policy from a fact about somebody else's timer. See
   * `MESSAGE.REFRESH` in the protocol.
   *
   * ## Guarded on `greeted`, and here the guard earns more than tidiness
   *
   * The press half is like `sendClear`: the control is drawn only for a module
   * that announced `refreshable`, so a press before the greeting is a press on
   * a button that should not exist. The TIMER half is different in kind, because
   * nobody is watching it. An interval that went on posting into a frame that
   * has gone away, or has not come back yet, would be this host quietly asking
   * a dead conversation to spend a rate limit every five minutes for as long as
   * the app is open. Dropping it here is where that stops.
   *
   * What comes back is not a reply but a new `kehikot.refreshable` — `busy`
   * while it runs, then a new `at`, or the SAME `at` if the read failed and the
   * module is still showing the old one. That last case is the whole reason
   * this host does not date the data from this message.
   */
  sendRefresh(): void {
    if (!this.greeted || this.closed) return
    this.post({ type: MESSAGE.REFRESH, protocol: PROTOCOL })
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
      return Promise.resolve({ found: false, why: NOT_GREETED })
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
   * Tell this module that one item of its header was pressed, and wait —
   * briefly — to hear whether it took it.
   *
   * `clear` and `refresh` carry nothing and are answered by nothing; this is
   * the press with a name and an answer. `value` is the option chosen for a
   * switch or a go item, the state WANTED for a toggle — so a press delivered
   * twice does not flip twice — and absent for a run.
   *
   * The caller has already asked `pressRefusal` of the header as it stands
   * (`pressing` in `host/header.ts`); the module's client asks it again on
   * arrival, because the header may have been declared anew in between.
   *
   * No answer is "not taken", as the protocol says a host must read it, and
   * the sentence says which of the two silences it was: a page that has not
   * been greeted is a press to make again in a moment, a page that was and
   * said nothing is one that does not hear presses.
   *
   * "Taken" is not "finished". A compile that takes a minute answers at once
   * and says how it is going by declaring its header again; nothing here
   * waits for that.
   */
  press(item: string, value?: PressValue, place?: 'footer', carried?: 'copy' | 'open', text?: string): Promise<{ ok: boolean; why: string }> {
    if (this.closed) return Promise.resolve({ ok: false, why: `${this.name} was taken off the canvas, so nothing was pressed.` })
    if (!this.greeted || !this.answered) {
      return Promise.resolve({ ok: false, why: `${this.name} has not answered the host yet, so nothing was pressed.` })
    }
    const id = `p${this.nextPress++}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.presses.delete(id)
        resolve({ ok: false, why: `${this.name} did not answer the press, so it was not taken.` })
      }, this.pressedTimeoutMs)
      this.presses.set(id, { resolve, timer })
      this.post({ type: MESSAGE.PRESS, protocol: PROTOCOL, id, item, ...(value === undefined ? {} : { value }), ...(place ? { place } : {}), ...(carried ? { carried } : {}), ...(place && text !== undefined ? { text } : {}) })
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

    /* A type this host has never heard of is not a mistake: a later version
       of the protocol added it, and the module was built on that one. Dropped
       without a word — a fault line on the frame would be the host blaming a
       module for being newer than it is, again on every such message. Taken
       all the same (`true`): it came from this frame and is nobody else's.
       The protocol's rule, both directions: docs/header.md, "A message type
       the other side does not know". */
    if (!NAMED.has((event.data as { type: string }).type)) return true

    const parsed = moduleMessageSchema.safeParse(event.data)
    if (!parsed.success) {
      /* A type the host KNOWS, in a shape it cannot read — or one only a host
         says, sent by a module. Reported, because
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
      this.retried = false
      this.quietSince = null
      if (this.readyTimer) clearTimeout(this.readyTimer)
      const later = this.openedLater
      this.openedLater = null
      if (later && Date.now() - later.at <= OPENED_HOLD_MS) this.post({ type: MESSAGE.OPENED, protocol: PROTOCOL, item: later.item })
      /* A greeted page starts from nothing covered; tell it if the rows are out now. */
      this.coveredTold = '0,0'
      this.tellCovered()
      /* And whether it is on screen, once after every greeting. */
      this.visibleTold = null
      this.tellVisible()
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
      /* Protocol 2.70.0: a page still reading what it shows asks the cover to
         stay until it is drawn. Held for `holdCoverMs` at most, so a page that
         never says it is drawn is not covered for good. A `ready` without
         `hold` is a page drawn now: the cover comes off at once, as before. */
      const hold = message.hold === true
      this.letHold()
      if (hold) {
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null
          if (!this.closed) this.watcher.drawn?.()
        }, this.holdCoverMs)
      }
      this.watcher.ready(message.protocol, message.build ?? null, hold)
      /* Protocol 2.84.0: the held cover in the page's own words. */
      if (hold && message.label) this.watcher.loading?.(message.label)
      return true
    }

    case MESSAGE.LOADING: {
      const label = message.label ?? null
      /* Inside a held greeting the cover is up already: only its words change. */
      if (this.holdTimer) {
        this.watcher.loading?.(label)
        return true
      }
      /* Not answered yet: there is no page to cover, and the greeting's own cover stands. */
      if (!this.answered) return true
      this.loadLabel = label
      if (this.loadShown) {
        this.watcher.loading?.(label)
        return true
      }
      if (this.loadEnd) return true
      /* A redraw quicker than `loadingAfterMs` is never covered, so it does not flash. */
      this.loadShow = setTimeout(() => {
        this.loadShow = null
        if (this.closed) return
        this.loadShown = true
        this.watcher.loading?.(this.loadLabel)
      }, this.loadingAfterMs)
      this.loadEnd = setTimeout(() => {
        this.loadEnd = null
        if (!this.closed) this.endLoading()
      }, this.holdCoverMs)
      return true
    }

    case MESSAGE.DRAWN: {
      /* A held greeting's cover, or a context's (2.84.0). One sent with neither, or twice, is dropped. */
      if (this.holdTimer) {
        this.letHold()
        this.watcher.drawn?.()
        return true
      }
      if (this.loadEnd || this.loadShow || this.loadShown) this.endLoading()
      return true
    }

    case MESSAGE.REQUEST: {
      /* Answered asynchronously, and the id is carried through so that exactly
         one response goes back for exactly one question. Nothing is queued and
         nothing is deduplicated: a module that asks twice gets two answers,
         which is what it asked for. */
      /* Read NOW, synchronously, while the event that carried the request is
         being handled: the person's activation is transient. */
      const pressed = this.pressed()
      void this.ask(message.method, message.params, { pressed }).then((answer) => {
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
              ...(answer.declined === 'host-too-old' ? { declined: 'host-too-old' as const } : {}),
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

    case MESSAGE.FILTERS: {
      /* Handed on exactly as parsed, and nothing here looks inside it. The
         schema has already bounded every string, refused the three ids that are
         not really keys, and checked that each group's fallback names one of
         its own options — which is all the host is entitled to know about
         somebody else's vocabulary. What to DRAW is the canvas's business and
         what any of it MEANS is the module's; see `host/filters.ts`. */
      this.watcher.filters(message.groups)
      return true
    }

    case MESSAGE.CLEARABLE: {
      /* Handed on exactly as parsed, like the filter offer, and for the same
         reason: the schema has bounded the one string in it and there is
         nothing else here the host is entitled to know. What the label counts,
         and what pressing the control would destroy, are the module's. */
      this.watcher.clearable(message.label)
      return true
    }

    case MESSAGE.REFRESHABLE: {
      /* Handed on exactly as parsed, like the two offers above it. The schema
         has already checked that `at` is a real instant with an offset, which
         is the only thing the host is entitled to insist on: it is going to
         format that into a sentence a person reads beside a list, and it can
         only do that from an instant. What the reading contains, where it came
         from and whether it was worth making are the module's. */
      this.watcher.refreshable({ can: message.can, at: message.at, busy: message.busy })
      return true
    }

    case MESSAGE.HEADER: {
      /* Handed on exactly as parsed, like the offers above. The schema has
         bounded every string, refused duplicate ids and a switch whose value
         is not one of its options; what any item DOES is the module's. */
      this.watcher.header(message.items)
      return true
    }

    case MESSAGE.FOOTER: {
      /* As the header: handed on as parsed. Text and meters only say
         something; what a pressable item does is the module's. */
      this.watcher.footer?.(message.items)
      return true
    }

    case MESSAGE.POINTER: {
      this.watcher.pointer?.(message.phase, message.at)
      return true
    }

    case MESSAGE.FIND_RESULT: {
      /* Handed on as parsed: the schema has held `current` inside `total`. Which search it answers is
         the bar's to judge, by the id (`host/find.ts`). */
      this.watcher.findResult?.({ id: message.id, total: message.total, current: message.current, unsupported: message.unsupported })
      return true
    }

    case MESSAGE.DRAG: {
      /* Handed on as parsed: the schema has kept the path inside the project and the point bounded.
         Where it lands is `host/drops.ts`'s to judge, from where the frames are. */
      this.watcher.drag?.({ phase: message.phase, file: message.file, ...(message.at ? { at: message.at } : {}), dropped: message.dropped })
      return true
    }

    case MESSAGE.FIND_OPEN: {
      this.watcher.findOpen?.({ ...(message.query ? { query: message.query } : {}), ...(message.step ? { step: message.step } : {}) })
      return true
    }

    case MESSAGE.REFUSED: {
      /*
       * The page will not answer this window (protocol 2.93.0): it was told it may be framed by
       * other origins than this page's. The commonest way there is a module started for one window
       * and framed by another — the app came back on another address, or the module was started by
       * hand — and a restart by this host hands it this window's origin. Said at once, as what it
       * is; before 2.93.0 this was a page that loaded and never spoke, and it read as a broken module.
       * An answer already given stands: a refusal after `ready` is somebody else's window.
       */
      if (this.answered) return true
      this.silenced = true
      this.watcher.silent(refusedLine(this.name, message.origin, message.allowed))
      return true
    }
    case MESSAGE.PAGE_ERROR: {
      /*
       * The page failed, and says how (protocol 2.59.0). Before it answered
       * the greeting this is why it has not: kept, and said at the deadline in
       * place of "not answering" — or at once, when the deadline has passed.
       * A page that goes on to answer was not stopped by it, and the next
       * greeting forgets it.
       *
       * After it answered, only a greeting handler that threw is worth a line:
       * the page sent `ready` and then failed to take what it was given. Any
       * other rejection on a working page is the module's own to show, and a
       * line for each would be a container blaming a page that works.
       */
      const failure = { message: message.message, where: message.where, stack: message.stack }
      if (this.answered) {
        if (failure.where === 'greeting') this.watcher.fault(`${possessive(this.name)} page failed after it was greeted: ${failure.message}`)
        return true
      }
      if (this.failure) return true
      this.failure = failure
      /* Reported, never inferred: past the first deadline it is said the moment it arrives. */
      if (this.silenced || this.looked) {
        this.silenced = true
        this.sayFailure()
      }
      return true
    }

    case MESSAGE.PRESSED: {
      /* The answer to a `kehikot.press`, paired by the id the press carried.
         One that pairs with nothing — a second answer, an answer after the
         deadline, an id this conversation never issued — is read and let go:
         a module cannot settle a press that was not made. */
      const waiting = this.presses.get(message.id)
      if (!waiting) return true
      clearTimeout(waiting.timer)
      this.presses.delete(message.id)
      waiting.resolve({ ok: message.ok, why: message.why })
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

  /** Forget a held cover without lifting it: a new greeting holds again, or the conversation ended. */
  private letHold(): void {
    this.letLoading()
    if (!this.holdTimer) return
    clearTimeout(this.holdTimer)
    this.holdTimer = null
  }

  /** Forget a context's loading (2.84.0) without lifting its cover: the caller says what replaces it. */
  private letLoading(): void {
    if (this.loadShow) clearTimeout(this.loadShow)
    if (this.loadEnd) clearTimeout(this.loadEnd)
    this.loadShow = null
    this.loadEnd = null
    this.loadShown = false
    this.loadLabel = null
  }

  /** A context's loading is over — drawn, or waited for long enough. Its cover comes off if it went up. */
  private endLoading(): void {
    const shown = this.loadShown
    this.letLoading()
    if (shown) this.watcher.drawn?.()
  }

  /** Stop. Every timer cleared, every promise settled rather than dropped. */
  close(): void {
    this.closed = true
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.letHold()
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.resolve({ found: false, why: 'the frame was taken off the canvas' })
    }
    this.pending.clear()
    for (const [, waiting] of this.presses) {
      clearTimeout(waiting.timer)
      waiting.resolve({ ok: false, why: `${this.name} was taken off the canvas before it answered.` })
    }
    this.presses.clear()
  }

  private post(message: unknown): void {
    const target = this.frame.contentWindow
    if (!target) return
    /* See the essay above: `'*'` is the only address an opaque frame has, and
       the frame handle is the address that matters. */
    target.postMessage(message, this.origin ?? '*')
  }
}

/** "Notes’" for a name ending in s, "Mute’s" otherwise: a name as the module wrote it. */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}’` : `${name}’s`
}

/**
 * Where an error was thrown, from its stack: the first frame, as the browser
 * wrote it (`at f (http://…/app.tsx:3:9)` in Chromium, `f@http://…` in WebKit),
 * or null when the stack names none or the message already says one.
 * Bounded: this is somebody else's text going into a sentence.
 */
export function whereThrown(stack: string, message: string): string | null {
  for (const raw of stack.split('\n').slice(0, 12)) {
    const line = raw.trim()
    if (!line || message.includes(line) || line.startsWith(message)) continue
    const frame = line.startsWith('at ') ? line.slice(3) : /@\S+:\d+/.test(line) ? line : null
    if (frame) return frame.length > 160 ? `${frame.slice(0, 159)}…` : frame
  }
  return null
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
