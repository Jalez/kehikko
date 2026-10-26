import type { Database } from 'bun:sqlite'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { LIMITS, MODULE_ID, PART_ID, REFRESH_EVERY_MAX } from 'kehikot-module-protocol'
import { z } from 'zod'

import {
  createCanvas,
  dropCanvas,
  editCanvas,
  listCanvases,
  orderCanvases,
  readSubject,
  setSubject,
  type Canvas,
  type Placement,
  type PlacementInput,
  type Subject,
} from './canvases.ts'
import { partIdsIn } from '../src/host/parts.ts'
import { listProjects, projectById } from './projects.ts'
import { makeUnderRoot, projectRootExists, sayMissing } from './projectRoot.ts'
import { isVersionTag, TAG_MAX } from './versions.ts'
import { hostPath } from './hostData.ts'
import { laid, redrawn } from '../src/host/columns.ts'
import { CANVAS_ROWS, ROWS_BEFORE } from '../src/host/fit.ts'
import { AT_REST, containerView, readView, viewOf, writeView, type ContainerView, type View } from './view.ts'

/**
 * A project's kehikot, as a file in the project — the copy that travels.
 *
 * ## What this is for
 *
 * The ask was one sentence: *"Can we save the kehikko with its layout etc in
 * .kehikot folder so that if we do want to open the same kehikko in another
 * computer it's not a hassle to do?"* Everything in `canvases.ts` lives in
 * the machine's `frame.sqlite` (`machineDirs.ts`), which is one file on one machine, and a layout a
 * person spent an afternoon on is stranded there. Every module already keeps
 * its material for a project under `<project>/.kehikot/<module>/`, and the
 * user has been emphatic that everything Kehikot keeps about a project goes in
 * that folder, under the thing it belongs to. A kehikko is about a project. So
 * it goes there too.
 *
 * ## The file is the record, and the database is a cache of it
 *
 * Three shapes were possible, and this is the one chosen, so it is written down
 * with the reasons.
 *
 * *The database is the record and the file is an export* — buttons. That is the
 * hassle the ask was about, spelled as a feature: a layout is only as portable
 * as the last time somebody remembered to press export.
 *
 * *Both are records, with a rule for who wins* — is this design with the rule
 * left unstated, and an unstated rule is the class of bug this workspace keeps
 * getting bitten by: two halves that quietly disagree and nothing that raises
 * an error.
 *
 * *The file is the record* — chosen. It is read every time the page asks for
 * the canvases, and written after every change. That makes git the way a
 * kehikko moves between computers, which is right, because the file sits in a
 * repository the person already versions: commit on one machine, pull on the
 * other, and the kehikko is there. It also makes the sqlite file what it
 * always should have been — this machine's fast copy of something, rather than
 * the only place a person's arrangement exists.
 *
 * The cost is stated rather than hidden. If the file and the database
 * disagree, THE FILE WINS, and the database row is changed to match — a
 * kehikko not in the file is deleted from the database. That is what "the
 * record" means; a record that lost arguments would not be one. A `git
 * checkout` of an older commit therefore rolls the layout back, and a `git
 * pull` from the other machine brings its edits in, and the history is where
 * the previous state went. The two exceptions are below, under "when the file
 * is not there" and "when it will not read".
 *
 * ## What travels and what does not
 *
 * Read this before adding a column anywhere. Every field of `Canvas` and
 * `Placement` is on exactly one of these lists, and `PORTABLE_PLACEMENT_FIELDS`
 * and `PORTABLE_CANVAS_FIELDS` below are checked against the types at compile
 * time and against the database in `test/kehikot.test.ts` — so adding a column
 * without saying which side it is on fails the build, which is the point.
 *
 * PORTABLE — in the file, because it is a fact about the arrangement:
 *
 *   - A kehikko's `key` (its identity — see `Canvas.key`) and `name`.
 *   - Every placement's LAYOUT: `module` (stored as `i` — the grid library's
 *     word — and written here under a name a person can read), `x`, `y`, `w`,
 *     `h`, `grow`, `pinned`, `prompt`, `promptFor`, `wish`, `refreshEvery`
 *     and `version`. A module id is the one thing about a module that IS the
 *     same on every machine, so a container keyed by it means the same thing
 *     there as here.
 *   - The order of the kehikot within the project, as the order of the list.
 *
 * PERSONAL — in `view.json` beside it (`server/view.ts`), which the host
 * folder's `.gitignore` keeps out of git, because it is what ONE person is
 * looking at rather than how the project is arranged:
 *
 *   - What the project is about for them: its `epic`, `scope` ("All epics"),
 *     `parts` and `selection` — see `Subject` in `canvases.ts`. Two people on
 *     one project are on two epics, and a pull must not move either.
 *   - Per container: `collapsed`, `selected` and `filters`. A fold, a tick or
 *     a filter is a gesture, not an arrangement; shared, it was a line in a
 *     diff and one person's afternoon written over another's.
 *
 * Folding is the one personal fact that moves the layout's numbers: a folded
 * container is drawn one row tall and everything under it moves up. So the
 * file is written as if nothing were folded (`shared`, below) — a fold
 * changes `view.json` and nothing here — and read back through the person's
 * own folds (`drawn`).
 *
 * LOCAL — in the database only, because it names something on this machine:
 *
 *   - `Canvas.id` and every other integer row id. Autoincrements; a different
 *     machine has handed the same numbers to different things.
 *   - `Canvas.project`, the foreign key. The file is IN the project, so the
 *     project is the folder it was read from, and a number for it would be
 *     wrong on arrival.
 *   - `projects.path`, module URLs, ports and directories — every one of them
 *     is a fact about where something is on this disk.
 *   - `module_state`: a module's own opaque blob, keyed by module and by
 *     nothing else, which the host is forbidden to read. It is not about a
 *     project, so it does not belong in a project's file; a module that wants
 *     per-project material writes its own file under `.kehikot/<module>/`,
 *     which is what every module that has any already does.
 *   - `known_modules`: what a module called itself the last time this machine
 *     saw it. A cache of names, refilled by the next sweep. Carrying it would
 *     mean this host stating a name for a program it has never met.
 *
 * ## Where the file goes
 *
 * `<project>/.kehikot/host/kehikot.json`, through `hostPath` (`hostData.ts`, over the protocol's `hostFile`) — the host's
 * folder by the protocol's own spelling, so
 * no second convention had to be invented and no code here joins a path by
 * hand. A folder of its own rather than a file at the root of `.kehikot`,
 * because the convention is that a folder in there is owned by the program
 * named on it: somebody listing `.kehikot/` sees `checklist/ notes/ paper/
 * host/` and knows what each is and who to ask, and `rm -r
 * .kehikot/host` removes exactly the host's material and nothing else's. A
 * loose file at the root would be the one thing in that folder with no owner.
 *
 * ## When the file is not there
 *
 * If the project has kehikot in the database and no file, the file is written
 * from them. That is the migration — every project on every machine that ran
 * this host before the file existed — and it is also what happens if the file
 * is deleted while the host is running: the cache is the only record left, so
 * it becomes the record again. Deleting the file is therefore not a way to
 * delete the kehikot; the way to do that is the button, and the file follows.
 *
 * ## When it will not read
 *
 * A file a person may edit by hand is a file that will one day not parse — a
 * merge conflict left in it, a comma dropped, a field misspelt. Then:
 *
 *   - The database is left exactly as it was, and the page works from it.
 *   - The file is NOT written, however many changes are made, until it reads
 *     again. Writing over a half-edited file would destroy the edit that was
 *     in progress, and writing over a merge conflict would be resolving it by
 *     picking whichever side this machine happened to hold.
 *   - The page is told, in a sentence naming the file and the fault, on every
 *     load until it is fixed — so changes made meanwhile are made knowing that
 *     the file will win again the moment it reads.
 *
 * ## What a missing module does to the file: nothing
 *
 * The other machine will not have every module registered. A container for
 * `kehikot.paper` read on a machine that has never heard of `kehikot.paper`
 * stays in the database, stays in the file, and is drawn on the canvas as a
 * container that says which module is missing. The page used to take such
 * containers OFF and write the arrangement back without them — right when the
 * only way a registration could be missing was somebody deleting it, and wrong
 * now that the arrangement is shared between machines: a read on machine B
 * followed by any write would have deleted machine A's containers from the
 * file, and B would have pushed that. See the essay on `everyKept` in
 * `src/App.tsx`.
 *
 * ## Whether it travels at all is the project's decision
 *
 * A project whose `.gitignore` ignores `.kehikot/` still gets the file — it is
 * the record on this machine either way — but the file will not go anywhere.
 * That is said in the projects menu, beside the setting that changes it, and
 * this host does not touch the `.gitignore` to make the file travel: a program
 * changing that file behind somebody's back is a bug this workspace has had
 * once already.
 *
 * ## The shape of the file, and the ones it replaced
 *
 * Version 2, and it stays version 2. Version 1 had an epic and a selection on
 * every kehikko, which is how switching kehikko used to switch the epic; a
 * version-1 file still reads, and is written back as version 2 straight away.
 *
 * ## And the rows it counts in, said at the top
 *
 * `"rows": 56`, beside the version. A canvas was twenty-eight rows tall and is
 * fifty-six (`fit.ts`), and a file's `y`, `h` and `wish` are counts of rows, so
 * a file has to say which rows. Absent — every file written before — means
 * twenty-eight, and such a file is read doubled (`inRows`), which draws every
 * container exactly where it drew. It is NOT written back on the read —
 * opening a project makes no diff in it — but in fifty-sixths, saying so, on
 * the first change anybody makes, like the legacy personal fields below.
 *
 * This is the one addition here that an older host cannot read, and that is
 * the point of it. A host from before the finer rows reading fifty-sixths as
 * twenty-eighths would draw every container twice as tall, clipped at the
 * bottom, and write what it drew over the file on its next drag — a teammate's
 * layout destroyed by opening it. Its schema is strict, so it refuses the file
 * instead, with its own sentence ("the top level has a field this host does
 * not know (rows) — is the file from a newer Kehikot?"), keeps working from its
 * own database, and never writes the file until it reads again (see "When it
 * will not read"); updating it is the fix. A field rather than version 3
 * because that sentence is the right one, where a version would be refused as
 * "Invalid literal value, expected 2" — and because the next change to the
 * count is a different number here, not another shape. A file in more rows
 * than this host has, which only a newer host could write, is refused with a
 * sentence that says so (`parse`).
 *
 * Until the split into `view.json`, version 2 also carried the project's
 * `epic`, `scope`, `parts` and `selection` at the top and `collapsed`,
 * `selected` and `filters` on every container. They are no longer written —
 * and the version is NOT bumped, deliberately. Every host before the split
 * reads with `version: z.literal(2)` and a strict schema in which each of
 * those fields has a default; a file without them is one it reads, as the
 * whole epic with nothing folded. A version 3 would have been refused by
 * every one of them with a sentence, and the layout would have stopped
 * travelling to anybody who had not updated.
 *
 * Read, they are still accepted — a file written before the split, or by an
 * older host on a teammate's machine — as LEGACY personal fields
 * (`Parsed.legacy`). They are used only when there is no `view.json` yet: that
 * is the migration, and on the first write after it the shared file is
 * written without them. With a `view.json`, they are ignored.
 *
 * Indented JSON with a fixed key order and a trailing newline, and every
 * container on ONE line, so that a moved container is one changed line in a
 * diff and a person can read the arrangement down the page. Containers are in
 * module-id order, which is the order the database hands them over in, so a
 * drag never reorders lines. The file is meant to be read, diffed and merged by
 * a person; nothing about it is a serialisation format for machines first.
 */

