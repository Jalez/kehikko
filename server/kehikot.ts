import type { Database } from 'bun:sqlite'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { LIMITS, MODULE_ID, REFRESH_EVERY_MAX, moduleFile } from 'roadmap-module-protocol'
import { z } from 'zod'

import {
  createCanvas,
  dropCanvas,
  editCanvas,
  listCanvases,
  orderCanvases,
  type Canvas,
  type Placement,
  type PlacementInput,
} from './canvases.ts'
import { listProjects, projectById } from './projects.ts'

/**
 * A project's kehikot, as a file in the project — the copy that travels.
 *
 * ## What this is for
 *
 * The ask was one sentence: *"Can we save the kehikko with its layout etc in
 * .kehikot folder so that if we do want to open the same kehikko in another
 * computer it's not a hassle to do?"* Everything in `canvases.ts` lives in
 * `~/.roadmap/frame.sqlite`, which is one file on one machine, and a layout a
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
 *   - A kehikko's `key` (its identity — see `Canvas.key`), `name`, `epic` and
 *     `selection` (refs are names for things in the project's trackers, which
 *     are the same trackers on the other machine).
 *   - Every placement, whole: `module` (stored as `i` — the grid library's
 *     word — and written here under a name a person can read), `x`, `y`, `w`,
 *     `h`, `grow`, `pinned`, `prompt`, `promptFor`, `collapsed`, `wish`,
 *     `selected`, `filters`, `refreshEvery`. A module id is the one thing about
 *     a module that IS the same on every machine, so a container keyed by it
 *     means the same thing there as here.
 *   - The order of the kehikot within the project, as the order of the list.
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
 * `<project>/.kehikot/kehikko/kehikot.json`, by the protocol's own
 * `moduleFile()` — the host's id is `kehikko`, which is a legal module id, so
 * no second convention had to be invented and no code here joins a path by
 * hand. A folder of its own rather than a file at the root of `.kehikot`,
 * because the convention is that a folder in there is owned by the program
 * named on it: somebody listing `.kehikot/` sees `checklist/ notes/ paper/
 * kehikko/` and knows what each is and who to ask, and `rm -r
 * .kehikot/kehikko` removes exactly the host's material and nothing else's. A
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
 * `roadmap.paper` read on a machine that has never heard of `roadmap.paper`
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
 * ## The shape of the file
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
const VERSION = 1

/**
 * Every field of a placement that goes in the file — which is every field.
 *
 * Listed by hand rather than taken from `Object.keys`, because the point of the
 * list is to be something a person adding a column has to edit. The type below
 * it is what makes forgetting impossible: a `Placement` field not in this list
 * makes `everyPlacementFieldTravels` fail to typecheck, with the field's name
 * in the error.
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
  'collapsed',
  'wish',
  'selected',
  'filters',
  'refreshEvery',
] as const satisfies readonly (keyof Placement)[]

type UntaughtPlacementField = Exclude<keyof Placement, (typeof PORTABLE_PLACEMENT_FIELDS)[number]>
/* If this line stops compiling, a field was added to `Placement` and not to the
   list above. Decide whether it travels — it almost certainly does — and add it
   to the list, the schema, `toContainer` and `fromContainer`. */
const everyPlacementFieldTravels: [UntaughtPlacementField] extends [never] ? true : UntaughtPlacementField = true
void everyPlacementFieldTravels

/** The fields of a canvas that go in the file, in the order they are written. */
export const PORTABLE_CANVAS_FIELDS = ['key', 'name', 'epic', 'selection'] as const satisfies readonly (keyof Canvas)[]

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
    collapsed: z.boolean().default(false),
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
    selected: z.boolean().default(false),
    filters: z.record(z.string().min(1).max(LIMITS.FILTER_ID), z.string().min(1).max(LIMITS.FILTER_ID)).default({}),
    refreshEvery: z.number().max(REFRESH_EVERY_MAX).nullable().default(null),
  })
  .strict()

