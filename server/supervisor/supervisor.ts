import { buildStamp } from 'kehikot-module-protocol'
import { fetchManifest, type Presence } from '../discover.ts'
import { nameFromId } from '../../src/host/skills.ts'
import type { Nursery, Startable } from '../launch.ts'
import {
  endedTooOftenLine,
  EXIT_RESTARTS_WINDOW_MS,
  exitedLine,
  inFlight,
  lifecycleLine,
  lifecycleOf,
  MIN_RUN_MS,
  silentSaid,
  STARTING_FOR_MS,
  THEIRS_TO_RESTART_MS,
  toStart,
  toStop,
  toWarm,
  toWatch,
  WATCH_EVERY_MS,
  type Doing,
  type Idleness,
  type Lifecycle,
  type Standing,
  type Wanted,
} from '../lifecycle.ts'
import { probe, type ManifestCache } from '../manifests.ts'
import { installing, logFile, tail, trim } from '../moduleLog.ts'
import type { Registration } from '../registrations.ts'
import { Tethers } from '../tether.ts'
import { because } from '../traffic.ts'
import type { Place } from '../updates.ts'
import type { Processes } from './processes.ts'
import { ANSWERS_WITHIN_UPDATE_MS, type Restarts } from './restarts.ts'
import type { ModuleStates } from './state.ts'

/** How long after the open kehikko is up the timeline is written, and when it is written anyway. */
export const TIMELINE_AFTER_UP_MS = 15_000

/** What the supervisor reads of a sweep: the presences. The host's own sweep carries more, which it hands back (`pageView`). */
export interface Seen {
  readonly presences: readonly Presence[]
}

/**
 * Everything the supervisor reads or asks of the rest of the host. Read on each use, never copied
 * at construction: the host hands over some of these before it has made them (a getter), and
 * `seen`, `sweeping` and `going` are its own variables, read as they are now.
 */
export interface SupervisorDeps<V extends Seen = Seen> {
  states: ModuleStates
  /** The only place a module's script is run and stopped on purpose. */
  processes: Pick<Processes, 'run' | 'halt'>
  nursery: Nursery
  /** The registry as last read, by id. */
  registered: ReadonlyMap<string, Registration>
  /** What each module was when the page last looked. */
  lastPresences: ReadonlyMap<string, Presence>
  manifests: Pick<ManifestCache, 'wait' | 'forget' | 'read' | 'readAt' | 'stampOf'>
  idleness: Pick<Idleness, 'noted' | 'since' | 'forgetAllBut'>
  /** Which modules run older code than their checkout (`stale.ts`): forgotten for a module whose registration is gone. */
  staleness: { forgetAllBut(ids: Iterable<string>): void }
  /**
   * What holds a module's start back while its copy is changed: a start waits for each, and each
   * forgets what it held for a module whose registration is gone.
   */
  holds: {
    /** A newer release being put in place while the module is stopped (`whileStopped`). */
    releases: { applying(id: string): boolean; forgetAllBut(ids: Iterable<string>): void }
    /** Its copy being built (`moduleBuilds.ts`). */
    builds: { busy(id: string): boolean; forgetAllBut(ids: Iterable<string>): void }
    /** "Keep modules up to date automatically" (`autoUpdates.ts`). */
    auto: { pending(id: string): boolean; moved(): Promise<void>; forgetAllBut(ids: Iterable<string>): void }
  }
  /** The host's first moments (`boot.ts`), and what waits for the open kehikko to be up. */
  boot: {
    /** At host start, an installed copy waits until its own tags were read. */
    holds(id: string): boolean
    /** A kehikko opened while copies are still being read at host start: its copies go first. */
    pump(): void
    /** Whether a newer release is out, asked beside a start (`releaseWait.ts`). */
    checkWhenUp(place: Place): void
    /** The release checks held until the open kehikko is up. */
    runHeldChecks(): void
    /** The copies installed before modules were built: built once per host start (`backfill`). */
    backfilled(): boolean
    backfill(): void
  }
  /** Kehikko development: a module set to keep running that is not yet moved. */
  development: { owes(id: string, registration: Registration | null): boolean }
  /**
   * The press path (`restarts.ts`): a person's press of Start in flight (`pressedStarts`), and the
   * start a module set to keep running moves at (`startOnce`).
   */
  restarts: Pick<Restarts, 'pressedStarts' | 'startOnce'>
  startup: { has(step: string): boolean; mark(step: string): void; write(why: string): void }
  /** Tells the pages to read the modules again; with the reading, when there is one. */
  wakes: { registryChanged(view?: unknown): void }