/** The host's own id, which is what its folder under `.kehikot/` is named for. */
export const HOST_ID = 'kehikko'

/** The one file, and its name is a constant here for the reason `moduleFile()` insists on one. */
const FILE_NAME = 'kehikot'

/** What is written at the top of the file, so a reader — or a later version — knows which shape this is. */
const VERSION = 2

/**
 * A file's kehikko in the rows a canvas has now. Exact, because `rows` is
 * held to a divisor of `CANVAS_ROWS` by the schema; only the vertical numbers,
 * since columns did not change.
 */
function inRows<K extends { containers: FileContainer[] }>(kehikko: K, rows: number): K {
  if (rows === CANVAS_ROWS) return kehikko
  const by = CANVAS_ROWS / rows
  return {
    ...kehikko,
    containers: kehikko.containers.map((c) => ({
      ...c,
      y: c.y * by,
      h: c.h * by,
      wish: c.wish === null ? null : c.wish * by,
      ...(c.openH === undefined || c.openH === null ? {} : { openH: c.openH * by }),
    })),
  }
}

/* What `rows` may say: a count this host can draw exactly — the old one, or its own. */
const rowsSchema = z
  .number()
  .int()
  .refine((rows) => rows === ROWS_BEFORE || rows === CANVAS_ROWS, `is not ${ROWS_BEFORE} or ${CANVAS_ROWS}, the rows a canvas has been`)
  .optional()

