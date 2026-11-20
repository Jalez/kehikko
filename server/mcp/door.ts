import type { Database } from 'bun:sqlite'
import type { FooterItem, HeaderItem, SharedAddress, SharedLocation } from 'kehikot-module-protocol'

import type { ConnectionModule } from '../../src/host/connections.ts'
import type { Pressed, Pressing } from '../../src/host/header.ts'
import type { SettingsAnswer, SettingsListed } from '../../src/host/moduleSettings.ts'
import type { StorageReport } from '../../src/host/storage.ts'
import type { AgentMessages } from '../agentMessages.ts'
import type { TrackerDoor } from '../answers.ts'
import type { DoorMessageDeps } from '../doorMessages.ts'
import type { Here, Looking, Unrecorded } from '../doorPlaces.ts'
import type { Came } from '../headers.ts'
import type { Inbox } from '../inbox.ts'
import type { WhichKehikko } from '../open.ts'
import type { Pinned, VersionListing } from '../pins.ts'
import type { Project } from '../projects.ts'
import type { ArrangeNote, FoldNote } from '../wake.ts'

/**
 * What the host's own door is handed, and what a tool answers.
 *
 * `server/mcp.ts` is the door (its essay says what is on it and why); this is the shape of the
 * rest of the host as the door sees it, shared by every tool under `server/mcp/tools/`.
 */

/** What a tool says back: a sentence, and whether it is a refusal (sent as a tool error). */
export interface Answer {
  text: string
  failed: boolean
}

/**
 * The conversation's place and what the person is looking at, for an answer that says both.
 * Absent (`undefined`) when the call came through no route that resolves places.
 */
export interface Placed {
  here: Here | null
  looking: Looking | null
  unrecorded?: Unrecorded | null
}

/** What one registered program is, as far as a sweep could tell. */
export interface Sighting {
  id: string
  name: string | null
  condition: string
  /** The module's own one line of what it is, when its manifest has one. */
  summary?: string
  /** What the module says its presence obliges an agent to do, when it says. */
  guidance?: string
  /** Which scopes it can show (protocol 2.9.0): `project` is "All epics". Absent is one epic at a time. */
  scopes?: readonly ('epic' | 'project')[]
  /**
   * The scopes it can work at, one mode each, its default first (protocol 2.29.0), with what it
   * shows at each. Read through `scopeOfContainer`; absent is one epic.
   */
  modes?: readonly { id?: string; scope?: unknown; scopeSays?: unknown }[]
  /**
   * It and this Kehikot do not fit (protocol 2.22.0, `fitOf`), in the
   * protocol's words: "Monitor needs a newer Kehikot. It uses the call log,
   * added in protocol 2.20." The container shows that in place of its page.
   */
  fit?: string
  /**
   * The manifest as the sweep last read it, for the connections between the modules on a kehikko
   * (`src/host/connections.ts`). Absent for a module that is not answering.
   */
  manifest?: ConnectionModule
}

/**
 * What the door needs from the rest of the host, handed in rather than reached for.
 *
 * The database, a way to say which kehikko is open, two ways to wake the
 * page, and a way to find out which modules are actually answering. Passed as
 * an object so that every one of these is a thing a test can supply — the
 * argument checking and the kehikko lookup are the two halves most likely to
 * be got wrong, and neither should need a browser or a running module to
 * exercise.
 */