  /** One sweep of every registered module; shared with whoever asks meanwhile. */
  sweep(how?: boolean | { kept: true }): Promise<V>
  /** The last sweep, or null before the first. */
  seen(): Promise<V> | null
  /** The sweep in flight, or null. */
  sweeping(): Promise<V> | null
  /** What `/host/modules` answers, from a sweep in hand. */
  pageView(view: V): Promise<unknown>
  /** The app is stopping this host: nothing is started from here on. */
  going(): boolean

  /** What is needed and what is warm, at `now` (`wanted` in `lifecycle.ts`). */
  wanted(now: number): Wanted
  startable(registration: Registration | null): Startable
  /** An installed module's place; null for anything else. */
  installedPlace(id: string): Place | null
  /** The versions containers are pinned to, by the same rule as the modules (`versionRuns.ts`). */
  reconcileVersions(now: number, mayStart: boolean): void
  /** A module the host stopped: a newer release is put in place while it is (`whileStopped`). */
  whileStopped(id: string, url: string): Promise<void>
  /** A module's name as a person reads it in a sentence. */
  spokenName(id: string): string

  /* Seams, for tests: the clock and timers, the log, the module logs and the network. */
  now?: () => number
  /** Run `fn` once after `ms`, never keeping the process up for it. */
  after?: (ms: number, fn: () => void) => void
  /** Run `work` every `ms`, under the reason `why`, never keeping the process up for it. */
  every?: (ms: number, why: string, work: () => Promise<void>) => void
  log?: (line: string) => void
  logs?: { file(id: string): string; tail(file: string): string[]; trim(file: string): void; installing(file: string): boolean }
  /** Whether something answers at a module's origin: its manifest read, or a connection that was not refused. */
  answersAt?: (url: string) => Promise<boolean>
  /** A module's health door asked (`probe` in `manifests.ts`). */
  probe?: (url: string) => Promise<{ reached: boolean; stamp: string | null }>
  /** The held connections to the modules this host did not start (`tether.ts`). */
  tethers?: (dropped: (id: string, quick: boolean) => void) => { sync(want: ReadonlyMap<string, string>): void }
}

/**
 * The module supervisor: from what a sweep found and what the host believes (`state.ts`), decide
 * which modules to start and stop, and keep finding out whether they are still there.
 *
 * Gathering is `standings`; deciding is `lifecycle.ts`, arithmetic over what that returns; acting is
 * `govern`, the only caller of `begin`, which is the only place a module nobody pressed a button for
 * is started. The processes themselves are `processes.ts`; a run that ended is `ended`. The tethers,
 * the watch and the reaper are the three ways this host keeps asking.
 */
export class Supervisor<V extends Seen = Seen> {
  readonly #deps: SupervisorDeps<V>
  readonly #now: () => number
  readonly #after: (ms: number, fn: () => void) => void
  readonly #every: (ms: number, why: string, work: () => Promise<void>) => void
  readonly #log: (line: string) => void
  readonly #logs: NonNullable<SupervisorDeps['logs']>
  readonly #answersAt: (url: string) => Promise<boolean>
  readonly #probe: (url: string) => Promise<{ reached: boolean; stamp: string | null }>
  readonly #tethers: { sync(want: ReadonlyMap<string, string>): void }
  /** One watch at a time. A slow port must not have two rounds asking about it. */
  #watching = false