/**
 * Every field of a placement that goes in the shared file — the layout.
 *
 * Listed by hand rather than taken from `Object.keys`, because the point of the
 * list is to be something a person adding a column has to edit. The type below
 * it is what makes forgetting impossible: a `Placement` field on neither this
 * list nor `PERSONAL_PLACEMENT_FIELDS` makes `everyPlacementFieldIsPlaced`
 * fail to typecheck, with the field's name in the error.
 */
export const PORTABLE_PLACEMENT_FIELDS = [
  'i',
  'x',
  'y',
  'w',
  'h',
  'grow',
  'pinned',
  'prompt',
  'promptFor',
  'wish',
  'refreshEvery',
  'version',
] as const satisfies readonly (keyof Placement)[]

/** And the ones that are one person's, written to `view.json` (`server/view.ts`). */
export const PERSONAL_PLACEMENT_FIELDS = ['collapsed', 'selected', 'filters'] as const satisfies readonly (keyof Placement)[] &
  readonly (keyof ContainerView)[]

type UnplacedPlacementField = Exclude<
  keyof Placement,
  (typeof PORTABLE_PLACEMENT_FIELDS)[number] | (typeof PERSONAL_PLACEMENT_FIELDS)[number]
>
/* If this line stops compiling, a field was added to `Placement` and to
   neither list above. Decide whether it is the layout everybody shares or one
   person's view of it, and add it to that list, its schema and the two
   conversions. */
const everyPlacementFieldIsPlaced: [UnplacedPlacementField] extends [never] ? true : UnplacedPlacementField = true
void everyPlacementFieldIsPlaced

/** The fields of a canvas that go in the file, in the order they are written. */
export const PORTABLE_CANVAS_FIELDS = ['key', 'name'] as const satisfies readonly (keyof Canvas)[]

/**
 * What a project is about — every field of it is personal since the split: it
 * is in `view.json`, and the shared file says nothing about it.
 */
export const PERSONAL_SUBJECT_FIELDS = ['epic', 'scope', 'parts', 'selection'] as const satisfies readonly (keyof Subject)[]