export interface Door {
  db: Database
  /** Messages between agent sessions (protocol 2.95.0): the desk and the modules that deliver. `doorMessages.ts`. */
  messaging?: DoorMessageDeps
  /** Which kehikko a call that named none means. See `open.ts`. */
  which(): WhichKehikko
  /**
   * Say that a kehikko has changed under the page. See `wake.ts`. With a
   * note when what changed is a fold, so the page can say who made it.
   */
  wake(kehikko: number, folded?: FoldNote, arranged?: ArrangeNote): void
  /**
   * Whether the person has a hand in this kehikko's arrangement right now — a drag or a resize, or
   * what it left not yet stored (`server/arranging.ts`). `arrange_modules` is refused while it does.
   * Absent: nobody is known to be arranging.
   */
  arranging?(kehikko: number): boolean
  /**
   * When each caller's recent `arrange_modules` changes were made, for the pace it keeps
   * (`ARRANGE_PER_MINUTE`). The server hands every request the one map it made at start (`doorPaces`
   * in `paces.ts`). Absent: nothing is remembered between calls, so nothing is paced.
   */
  arranges?: Map<string, number[]>
  /**
   * Every kehikko some page of this host has open — `every` in `open.ts`.
   * `fold_modules` acts only on one of these. Absent, the one `which` names
   * is the only kehikko known to be open.
   */
  watched?(): number[]
  /** Say that a project's epics are not what the page last read. See `wake.ts`. */
  epicsChanged(project: number): void
  /** The door wrote this epic: every container showing it reads it again. See `server/content.ts`. */
  epicWritten?(project: number, slug: string): void
  /** A project's dispositions file changed; see `dispositionsChanged` in `wake.ts`. */
  dispositionsChanged(project: number): void
  /** Every registered module and whether it is answering, from a sweep. */
  seen(): Promise<Sighting[]>
  /**
   * What the containers on a kehikko have declared for their headers, and a
   * way to have one item pressed — both through a page that has that kehikko
   * open, which is the only place a module's frame is. See `headers.ts`.
   *
   * `on` is `null` when no listening page has the kehikko open. `press`
   * resolves to `null` when the page went away before it could be asked.
   */
  headers?: {
    on(kehikko: number): ReadonlyMap<string, readonly HeaderItem[]> | null
    /** What the containers declared for their footers (protocol 2.38.0), as `on` says their headers. */
    footers?(kehikko: number): ReadonlyMap<string, readonly FooterItem[]> | null
    press(kehikko: number, module: string, press: Pressing): Promise<Pressed | null>
    /**
     * Where in a change's code somebody is pointing on a kehikko (protocol
     * 2.13.0), as the page that has it open last said: `null` for nobody,
     * `undefined` when no listening page has it open.
     */
    location?(kehikko: number): SharedLocation | null | undefined
    /**
     * The last web address handed to a kehikko (protocol 2.16.0), as the page
     * that has it open last said: `null` for none, `undefined` when no
     * listening page has it open.
     */
    address?(kehikko: number): SharedAddress | null | undefined
    /**
     * An agent's `open_address`, made by the page that has the kehikko open —
     * into a container that shows pages, and nowhere else. `null` when no
     * listening page has it open.
     */
    openAddress?(kehikko: number, url: string, title?: string): Promise<Pressed | null>
    /**
     * An agent's `jump`, carried out by the page that has `kehikko` — the one
     * on screen — open, which says what came of it and who followed a step.
     * `null` when no listening page has it open. See `src/host/jump.ts`.
     */
    jump?(kehikko: number, ask: { project?: number; kehikko?: string; epic?: string; parts?: string[]; step?: number; title?: string }): Promise<Came | null>
  }
  /**
   * When an agent last jumped the view (key 0), for the pace `jump` keeps. The server hands every
   * request the one map it made at start (`doorPaces` in `paces.ts`). Absent: nothing is remembered
   * between calls, so nothing is paced.
   */
  jumps?: Map<number, number>
  /** One line for the host log. Absent: `console.info`. */
  log?(line: string): void
  /** Say that a project's Inbox is not what the pages last read: `offer_jump` filed an offer there. */
  inboxChanged?(project: number, rev: number): void
  /** The clock `jump`'s pace reads. Absent: `Date.now`. */
  now?(): number
  /**
   * The Inbox: what the modules said they are doing, and what happened while
   * nobody was looking. Read-only here. See `server/inbox.ts`.
   */
  inbox?: Inbox
  /**
   * An agent's proposal for adopting a tracker item no epic names (`propose_adoption`, protocol 2.88.0):
   * it fills the person's dialog and adopts nothing (`adoption.ts`). Absent: the tool says so.
   */
  adoption?: { propose(project: number, ref: string, proposal: { epic: string; parts: string[]; conversations: string[]; why: string }): { ok: true; said: string } | { ok: false; why: string } }
  /**
   * Messages between agent sessions (protocol 2.41.0): only how many a project
   * keeps, for `my_place`. No tool here reads, sends, deletes or clears one —
   * an agent reads its own through the module that runs it.
   */
  messages?: Pick<AgentMessages, 'count'>
  /**
   * The storage overview, for `storage`: every project's `.kehikot/` by module
   * and this machine's Kehikot data. Read-only. See `server/storage.ts`.
   */
  storage?(fresh: boolean): Promise<StorageReport>
  /**
   * Modules' settings (protocol 2.15.0), for `module_settings`: READ only. A change is the
   * module's, at its own door; nothing here changes one. See `server/moduleSettings.ts`.
   */
  moduleSettings?: {
    list(): Promise<readonly SettingsListed[]>
    read(module: string, project: string | null): Promise<SettingsAnswer>
  }
  /** The shared tracker reading, for `read_tracker`. Absent, the tool says so. */
  trackers?: TrackerDoor
  /** A module's versions and a container's pin, for `module_versions` and `pin_version`. See `pins.ts`. */
  versions?: {
    list(module: string, kehikko: number): Promise<VersionListing | { why: string; status: number }>
    pin(kehikko: number, module: string, version: string | null): Promise<Pinned>
  }
  /**
   * The place this call is in — its token, or its MCP session's binding —
   * resolved by the server (`resolveHere` in `doorPlaces.ts`). Absent or null:
   * the call has none, and every tool answers about the open kehikko as before.
   */
  here?: Here | null
  /** A token the call carried whose record could not be read, and why. */
  unrecorded?: Unrecorded | null
  /** This call settled the connection in `here`, with nobody asked (`settle` in placeRoutes.ts): its answer says so. */
  settled?: boolean
  /** The MCP session the call carried (`Mcp-Session-Id`), when the door gave it one. */
  session?: string | null
  /** Sessions and places: what `my_place` and `set_my_place` need. See `doorPlaces.ts`. */
  places?: {
    /** A new MCP session, for `initialize`. `client` is what the client calls itself. */
    open(client: string): string
    /** Bind the session to a place in a project; the answer says what was bound. */
    bind(session: string, project: Project, place: { epic: string | null; parts: string[]; kehikko: string | null; space?: string[] | null }): Here | null
  }
}