  constructor(deps: SupervisorDeps<V>) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
    this.#after = deps.after ?? ((ms, fn) => void setTimeout(fn, ms).unref?.())
    this.#every = deps.every ?? ((ms, why, work) => void setInterval(() => void because(why, work), ms).unref())
    this.#log = deps.log ?? ((line) => console.log(line))
    this.#logs = deps.logs ?? { file: (id) => logFile(id), tail: (file) => tail(file), trim: (file) => void trim(file), installing }
    this.#answersAt = deps.answersAt ?? ((url) => fetchManifest(url).then((got) => (got.ok ? true : got.reached), () => false))
    this.#probe = deps.probe ?? ((url) => probe(url))
    this.#tethers = (deps.tethers ?? ((dropped) => new Tethers(dropped)))((id, quick) => this.#dropped(id, quick))
  }

  /**
   * Ask once a second whether a module that somebody else was running has come
   * back, and when it has — or when its time is up — look properly, decide, and
   * tell the pages. After the time is up the deciding is the ordinary rule: a
   * module an open kehikko has, that nothing answers for, is started.
   */
  #theirReturn(id: string): void {
    const { theirs } = this.#deps.states
    const again = async () => {
      const went = theirs.get(id)
      if (went === undefined) return
      const registration = this.#deps.registered.get(id)
      const back = registration ? await this.#answersAt(registration.url) : false
      if (registration && !back && this.#now() - went < THEIRS_TO_RESTART_MS) {
        this.#after(1_000, () => void again())
        return
      }
      theirs.delete(id)
      try {
        const view = await this.#deps.sweep()
        this.govern(view.presences)
      } catch {
        /* Nothing found out; the watch asks within half a minute. */
      }
      this.#deps.wakes.registryChanged()
    }
    this.#after(1_000, () => void because('is the module back', again))
  }

  /** What the host is doing to one module, for `lifecycleOf`. */
  #doing(id: string): Doing {
    const { states, nursery, boot } = this.#deps
    const { releases, builds, auto } = this.#deps.holds
    const ranAt = states.starting.get(id) ?? null
    const alive = nursery.holds(id)
    return {
      work: states.working.get(id) ?? null,
      ranAt,
      alive,
      /* Read only for a start still in flight: it is a file read. */
      installing: ranAt !== null && alive && this.#logs.installing(this.#logs.file(id)),
      asleep: states.sleeping.has(id),
      /* Its copy is being put on a newer release, or built, or read at host start for one: started after. */
      levelling: releases.applying(id) || builds.busy(id) || auto.pending(id) || boot.holds(id),
    }
  }

  /** Whether a start, install, update or restart the host is running for it is still in flight. */
  isStarting(id: string, now: number): boolean {
    return inFlight(lifecycleOf(true, this.#doing(id), now))
  }

  /**
   * What the host has done to a module lately, for the container to say.
   *
   * Only ever attached to a module that is not answering, because that is the
   * only time it changes what a person should read: a module that is up needs no
   * explanation, and one that is down needs the right one. A module that has come
   * back — however it came back — stops being described as asleep here, which is
   * how a module the other agent restarted by hand loses the word.
   */
  saidOf(presence: Presence, now: number): Lifecycle | undefined {
    if (presence.condition !== 'silent') this.#deps.states.answering(presence.id)
    return lifecycleOf(presence.condition === 'silent', this.#doing(presence.id), now)
  }

  /** A sweep as the page receives it, with the host's own lifecycle words on it. */
  told<W extends Seen>(view: W): W {
    const { nursery, states } = this.#deps
    const { stoppedByPerson, failures, theirs } = states
    const now = this.#now()
    return {
      ...view,
      presences: view.presences.map((seen) => {
        const startedAt = nursery.startedAt(seen.id)
        const held = startedAt === null ? seen : { ...seen, run: startedAt }
        /* Said only while nothing answers: a module somebody else started is running, whatever was pressed. */
        const presence = stoppedByPerson.has(seen.id) && seen.condition === 'silent' && !seen.reached ? { ...held, stopped: true as const } : held
        const lifecycle = this.saidOf(presence, now)
        if (!lifecycle) {
          if (presence.condition !== 'silent') return presence
          /* Nothing is wrong and nothing is coming: said as that, with the one thing to do. */
          if ('stopped' in presence && presence.stopped) {
            return { ...presence, line: `${presence.name ?? nameFromId(presence.id)} was stopped. It stays stopped until you press Start.` }
          }
          const log = this.#logs.file(presence.id)
          const said = silentSaid({ ...presence, name: presence.name ?? nameFromId(presence.id) }, {
            failed: failures.get(presence.id) ?? null,
            theirs: theirs.has(presence.id),
            held: nursery.holds(presence.id),
            log,
            printed: () => this.#logs.tail(log),
          })
          return said ? { ...presence, ...said } : presence
        }
        /* The line is replaced, not appended to. `discover.ts` wrote a good
           sentence about a program that is not running and does not know why;
           this host DOES know why, and showing both would be the container saying
           two things about one fact. See `lifecycle.ts` for the sentences. */
        return { ...presence, lifecycle, line: lifecycleLine(lifecycle, presence.name ?? nameFromId(presence.id), presence.at) }
      }),
    }
  }

  /**
   * Every fact the policy is allowed to consider, gathered in one place.
   *
   * Gathering and deciding are deliberately separate functions in separate files.
   * Everything here reads a map, a database or a directory; everything in
   * `lifecycle.ts` is arithmetic over what this returns. That is what lets the
   * policy — which module may be stopped, when, and what is exempt — be tested
   * exhaustively without a process ever being created.
   */
  standings(presences: readonly Presence[], now: number): Standing[] {
    const { states, nursery, idleness, startup, registered } = this.#deps
    const { scopeRead, starting, inHand, failures, stoppedByPerson } = states
    for (const presence of presences) if (presence.module) scopeRead.set(presence.id, presence.module)
    const { needed, warm } = this.#deps.wanted(now)
    idleness.noted(needed, now)
    /* Warm counts as needed for idleness: a module on another kehikko of the
       open project is idle from when the project closed, not from when the
       person last looked at its kehikko. */
    idleness.noted(warm.keys(), now)

    /* A module whose registration is gone stops being remembered anywhere here.
       Not housekeeping for its own sake: an entry left in `sleeping` would keep
       the host saying "asleep" about a program nobody has registered any more,
       and one left in the nursery would have it holding a pid for a name it can
       no longer look up a directory for. The registry is the list of what exists
       — see `readRegistrations` — so it is also the list of what these may hold. */
    const here = new Set(presences.map((presence) => presence.id))
    idleness.forgetAllBut(here)
    states.forgetAllBut(here)
    this.#deps.staleness.forgetAllBut(here)
    this.#deps.holds.releases.forgetAllBut(here)
    this.#deps.holds.auto.forgetAllBut(here)
    this.#deps.holds.builds.forgetAllBut(here)
    for (const id of nursery.ids) if (!here.has(id)) nursery.forget(id)

    return presences.map((presence) => {
      const registration = registered.get(presence.id) ?? null
      /* `startedAt` is null for every module this host did not start, and asking
         the nursery is also what drops a pid whose process has died — so a module
         somebody restarted by hand stops being ours at the moment we look. */
      const startedAt = nursery.startedAt(presence.id)
      /* Answering ends a start, whoever asked: without this a module that came
         up stayed "starting" here until a page's own sweep said otherwise, and
         the project's next modules (`toWarm`) waited the whole `STARTING_FOR_MS`
         behind it. */
      if (presence.condition !== 'silent') starting.delete(presence.id)
      if (presence.reached && startup.has(`started ${presence.id}`)) startup.mark(`answered ${presence.id}`)
      return {
        id: presence.id,
        needed: needed.has(presence.id),
        warm: warm.get(presence.id) ?? null,
        answering: presence.reached,
        startable: this.#deps.startable(registration).ok,
        ours: startedAt !== null,
        keep: registration?.keep === true,
        idleSince: idleness.since(presence.id, startedAt),
        /* An update in hand counts too: it decides for itself whether to start
           the module again, and nothing else may in the meantime. */
        starting: this.isStarting(presence.id, now) || inHand.has(presence.id),
        /* Stopped by a person counts as not to be started again on its own, as a start that failed does. */
        failed: failures.has(presence.id) || stoppedByPerson.has(presence.id),
      }
    })
  }

  /**
   * Run one module's script because a kehikko somebody has open needs it.
   *
   * The one place in this program that starts something nobody pressed a button
   * for, and it is worth saying exactly why that is not the autostart `launch.ts`
   * refuses. That essay's objection is to a host that runs programs on a guess —
   * everything registered, at boot, because it might be wanted. This runs one
   * named program because a person is at this moment looking at a container for
   * it, on a canvas they arranged, from a registration they wrote naming a
   * directory they chose. The press has not disappeared; it has moved from a
   * button on the container to the act of opening the kehikko the container is on.
   *
   * Nothing is started that is not on an open kehikko or on another kehikko of
   * the project it is in (`toWarm`, while the person keeps a project's modules
   * running — the kehikot they arranged in the project they have open). There
   * is no prediction beyond that and no retry loop: a start that does not take is
   * a container that says so, with the button on it, which is where this began.
   */
  begin(id: string, why = 'an open kehikko or project has it'): void {
    const { states, nursery, development, boot } = this.#deps
    const { releases, auto, builds } = this.#deps.holds
    const { pressedStarts } = this.#deps.restarts
    const { theirs, stoppedByPerson, inHand } = states
    /* A host on its way out starts nothing: see `leave` in `server.ts`. */
    if (this.#deps.going()) return
    /* Somebody else was running it and it has only just gone: theirs to bring
       back first. See `THEIRS_TO_RESTART_MS`. */
    if (theirs.has(id)) return
    /* A person stopped it from the modules menu: it stays stopped until they press Start. */
    if (stoppedByPerson.has(id)) return
    /* A newer release is being put in place while it is stopped (`whileStopped`);
       started when that is done. */
    if (releases.applying(id)) return
    /* "Keep modules up to date automatically" is putting a newer release in
       place, or has one queued (`autoUpdates.ts`); started when that is done.
       At host start, an installed copy waits until its own tags were read. */
    if (auto.pending(id) || boot.holds(id)) return
    /* Its copy is being built (`moduleBuilds.ts`): a build is never run under
       a module, so the start waits for that one build. Started when it ends. */
    if (builds.busy(id)) return
    /* Already starting, by a press or an update, or a process of the host's is
       there: a second copy would race it for the port (`startOnce.ts`). */
    if (inHand.has(id) || pressedStarts.has(id) || nursery.holds(id)) return
    /* Its process ended a moment ago and the next start after an end waits (`ExitRestarts`). */
    if (states.heldAfterEnd(id, this.#now())) return
    const registration = this.#deps.registered.get(id) ?? null
    const can = this.#deps.startable(registration)
    if (!can.ok) return
    /* Set to keep running and not yet moved (Kehikko development): this start is its next restart, so it is moved first. */
    if (development.owes(id, registration)) {
      void because('a module set to keep running moves at its next start', () => this.#deps.restarts.startOnce(id, registration, can.run, ANSWERS_WITHIN_UPDATE_MS)).catch(() => null)
      return
    }
    const ran = this.#deps.processes.run(id, can.run)
    if (!ran.ok || !ran.child) return
    this.#log(`kehikko: started ${id} at ${can.run.url} — ${why} (pid ${ran.child.pid})`)
    /* The copy as it is starts now; whether a newer release is out is asked
       beside it, never before it. See `releaseWait.ts`. */
    const place = this.#deps.installedPlace(id)
    if (place) boot.checkWhenUp(place)
    /* Under its own reason: it is started from whatever request decided to start it (a page's
       report, a page's read of the modules), and its asks were filed under that, as the page's. */
    void because('the host waits for a module it started', () => this.#untilAnswered(id, can.run.url))
  }

  /**
   * The moment a module the host started answers, decide again and tell the
   * pages — instead of the page finding out on its next 1.5-second look, and
   * so that the next of the project's modules (`toWarm`) starts as soon as
   * there is room. Bounded by `STARTING_FOR_MS`, after which the host has
   * stopped saying "starting" anyway.
   */
  async #untilAnswered(id: string, url: string): Promise<void> {
    const { runs } = this.#deps.states
    const at = runs.get(id)
    const registration = this.#deps.registered.get(id)
    if (!registration || registration.url !== url) return
    /* The one asker of a module the host started: every sweep meanwhile reads what this found. */
    const waited = await this.#deps.manifests.wait(registration, STARTING_FOR_MS)
    /* Replaced, stopped or ended meanwhile: whoever did that decides, and tells. */
    if ((!waited.up && waited.cancelled) || runs.get(id) !== at) return
    try {
      const sweeping = this.#deps.sweeping()
      if (sweeping) await sweeping.catch(() => null)
      /* What every other module said stands: only this one changed, and the wait has its answer. */
      const view = await this.#deps.sweep({ kept: true })
      this.govern(view.presences)
      /* Up, or given up on: either way the containers stop saying "starting". The reading goes
         with the news, so no page asks for it again (`registryIn` in `src/host/registry.ts`). */
      this.#deps.wakes.registryChanged(await this.#deps.pageView(view))
    } catch {
      /* Nothing found out; the page's own look and the watch still ask. */
    }
  }

  /**
   * A process this host started has ended, and it is news (`Processes` hands over only the run the
   * host was still waiting on, and has forgotten what that process served).
   *
   * This is how a dead module stops looking alive without waiting for the
   * thirty-second watch: the runtime says so, once, and the host looks. Nothing
   * is polled. A module the host did not start still waits for the watch — there
   * is no handle to hear from.
   *
   * What it does depends on what the process had done. One that ended before it
   * ever answered, or within `MIN_RUN_MS`, failed to start: the container says
   * what it printed and it is NOT started again, or a broken module would be
   * spawned in a loop. One that had been running is a module that died — a Vite
   * config reload ends the process on purpose — and the ordinary policy starts
   * it again if a kehikko still has it.
   */
  async ended(id: string, at: number, code: number | null): Promise<void> {
    const { working, inHand, runs, starting, failures, exitRestarts, exitHeld } = this.#deps.states
    const logs = this.#logs
    /* An update or a restart in hand already knows, and decides for itself. */
    if (working.has(id) || inHand.has(id)) return
    try {
      /* A sweep already in flight may have asked before the process ended. */
      const sweeping = this.#deps.sweeping()
      if (sweeping) await sweeping.catch(() => null)
      const view = await this.#deps.sweep()
      const presence = view.presences.find((one) => one.id === id)
      /* The sweep took its time, and a start began meanwhile (a person's press, the host's own): the
         process in `starting` and in `runs` is that one's, not the one that ended. Judging it by this
         end blamed it for a failure that was not its own and cleared its `starting`. It decides for itself. */
      if (runs.has(id)) return
      /* Something answers there: this module was already running, and the copy
         the host started stepped aside, which is what it is meant to do. */
      if (!presence || presence.reached) return
      const neverAnswered = starting.has(id)
      if (neverAnswered || this.#now() - at < MIN_RUN_MS) {
        starting.delete(id)
        failures.set(id, { line: exitedLine(presence.name ?? this.#deps.spokenName(id), presence.at, code, logs.file(id)), detail: logs.tail(logs.file(id)) })
        this.#log(`kehikko: ${id} stopped again${code === null ? '' : ` (exit code ${code})`} without answering — see ${logs.file(id)}`)
      } else {
        /* Started again on its own only so often, and each time later (`ExitRestarts`). */
        const again = exitRestarts.ended(id)
        if (again.wait === null) {
          failures.set(id, { line: endedTooOftenLine(presence.name ?? this.#deps.spokenName(id), again.times, logs.file(id)), detail: logs.tail(logs.file(id)) })
          this.#log(`kehikko: ${id} ended ${again.times} times within ${EXIT_RESTARTS_WINDOW_MS / 60_000} minutes — not started again until a press`)
        } else if (again.wait > 0) {
          exitHeld.set(id, this.#now() + again.wait)
          this.#log(`kehikko: ${id} is no longer running — started again in ${again.wait / 1000} s`)
          this.#after(again.wait, () => {
            exitHeld.delete(id)
            void this.#deps.sweep().then((later) => this.govern(later.presences)).catch(() => null).finally(() => this.#deps.wakes.registryChanged())
          })
        } else {
          this.#log(`kehikko: ${id} is no longer running — the process the host started ended`)
        }
      }
      this.govern(view.presences)
      this.#deps.wakes.registryChanged()
    } catch {
      /* Nothing found out; the watch asks again within half a minute. */
    }
  }

  /**
   * Decide and act, from a sweep already in hand.
   *
   * Never sweeps: the caller has just done that, or is deliberately working from
   * the last one. Never awaits either — a start is a spawn and the moment after
   * it the module is `starting`, which is a thing the container can say straight
   * away. Waiting here would make every canvas switch pause for a dev server.
   */
  govern(presences: readonly Presence[], mayStart = true): void {
    const now = this.#now()
    this.notice(presences, now)
    this.#act(this.standings(presences, now), now, mayStart)
  }

  /**
   * See a module somebody else was running go, wherever the sweep that shows it
   * came from — the tether, the watch, a page saying its module went quiet — so
   * the host does not start a copy of its own in the same breath. See
   * `THEIRS_TO_RESTART_MS`. Something the host itself has in hand (an update, a
   * restart) is the host's doing and is not waited on.
   */
  notice(presences: readonly Presence[], now: number): void {
    const { answeredBy, theirs, inHand, working } = this.#deps.states
    for (const presence of presences) {
      const id = presence.id
      if (presence.reached) {
        answeredBy.set(id, this.#deps.nursery.holds(id) ? 'ours' : 'theirs')
        theirs.delete(id)
        continue
      }
      const was = answeredBy.get(id)
      answeredBy.delete(id)
      if (was !== 'theirs' || theirs.has(id) || inHand.has(id) || working.has(id)) continue
      theirs.set(id, now)
      this.#theirReturn(id)
    }
  }

  /** The same decision, from standings the caller already gathered. */
  #act(standing: readonly Standing[], now: number, mayStart: boolean): void {
    const { states, startup } = this.#deps
    /* An automatic update that waited for its module to be off screen or stopped
       may go now — decided before anything is started, so a module it takes is
       held back (`auto.pending`) rather than started on the old release. */
    void this.#deps.holds.auto.moved()
    /* A kehikko opened while copies are still being read at host start: its copies go first. */
    this.#deps.boot.pump()
    if (mayStart) {
      for (const id of toStart(standing)) this.begin(id)
      /* The rest of the open project, in the background: nothing while the
         open kehikko's own are still to start, a few at a time after. The next
         few start when one answers (`untilAnswered`). */
      for (const id of toWarm(standing)) this.begin(id)
      /* Once the open kehikko's modules are up, the copies installed before
         modules were built are built, in the background (`backfill`). */
      if (!this.#deps.boot.backfilled() && openUp(standing)) this.#deps.boot.backfill()
      if (!startup.has('open kehikko up') && openUp(standing)) {
        startup.mark('open kehikko up')
        this.#deps.boot.runHeldChecks()
        /* Written a little after, so that what waits for this moment is in it too. */
        this.#after(TIMELINE_AFTER_UP_MS, () => startup.write('the open kehikko is up'))
      }
    }

    /* The versions containers are pinned to, by the same rule as the modules:
       started for an open kehikko, stopped when nothing pins them or nobody has
       looked for the grace period. See `versionRuns.ts`. */
    this.#deps.reconcileVersions(now, mayStart)

    for (const id of toStop(standing, now)) {
      const was = this.#deps.processes.halt(id)
      if (was !== 'stopped') continue
      states.sleeping.set(id, now)
      states.starting.delete(id)
      this.#log(`kehikko: stopped ${id} — no open kehikko or project has had it for the grace period`)
      const url = this.#deps.registered.get(id)?.url
      if (url) void because('the host waits for a module it stopped', () => this.#deps.whileStopped(id, url))
    }

    this.#tether(standing)
  }

  /**
   * A held connection to each module somebody is looking at that this host did
   * not start, so its going is heard when it goes instead of at the next watch.
   * See `tether.ts`. A drop is a reason to look, and looking is the watch, asked
   * of that one module.
   */
  #dropped(id: string, quick: boolean): void {
    void because('a module’s connection closed', async () => {
      try {
        const seen = this.#deps.seen()
        if (!seen) return
        const now = this.#now()
        const standing = this.standings((await seen).presences, now)
        /* It had been held a while: most often an idle connection the module
           closed (Bun's server does after ten seconds). Put it back before asking
           anything — a process that died leaves nothing to connect to, so the new
           tether closes at once, and THAT is the drop that asks. Asking the module
           on every idle close was a request every ten seconds per module, each to
           be told nothing changed. */
        if (!quick) {
          this.#tether(standing)
          return
        }
        /* A watch already asking is asking about this one too, a moment early:
           once it is done, ask again. One that closed at once is put back by the
           next tick. */
        while (this.#watching) await new Promise<void>((wake) => this.#after(50, wake))
        await this.watch(standing, new Set([id]))
      } catch {
        /* Nothing found out; the watch asks within half a minute. */
      }
    })
  }

  /** Tether exactly the modules an open kehikko has, that answer, and that this host does not hold. */
  #tether(standing: readonly Standing[]): void {
    const want = new Map<string, string>()
    for (const one of standing) {
      if (!one.needed || !one.answering || one.ours || one.starting) continue
      const url = this.#deps.registered.get(one.id)?.url
      if (url) want.set(one.id, url)
    }
    this.#tethers.sync(want)
  }

  /**
   * Ask whether the modules somebody is looking at are still there.
   *
   * ## What this is for
   *
   * `Presence.condition` is documented as what the host found out by ASKING, and
   * until this existed the host stopped asking the moment everything was `ready`.
   * A module that died afterwards kept its green light until the person reloaded
   * or alt-tabbed — while its own page, inside the frame, already said the
   * connection had ended. Two halves of one screen disagreeing, which is this
   * workspace's recurring failure shape. See `WATCH_EVERY_MS` in `lifecycle.ts`
   * for why this is a check and not a heartbeat, and for the numbers.
   *
   * ## What it asks
   *
   * The module's health door (its manifest's `health`, `/healthz` on the
   * protocol's doors), not its manifest: `probe` in `manifests.ts`. The two
   * cases that matter are the same — a connection REFUSED is nothing running, a
   * connection accepted and then silent is something running badly — and the
   * health door's `x-module-build` header says which process answered, which is
   * all the manifest was asked for here. A module that names no health door is
   * asked for its manifest, through `manifests`, so the answer is kept. A module
   * whose manifest was read within the last half tick is not asked at all on the
   * timer's round: that read is the answer. A tether's drop (`only`) always asks.
   *
   * What it finds goes to `manifests`: a module that went, came back or answers
   * from another build is forgotten there, so the sweep below reads it again.
   *
   * ## Why nothing here decides anything
   *
   * A changed bit is not a finding; it is a reason to make one. So this does no
   * arithmetic on conditions, writes no line, and touches neither `starting` nor
   * `sleeping`. It sweeps — the whole sweep, once, the same one the page would
   * have asked for — and hands that to `govern`, which is where the policy lives
   * and the only place that may start anything. A watch that had reasoned about
   * reachability on its own would be a second, worse `discover.ts`.
   */
  async watch(standing: readonly Standing[], only?: ReadonlySet<string>): Promise<void> {
    if (this.#watching) return
    const { manifests, registered } = this.#deps
    const ids = toWatch(standing).filter((id) => !only || only.has(id))
    if (ids.length === 0) return
    const believed = new Map(standing.map((s) => [s.id, s.answering]))
    /* And WHICH process answered, where the module says: another one at the same
       address is a restart nobody told this host about, and the page framed from
       the old one is older than its server. See `stampOf`. */
    const stamps = new Map<string, string | null>()
    for (const presence of (await this.#deps.seen()?.catch(() => null))?.presences ?? []) {
      stamps.set(presence.id, presence.module?.build ? buildStamp(presence.module.build) : null)
    }

    this.#watching = true
    try {
      const found = await Promise.all(
        ids.map(async (id) => {
          const registration = registered.get(id)
          /* Unregistered since the standings were gathered. `standings` will
             forget it on the next tick; there is nothing to ask. */
          if (!registration) return null
          const read = manifests.readAt(id)
          if (!only && read !== null && this.#now() - read < WATCH_EVERY_MS / 2) return { id, reached: true, stamp: manifests.stampOf(id) }
          const health = this.#deps.lastPresences.get(id)?.module?.health ?? null
          if (health) return { id, ...(await this.#probe(health)) }
          const presence = await manifests.read(registration, { fresh: true })
          return { id, reached: presence.reached, stamp: presence.module?.build ? buildStamp(presence.module.build) : null }
        }),
      )

      type Found = { id: string; reached: boolean; stamp: string | null }
      const another = (one: Found): boolean => {
        const was = stamps.get(one.id) ?? null
        return one.reached && believed.get(one.id) === true && was !== null && one.stamp !== null && was !== one.stamp
      }
      const changed = found.filter(
        (one): one is Found => one !== null && (believed.get(one.id) !== one.reached || another(one)),
      )
      if (changed.length === 0) return
      for (const one of changed) manifests.forget(one.id)
      for (const one of changed) {
        this.#log(
          `kehikko: ${one.id} is ${another(one) ? 'answered by another process' : one.reached ? 'answering again' : 'no longer answering'} — `
            + 'an open kehikko has it, so the host looked',
        )
      }

      /* One sweep, then the policy, then the pages. The ORDER is the whole of it:
         `govern` may start the module that just died, and a page told before that
         would sweep, be told `silent`, and draw a start button for a start that
         is already happening. Told after, it reads `starting` and says so. */
      const view = await this.#deps.sweep()
      this.govern(view.presences)
      this.#deps.wakes.registryChanged()
    } catch {
      /* A watch that failed found nothing out, which is the safe outcome: nobody
         is told, nothing is started, and the next tick asks again. */
    } finally {
      this.#watching = false
    }
  }

  /**
   * The reaper: stop what nothing has needed for long enough.
   *
   * On a timer and not on a request, because the moment worth reclaiming memory
   * is the moment nobody is looking — a canvas closed for the night makes no
   * requests at all, and a policy that only ran when the page asked would save
   * exactly nothing overnight, which is most of the day.
   *
   * It costs a sqlite read and some arithmetic. No sweep, no manifest, no
   * network — see `Sweeper.seen` in `sweep.ts`. Every thirty seconds, so the effective
   * grace is five minutes and a bit, and the "and a bit" does not matter to anything.
   *
   * ## And the watch, on the same tick, deliberately
   *
   * The two are opposite halves of one question — the reaper is about the modules
   * NOBODY is looking at, the watch about the ones somebody is — and they read
   * the same standings, from the same clock, on the same evidence about which
   * screens exist. Running them on one timer means one place decides how often
   * this host thinks about a module's life, and there is no second interval to
   * fall out of step with the first.
   *
   * The watch is the half that costs anything: half a dozen localhost GETs while
   * a canvas is open, and none at all when no page reports a kehikko. See
   * `WATCH_EVERY_MS` in `lifecycle.ts` for the whole argument and the numbers,
   * and `watch` above for what it does with what it finds. `REAP_EVERY_MS` is
   * kept as its own name because the reaper's number is argued from the grace
   * period and the watch's from how fast a dead module has to stop looking alive;
   * they agree today, and neither is the reason for the other.
   */
  start(): void {
    /* The sooner of the two, so that either constant may be lowered on its own
       argument without the other silently capping it. */
    this.#every(Math.min(REAP_EVERY_MS, WATCH_EVERY_MS), 'is each module still up', () => this.tick())
  }

  /** One tick of the reaper and the watch: `start`. */
  async tick(): Promise<void> {
    try {
      /* No sweep has happened yet, so the host knows nothing about what is
         running — and a host that knows nothing must not decide anything. It
         also cannot have started anything, so there is nothing to stop. */
      const seen = this.#deps.seen()
      if (!seen) return
      const now = this.#now()
      const standing = this.standings((await seen).presences, now)
      this.#act(standing, now, false)
      /* The logs of what is running, kept to their bound. A stat each. */
      for (const id of this.#deps.nursery.ids) this.#logs.trim(this.#logs.file(id))
      /* Not awaited: the reaper's decision is arithmetic and is already made,
         and the watch is network. A tick that waited on half a dozen ports
         before reaping would make reclaiming memory depend on a module being
         slow to answer. */
      void this.watch(standing)
    } catch {
      /* A failed sweep is not a reason to kill anything. */
    }
  }
}

/** The reaper's tick: see `start`. */
export const REAP_EVERY_MS = 30_000

/** The open kehikko's modules are up: one is needed, and each needed one answers, failed, or cannot be started here. */
export function openUp(standing: readonly Standing[]): boolean {
  const needed = standing.filter((one) => one.needed)
  return needed.length > 0 && needed.every((one) => one.answering || one.failed || !one.startable)
}