type UntaughtSubjectField = Exclude<keyof Subject, (typeof PERSONAL_SUBJECT_FIELDS)[number]>
/* The same device as the placements': a field added to `Subject` and not to
   the list above stops this line compiling. */
const everySubjectFieldIsPlaced: [UntaughtSubjectField] extends [never] ? true : UntaughtSubjectField = true
void everySubjectFieldIsPlaced

/** And the ones that do not, each named so the split is complete rather than implied. */
export const LOCAL_CANVAS_FIELDS = ['id', 'project'] as const satisfies readonly (keyof Canvas)[]

type UnplacedCanvasField = Exclude<
  keyof Canvas,
  (typeof PORTABLE_CANVAS_FIELDS)[number] | (typeof LOCAL_CANVAS_FIELDS)[number] | 'placements'
>
/* Same device as above, for the canvas itself. A new field on `Canvas` goes on
   one list or the other; `placements` is the containers list and is handled
   whole. */
const everyCanvasFieldIsPlaced: [UnplacedCanvasField] extends [never] ? true : UnplacedCanvasField = true
void everyCanvasFieldIsPlaced

/**
 * What a kehikko may be called in the file. Generated keys are eight hex
 * characters; a person writing one by hand may use a word. Lowercase and dashes
 * only, because this is also compared as an identity and two spellings of one
 * key would be two kehikot.
 */
export const KEY = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/

const NAME_MAX = 60

/**
 * One container, as written. Every field is present in a file this host wrote;
 * the defaults are for a file a person wrote, or trimmed, so that a hand-made
 * container needs only a module and a rectangle.
 *
 * `strict()`, and the strictness is a feature. A field this version does not
 * know is most likely a field a NEWER host added, and dropping it silently
 * would mean this machine rewriting the file without it on the next drag —
 * the other machine's setting gone, with nothing to say so. Refusing to read
 * names the field, and the sentence says what it probably means.
 */
const containerSchema = z
  .object({
    module: z.string().regex(MODULE_ID, 'is not a module id'),
    x: z.number().int(),
    y: z.number().int(),
    w: z.number().int(),
    h: z.number().int(),
    grow: z.boolean().default(false),
    pinned: z.boolean().default(false),
    prompt: z.string().max(LIMITS.PROMPT).default(''),
    promptFor: z.string().regex(MODULE_ID, 'is not a module id').nullable().default(null),
    /* Legacy personal: see "The shape of the file". Absent in a file this
       host writes; read only to move it into `view.json`. */
    collapsed: z.boolean().optional(),
    /* `null` means "the height it has" — a hand-written container, or one
       from a file written before wishes existed. Resolved in `fromContainer`;
       the file this host writes always has a number here. */
    wish: z.number().int().nullable().default(null),
    /* What `wish` was called before it existed for open containers: the
       height a container had when it was folded, or null. Accepted so that a
       file written by the host before `wish` still reads, and read as the wish
       when there is no `wish`. Never written — a file this host writes says
       `wish` — and absent rather than defaulted, so the strict schema still
       refuses a file that carries a field this version has never heard of. */
    openH: z.number().int().nullable().optional(),
    /* Legacy personal, like `collapsed`. */
    selected: z.boolean().optional(),
    /* Legacy personal, like `collapsed`. The bounds are the wire's, half by half: a group id is a `FILTER_ID`, a
       string value may be a typed query and so is a `FILTER_TEXT`, and a list
       is a `toggles` group's set of option ids. An empty list is read rather
       than refused — it is a hand-written "nothing switched on", and the
       placement drops it on the way in, since rest is stored as nothing. */
    filters: z
      .record(
        z.string().min(1).max(LIMITS.FILTER_ID),
        z.union([
          z.string().min(1).max(LIMITS.FILTER_TEXT),
          z.array(z.string().min(1).max(LIMITS.FILTER_ID)).max(LIMITS.FILTER_OPTIONS),
        ]),
      )
      .optional(),
    refreshEvery: z.number().max(REFRESH_EVERY_MAX).nullable().default(null),
    /* Which version the container runs — a semver tag — or absent for latest.
       Written only when the container is pinned, so a file with no pins is
       still one an older host (whose schema is strict) can read. A tag that is
       not semver is refused with the file, like any other malformed field. */
    version: z
      .string()
      .max(TAG_MAX)
      .refine(isVersionTag, 'is not a version tag such as v1.2.0')
      .nullable()
      .optional(),
  })
  .strict()

const epicSchema = z.string().trim().min(1).max(80).nullable().default(null)
const selectionSchema = z.array(z.string().min(1).max(LIMITS.REF)).max(LIMITS.REFS).default([])
/* Part ids, in the shape `partIdsIn` keeps. Optional in the file: absent is
   the whole epic. */
const partsSchema = z.array(z.string().regex(PART_ID, 'is not a part id')).max(LIMITS.PARTS).default([])