const kehikkoSchema = z
  .object({
    key: z.string().regex(KEY, 'is not a key: lowercase letters, digits and dashes'),
    name: z.string().trim().min(1).max(NAME_MAX),
    epic: z.string().trim().min(1).max(80).nullable().default(null),
    selection: z.array(z.string().min(1).max(LIMITS.REF)).max(LIMITS.REFS).default([]),
    containers: z.array(containerSchema).max(64).default([]),
  })
  .strict()
  .superRefine((kehikko, ctx) => {
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
  })

const fileSchema = z
  .object({
    version: z.literal(VERSION),
    kehikot: z.array(kehikkoSchema).max(500),
  })
  .strict()
  .superRefine((file, ctx) => {
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
  })

type FileKehikko = z.infer<typeof kehikkoSchema>
type FileContainer = z.infer<typeof containerSchema>

/** The file for a project, or null when there is no project path to put it under. */
export function kehikotFile(projectPath: string | null | undefined): string | null {
  return moduleFile(projectPath, HOST_ID, FILE_NAME)
}

/** A placement, in the order and under the names the file uses. */
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
    collapsed: p.collapsed,
    wish: p.wish,
    selected: p.selected,
    filters: p.filters,
    refreshEvery: p.refreshEvery,
  }
}

/**
 * A container as it arrives from the file, made into what `editCanvas` takes.
 *
 * Bounds are NOT applied here. `editCanvas` runs everything through `cleaned`,
 * which is the one place a placement is bounded on the way into the database —
 * a file that says `h: 9000` gets the same treatment a page that says it would,
 * and there is no second, weaker copy of that rule here to drift.
 */
function fromContainer(c: FileContainer): PlacementInput {
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
    collapsed: c.collapsed,
    /* A file from before `wish` said `openH` for a folded container and
       nothing for an open one; either way the fallback is the height it has,
       which `cleaned` supplies for a `null`. */
    wish: c.wish ?? c.openH ?? null,
    selected: c.selected,
    filters: c.filters,
    refreshEvery: c.refreshEvery,
  }
}

function toKehikko(canvas: Canvas): FileKehikko {
  return {
    key: canvas.key,
    name: canvas.name,
    epic: canvas.epic,
    selection: canvas.selection,
    containers: canvas.placements.map(toContainer),
  }
}

/**
 * The text of the file for these kehikot — the same bytes for the same input,
 * every time.
 *
 * Not `JSON.stringify(_, null, 2)` on the whole thing, because that puts every
 * container across fifteen lines and a drag becomes a fifteen-line hunk in
 * which two numbers changed. Each container is one line; everything above it
 * is indented normally. Both halves are still `JSON.stringify`, so the result
 * is JSON and nothing here escapes a string by hand.
 */
export function serialize(canvases: readonly Canvas[]): string {
  const lines: string[] = ['{', `  "version": ${VERSION},`, '  "kehikot": [']
  canvases.forEach((canvas, index) => {
    const k = toKehikko(canvas)
    lines.push('    {')
    lines.push(`      "key": ${JSON.stringify(k.key)},`)
    lines.push(`      "name": ${JSON.stringify(k.name)},`)
    lines.push(`      "epic": ${JSON.stringify(k.epic)},`)
    lines.push(`      "selection": ${JSON.stringify(k.selection)},`)
    if (k.containers.length === 0) {
      lines.push('      "containers": []')
    } else {
      lines.push('      "containers": [')
      k.containers.forEach((container, i) => {
        lines.push(`        ${JSON.stringify(container)}${i < k.containers.length - 1 ? ',' : ''}`)
      })
      lines.push('      ]')
    }
    lines.push(`    }${index < canvases.length - 1 ? ',' : ''}`)
  })
  lines.push('  ]', '}')
  return `${lines.join('\n')}\n`
}