const kehikkoFields = {
  key: z.string().regex(KEY, 'is not a key: lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(NAME_MAX),
  containers: z.array(containerSchema).max(64).default([]),
}

/* One container per module, said once for both versions of a kehikko. */
function oncePerModule(kehikko: { containers: { module: string }[] }, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  for (const container of kehikko.containers) {
    if (seen.has(container.module)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['containers'],
        message: `has two containers for ${container.module}; a module is on a kehikko once`,
      })
    }
    seen.add(container.module)
  }
}

const kehikkoSchema = z.object(kehikkoFields).strict().superRefine(oncePerModule)

/* A kehikko as version 1 wrote it, with an epic and a selection of its own.
   Read for the move to version 2 and never written. */
const kehikkoV1Schema = z
  .object({ ...kehikkoFields, epic: epicSchema, selection: selectionSchema })
  .strict()
  .superRefine(oncePerModule)

/* Two kehikot with one key are two claims to be one kehikko, in either version. */
function keysOnce(file: { kehikot: { key: string }[] }, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  for (const kehikko of file.kehikot) {
    if (seen.has(kehikko.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kehikot'],
        message: `two kehikot share the key "${kehikko.key}"; a key is what tells them apart, so give one a new one`,
      })
    }
    seen.add(kehikko.key)
  }
}

const fileSchema = z
  .object({
    version: z.literal(VERSION),
    /* The rows the containers are counted in; absent is the old 28. */
    rows: rowsSchema,
    /* The four legacy personal fields — read, never written. See "The shape
       of the file". Absent is "this file says nothing about it". */
    epic: epicSchema.optional(),
    scope: z.enum(['epic', 'project']).optional(),
    parts: partsSchema.optional(),
    selection: selectionSchema.optional(),
    kehikot: z.array(kehikkoSchema).max(500),
  })
  .strict()
  .superRefine(keysOnce)

const fileV1Schema = z
  .object({
    version: z.literal(1),
    kehikot: z.array(kehikkoV1Schema).max(500),
  })
  .strict()
  .superRefine(keysOnce)

type FileKehikko = z.infer<typeof kehikkoSchema>
type FileContainer = z.infer<typeof containerSchema>

/** The file for a project, or null when there is no project path to put it under. */
export function kehikotFile(projectPath: string | null | undefined): string | null {
  return hostPath(projectPath, `${FILE_NAME}.json`)
}

/** A placement's layout, in the order and under the names the file uses. Nothing personal. */
function toContainer(p: Placement): FileContainer {
  return {
    module: p.i,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    grow: p.grow,
    pinned: p.pinned,
    prompt: p.prompt,
    promptFor: p.promptFor,
    wish: p.wish,
    refreshEvery: p.refreshEvery,
    ...(p.version ? { version: p.version } : {}),
  }
}

/**
 * A container as it arrives from the file, with how this person looks at it,
 * made into what `editCanvas` takes.
 *
 * Bounds are NOT applied here. `editCanvas` runs everything through `cleaned`,
 * which is the one place a placement is bounded on the way into the database —
 * a file that says `h: 9000` gets the same treatment a page that says it would,
 * and there is no second, weaker copy of that rule here to drift.
 */
function fromContainer(c: FileContainer, view: ContainerView = AT_REST): PlacementInput {
  return {
    i: c.module,
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    grow: c.grow,
    pinned: c.pinned,
    prompt: c.prompt,
    promptFor: c.promptFor,
    collapsed: view.collapsed,
    /* A file from before `wish` said `openH` for a folded container and
       nothing for an open one; either way the fallback is the height it has,
       which `cleaned` supplies for a `null`. */
    wish: c.wish ?? c.openH ?? c.h,
    selected: view.selected,
    filters: view.filters,
    refreshEvery: c.refreshEvery,
    version: c.version ?? null,
  }
}

/**
 * The placements as the shared file has them: as if nothing were folded.
 *
 * A fold is personal, but it moves numbers that are not — the folded
 * container's `h`, and the `y` of everything under it. Written as drawn, one
 * person's fold would be several changed lines in everybody's diff and their
 * teammates would open a container squashed to one row and not folded. So the
 * layout is written unfolded: every height the column grants the wishes
 * (`redrawn`) and every top edge where the grid would put it (`laid`), the
 * same rule a fold at the host's door uses. An arrangement with nothing
 * folded is written exactly as it is.
 */
export function shared<T extends Placement>(placements: readonly T[]): T[] {
  if (!placements.some((p) => p.collapsed)) return [...placements]
  return laid(redrawn(placements.map((p) => (p.collapsed ? { ...p, collapsed: false } : p))))
}

/**
 * And back: the layout drawn through this person's folds — the folded ones at
 * one row, their column-mates at what their wishes are now granted.
 */
function drawn(placements: Placement[]): Placement[] {
  if (!placements.some((p) => p.collapsed)) return placements
  return laid(redrawn(placements))
}

const NO_SUBJECT: Subject = { epic: null, parts: [], selection: [] }

/**
 * The text of the shared file for these kehikot — the same bytes for the same
 * layout, every time, and the same bytes whatever anybody has folded, ticked,
 * filtered or opened.
 *
 * Not `JSON.stringify(_, null, 2)` on the whole thing, because that puts every
 * container across fifteen lines and a drag becomes a fifteen-line hunk in
 * which two numbers changed. Each container is one line; everything above it
 * is indented normally. Both halves are still `JSON.stringify`, so the result
 * is JSON and nothing here escapes a string by hand.
 */
export function serialize(canvases: readonly Canvas[]): string {
  const lines: string[] = ['{', `  "version": ${VERSION},`, `  "rows": ${CANVAS_ROWS},`, '  "kehikot": [']
  canvases.forEach((canvas, index) => {
    const containers = shared(canvas.placements).map(toContainer)
    lines.push('    {')
    lines.push(`      "key": ${JSON.stringify(canvas.key)},`)
    lines.push(`      "name": ${JSON.stringify(canvas.name)},`)
    if (containers.length === 0) {
      lines.push('      "containers": []')
    } else {
      lines.push('      "containers": [')
      containers.forEach((container, i) => {
        lines.push(`        ${JSON.stringify(container)}${i < containers.length - 1 ? ',' : ''}`)
      })
      lines.push('      ]')
    }
    lines.push(`    }${index < canvases.length - 1 ? ',' : ''}`)
  })
  lines.push('  ]', '}')
  return `${lines.join('\n')}\n`
}

export type Parsed =
  | {
      ok: true
      /** The layout. Every container's personal fields are at rest here; they are in `legacy` or `view.json`. */
      kehikot: FileKehikko[]
      /**
       * The personal fields the file still carries — written before the split,
       * or by an older host — or null when it carries none. Used only when
       * the project has no `view.json` yet.
       */
      legacy: View | null
      /** The file is version 1 and should be written again as the current shape. */
      older: boolean
    }
  | { ok: false; why: string }

/** The legacy subject, from the top of a version 2 file, as the file said it before the split. */
function subjectFrom(d: { epic?: string | null; scope?: 'epic' | 'project'; parts?: string[]; selection?: string[] }): Subject {
  /* "All epics" holds no one epic and no parts, whatever else the file says;
     no epic has no parts — `setSubject`'s rule, applied to a file somebody
     may have edited by hand. */
  if (d.scope === 'project') return { epic: null, scope: 'project', parts: [], selection: d.selection ?? [] }
  const epic = d.epic ?? null
  return { epic, parts: epic === null ? [] : partIdsIn(d.parts ?? []), selection: d.selection ?? [] }
}

/** The legacy per-container fields of a file's kehikot, by key and module. */
function containersFrom(kehikot: { key: string; containers: FileContainer[] }[]): View['kehikot'] {
  return new Map(
    kehikot.map((k) => [
      k.key,
      new Map(
        k.containers.map((c) => [
          c.module,
          { collapsed: c.collapsed ?? false, selected: c.selected ?? false, filters: c.filters ?? {} },
        ]),
      ),
    ]),
  )
}

/** Does this file say anything personal at all? A file this host wrote since the split does not. */
function carriesPersonal(d: z.infer<typeof fileSchema>): boolean {
  if (d.epic !== undefined || d.scope !== undefined || d.parts !== undefined || d.selection !== undefined) return true
  return d.kehikot.some((k) =>
    k.containers.some((c) => c.collapsed !== undefined || c.selected !== undefined || c.filters !== undefined),
  )
}

/** A file kehikko with its legacy personal fields taken off. */
function layoutOf<K extends { containers: FileContainer[] }>(kehikko: K): K {
  return {
    ...kehikko,
    containers: kehikko.containers.map(({ collapsed: _c, selected: _s, filters: _f, ...layout }) => layout),
  }
}

/**
 * The file's text, read into kehikot — or one sentence about why it could not
 * be.
 *
 * The sentence is the whole of the error handling and it is aimed at the
 * person who edited the file. A zod issue carries a path and a message; both
 * are put into words a person can act on, and only the first few, because a
 * file with forty faults has one cause.
 */
export function parse(text: string): Parsed {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, why: `it is not JSON (${(error as Error).message})` }
  }
  /*
   * Version 1, read for the move and not otherwise. The project's epic is its
   * first kehikko's that had one, in the file's order — the order of the
   * dropdown — and that kehikko's selection with it, since the refs were picked
   * out of that epic. Which kehikko the person was last on is a browser's
   * memory, not the file's; see `hintSubject` in `canvases.ts`.
   */
  const version = (raw as { version?: unknown } | null)?.version
  if (version === 1) {
    const old = fileV1Schema.safeParse(raw)
    if (old.success) {
      const first = old.data.kehikot.find((k) => k.epic !== null)
      const kehikot = old.data.kehikot.map(({ epic: _epic, selection: _selection, ...kehikko }) => kehikko)
      return {
        ok: true,
        /* Version 1 is from before the finer rows: twenty-eighths. */
        kehikot: kehikot.map(layoutOf).map((k) => inRows(k, ROWS_BEFORE)),
        legacy: {
          /* Version 1 is from before parts: the whole epic. */
          subject: first ? { epic: first.epic, parts: [], selection: first.selection } : NO_SUBJECT,
          kehikot: containersFrom(kehikot),
        },
        older: true,
      }
    }
    return { ok: false, why: said(old.error) }
  }
  /* In rows finer than this host's, which only a newer host writes: refused
     in words, since the schema's own sentence would be about a number. */
  const rows = (raw as { rows?: unknown } | null)?.rows
  if (typeof rows === 'number' && Number.isInteger(rows) && rows > CANVAS_ROWS) {
    return {
      ok: false,
      why: `its containers are counted in ${rows} rows, which a newer Kehikot writes; this one has ${CANVAS_ROWS}, so update it to open this file`,
    }
  }

  const read = fileSchema.safeParse(raw)
  if (read.success) {
    /* Absent is every file written before the finer rows: twenty-eighths. */
    const counted = read.data.rows ?? ROWS_BEFORE
    return {
      ok: true,
      kehikot: read.data.kehikot.map(layoutOf).map((k) => inRows(k, counted)),
      legacy: carriesPersonal(read.data)
        ? { subject: subjectFrom(read.data), kehikot: containersFrom(read.data.kehikot) }
        : null,
      older: false,
    }
  }
  return { ok: false, why: said(read.error) }
}