export type Parsed = { ok: true; kehikot: FileKehikko[] } | { ok: false; why: string }

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
  const read = fileSchema.safeParse(raw)
  if (read.success) return { ok: true, kehikot: read.data.kehikot }

  const said = read.error.issues.slice(0, 3).map((issue) => {
    const at = issue.path.length ? issue.path.map(String).join('.') : 'the top level'
    if (issue.code === z.ZodIssueCode.unrecognized_keys) {
      return `${at} has a field this host does not know (${issue.keys.join(', ')}) — is the file from a newer Kehikot?`
    }
    return `${at} ${issue.message}`
  })
  return { ok: false, why: said.join('; ') }
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
 * Write a project's kehikot to its file, after something changed.
 *
 * Called by whatever changed them; the database was already written and this
 * makes the file agree. Nothing is written when nothing would change, so a
 * drag that ends where it started does not touch a file git is watching. And
 * nothing is written while the file is refused — see the essay.
 *
 * The write is a rename over the old file, so a crash mid-write leaves the
 * previous file whole rather than a truncated one that will not parse.
 */
export function keep(db: Database, projectId: number | null): void {
  if (projectId === null) return
  const project = projectById(db, projectId)
  if (!project) return
  const file = kehikotFile(project.path)
  if (file === null || refused.has(file)) return

  const mine = listCanvases(db).filter((canvas) => canvas.project === projectId)
  const text = serialize(mine)
  let before: string | null = null
  try {
    before = readFileSync(file, 'utf8')
  } catch {
    /* Not there yet. */
  }
  if (before === text) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, text)
  renameSync(`${file}.tmp`, file)
}

export type Synced =
  | { file: string; outcome: 'read'; changed: boolean }
  | { file: string; outcome: 'written' }
  | { file: string; outcome: 'nothing' }
  | { file: string; outcome: 'refused'; why: string }

/**
 * Make this machine's database agree with a project's file.
 *
 * The three outcomes are the three paragraphs in the essay: the file was read
 * and won; there was no file and one was written from the database; the file
 * would not read and nothing was touched. `nothing` is the fourth, for a
 * project with neither a file nor any kehikot — the state a project is in for
 * the instant between being added and `ensureCanvases` giving it one.
 */
export function syncProject(db: Database, project: { id: number; path: string }): Synced {
  const file = kehikotFile(project.path)
  if (file === null) return { file: '', outcome: 'nothing' }

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

  /*
   * The file wins. Rows are matched to the file's kehikot by key; a key the
   * file has and the database does not becomes a row, a key the database has
   * and the file does not stops being one, and every matched row is rewritten
   * to say what the file says. Done in one transaction, because a sync that
   * stopped between deleting and creating would leave the database agreeing
   * with neither the file nor itself.
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
      if (serialize([row]) === serialize([{ ...row, ...asCanvasFields(kehikko) }])) continue
      editCanvas(db, row.id, {
        name: kehikko.name,
        epic: kehikko.epic,
        selection: kehikko.selection,
        placements: kehikko.containers.map(fromContainer),
      })
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
    return changed
  })

  return { file, outcome: 'read', changed: apply() }
}

/**
 * A file kehikko projected onto the canvas fields it sets, for the comparison
 * above. The comparison goes through `serialize` so that it is exactly "would
 * the file be different", which is the only question that matters here — and
 * so that bounding on the way in (a file's `h: 9000` becoming 400) shows up as
 * a difference and gets written, rather than the two sides silently agreeing
 * to disagree.
 */
function asCanvasFields(kehikko: FileKehikko): Pick<Canvas, 'name' | 'epic' | 'selection' | 'placements'> {
  return {
    name: kehikko.name,
    epic: kehikko.epic,
    selection: kehikko.selection,
    placements: kehikko.containers.map((c) => ({ ...fromContainer(c) }) as Placement),
  }
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
    const synced = syncProject(db, project)
    if (synced.outcome === 'refused') {
      trouble.push(
        `${synced.file} could not be read: ${synced.why}. Changes to ${project.name}'s kehikot are kept on this computer only until it is fixed, and then the file wins.`,
      )
    }
  }
  return trouble
}