/** A refusal, in words the person who edited the file can act on. */
function said(error: z.ZodError): string {
  const words = error.issues.slice(0, 3).map((issue) => {
    const at = issue.path.length ? issue.path.map(String).join('.') : 'the top level'
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return `${at} has a field this host does not know (${issue.keys.join(', ')}) — is the file from a newer Kehikot?`
    }
    return `${at} ${issue.message}`
  })
  return words.join('; ')
}

/**
 * The files this host has refused to write because they would not read, with
 * the reason. Keyed by path; cleared the moment a read succeeds. In memory,
 * because the reason is re-derived on every read anyway — this only has to
 * outlast the gap between a read and the next write.
 */
const refused = new Map<string, string>()

/** Why a project's file is not being written, or null when it is. */
export function refusal(projectPath: string): string | null {
  const file = kehikotFile(projectPath)
  return file === null ? null : (refused.get(file) ?? null)
}

/**
 * Write a project's kehikot to its two files, after something changed: the
 * layout to `kehikot.json`, the person's view of it to `view.json`.
 *
 * Called by whatever changed them; the database was already written and this
 * makes the files agree. Nothing is written when nothing would change, so a
 * drag that ends where it started does not touch a file git is watching — and
 * a fold, a tick, a filter or another epic changes only `view.json`, which git
 * is not watching. Nothing is written to `kehikot.json` while it is refused —
 * see the essay; the view is still kept.
 *
 * Each write is a rename over the old file, so a crash mid-write leaves the
 * previous file whole rather than a truncated one that will not parse.
 */
export function keep(db: Database, projectId: number | null): void {
  if (projectId === null) return
  const project = projectById(db, projectId)
  if (!project) return
  const file = kehikotFile(project.path)
  if (file === null) return

  const mine = listCanvases(db).filter((canvas) => canvas.project === projectId)
  const subject = readSubject(db, projectId) ?? NO_SUBJECT
  /* The view first: a refused layout file is no reason to lose a fold. Never
     into a project folder that is not there. */
  if (projectRootExists(project.path)) writeView(project.path, viewOf(mine, subject))
  if (refused.has(file)) return

  const text = serialize(mine)
  let before: string | null = null
  try {
    before = readFileSync(file, 'utf8')
  } catch {
    /* Not there yet. */
  }
  if (before === text) return
  /* Never the project's folder itself: one that was renamed away stays gone. */
  if (!makeUnderRoot(project.path, dirname(file))) return
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

export type Synced =
  | { file: string; outcome: 'read'; changed: boolean }
  | { file: string; outcome: 'written' }
  | { file: string; outcome: 'nothing' }
  | { file: string; outcome: 'refused'; why: string }
  | { file: string; outcome: 'missing' }

/**
 * Make this machine's database agree with a project's files.
 *
 * The three outcomes are the three paragraphs in the essay: the file was read
 * and won; there was no file and one was written from the database; the file
 * would not read and nothing was touched. `nothing` is the fourth, for a
 * project with neither a file nor any kehikot — the state a project is in for
 * the instant between being added and `ensureCanvases` giving it one.
 *
 * The personal half comes from `view.json` when there is one. When there is
 * not, it is the legacy fields the shared file still carries (the migration),
 * or else what this machine's database already holds — and `view.json` is
 * written from what was used, so the next read has one.
 */
export function syncProject(db: Database, project: { id: number; path: string }): Synced {
  const file = kehikotFile(project.path)
  if (file === null) return { file: '', outcome: 'nothing' }
  /* The folder is gone — renamed, moved or deleted. Its file is not read and
     certainly not written from the database, which would make the folder again. */
  if (!projectRootExists(project.path)) {
    sayMissing(project.path)
    return { file, outcome: 'missing' }
  }

  let text: string | null = null
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    /* No file. The database is the only record there is, so it becomes the file. */
  }

  if (text === null) {
    refused.delete(file)
    const any = listCanvases(db).some((canvas) => canvas.project === project.id)
    if (!any) return { file, outcome: 'nothing' }
    keep(db, project.id)
    return { file, outcome: 'written' }
  }

  const read = parse(text)
  if (!read.ok) {
    refused.set(file, read.why)
    return { file, outcome: 'refused', why: read.why }
  }
  refused.delete(file)

  const kept = readView(project.path)
  const view: View =
    kept ??
    read.legacy ??
    viewOf(
      listCanvases(db).filter((canvas) => canvas.project === project.id),
      readSubject(db, project.id) ?? NO_SUBJECT,
    )

  /*
   * The file wins. Rows are matched to the file's kehikot by key; a key the
   * file has and the database does not becomes a row, a key the database has
   * and the file does not stops being one, and every matched row is rewritten
   * to say what the file — and the view — say. Done in one transaction,
   * because a sync that stopped between deleting and creating would leave the
   * database agreeing with neither the file nor itself.
   */
  const apply = db.transaction((): boolean => {
    const rows = listCanvases(db).filter((canvas) => canvas.project === project.id)
    const byKey = new Map(rows.map((canvas) => [canvas.key, canvas]))
    const orderBefore = rows.map((canvas) => canvas.id)
    const ids: number[] = []
    let changed = false

    for (const kehikko of read.kehikot) {
      let row = byKey.get(kehikko.key)
      if (row) {
        byKey.delete(kehikko.key)
      } else {
        row = createCanvas(db, kehikko.name, project.id, kehikko.key)
        changed = true
      }
      ids.push(row.id)
      const placements = asPlacements(kehikko, view)
      const wanted = { ...row, name: kehikko.name, placements }
      if (same(row, wanted)) continue
      editCanvas(db, row.id, { name: kehikko.name, placements })
      changed = true
    }
    for (const gone of byKey.values()) {
      dropCanvas(db, gone.id)
      changed = true
    }
    if (orderBefore.length !== ids.length || orderBefore.some((id, i) => id !== ids[i])) {
      orderCanvases(db, ids)
      changed = true
    }
    /* What the project is about for this person, which the view says. Compared
       through `serializeView` for the reason the kehikot are compared through
       `serialize`: bounding on the way in is a difference worth writing. */
    const before = readSubject(db, project.id) ?? NO_SUBJECT
    if (subjectText(before) !== subjectText(view.subject)) {
      setSubject(db, project.id, {
        scope: view.subject.scope ?? 'epic',
        epic: view.subject.epic,
        parts: view.subject.parts,
        selection: view.subject.selection,
      })
      changed = true
    }
    return changed
  })

  const changed = apply()
  /* Read once, and written back as the current shape at once, so the
     per-kehikko epics of version 1 are never written again. */
  if (read.older) keep(db, project.id)
  /* No view yet: write the one just used, so the personal half has its own
     file from now on. The shared file loses its legacy fields on the next
     write — the first change anybody makes — and not before: opening a
     project does not make a diff in it. */
  else if (kept === null) {
    const mine = listCanvases(db).filter((canvas) => canvas.project === project.id)
    writeView(project.path, viewOf(mine, readSubject(db, project.id) ?? NO_SUBJECT))
  }
  return { file, outcome: 'read', changed }
}

/**
 * A file kehikko as placements, with the view's personal half on each and
 * drawn through its folds.
 */
function asPlacements(kehikko: FileKehikko, view: View): Placement[] {
  return drawn(
    kehikko.containers.map((c) => fromContainer(c, containerView(view, kehikko.key, c.module)) as Placement),
  )
}

/**
 * Would the files say anything different? The comparison goes through
 * `serialize` and the view's own text so that it is exactly that question —
 * and so that bounding on the way in (a file's `h: 9000` becoming 400) shows
 * up as a difference and gets written, rather than the two sides silently
 * agreeing to disagree.
 */
function same(row: Canvas, wanted: Canvas): boolean {
  if (serialize([row]) !== serialize([wanted])) return false
  const personal = (canvas: Canvas) =>
    JSON.stringify(canvas.placements.map((p) => [p.i, p.collapsed, p.selected, p.filters]))
  return personal(row) === personal(wanted)
}

function subjectText(subject: Subject): string {
  return JSON.stringify([subject.scope ?? 'epic', subject.epic, subject.parts, subject.selection])
}

/**
 * Every project's file, read — and the sentences for the ones that would not.
 *
 * Run at startup and on every load of the canvases. A handful of small files
 * on a local disk, and the cost of not doing it is a `git pull` that changed
 * the layout being invisible until the host is restarted.
 */
export function syncEvery(db: Database): string[] {
  const trouble: string[] = []
  for (const project of listProjects(db)) {
    /* Gone since it was added: said once in the terminal, never read, never written. */
    if (project.missing) {
      sayMissing(project.path)
      continue
    }
    const synced = syncProject(db, project)
    if (synced.outcome === 'refused') {
      trouble.push(
        `${synced.file} could not be read: ${synced.why}. Changes to ${project.name}'s kehikot are kept on this computer only until it is fixed, and then the file wins.`,
      )
    }
  }
  return trouble
}
