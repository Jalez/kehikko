import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { LIMITS, ignoresKehikot, withKehikotIgnored, withoutKehikotIgnored } from 'kehikot-module-protocol'

import { createCanvas, listCanvases } from './canvases.ts'
import { epicsDir, migrateHostData } from './hostData.ts'
import { projectFileTracked, readProjectId, sayIdentity, writeProjectId } from './projectIdentity.ts'
import { MISSING_SAID, projectRootExists } from './projectRoot.ts'

export { MISSING_SAID, projectRootExists } from './projectRoot.ts'

/**
 * Projects: the containers, and the thing this host had the wrong way round.
 *
 * ## What was wrong
 *
 * `canvases` had a `project text` column. A project was a LABEL you could type
 * onto a canvas, and every canvas on this machine had it set to NULL — not
 * through neglect, but because a label nobody has to fill in is a label nobody
 * fills in, and because the relationship it was modelling runs the other way.
 * Kehikot that all read one folder's epics did not say so.
 *
 * The user's own framing settled it: *"a project can have one or many kehikkos
 * — one kehikko can focus on writing documentation, another on design, another
 * on coding. Project and their epics can have one or many kehikkos."* So:
 *
 *     project (a folder on disk)
 *       ├── epics      (.kehikot/kehikko/epics under it, when it has any)
 *       └── kehikot    (many; one per purpose)
 *
 * ## Why a folder, and why that is the whole of it
 *
 * They asked for the VS Code way explicitly, and the mapping holds all the way
 * down: a kehikko is a saved layout, a module is an extension, and a project is
 * `workspaceFolders`. The useful consequence is what it makes UNNECESSARY. A
 * git worktree is a folder, so "pick the worktree" needs no concept of its own;
 * a repository is a folder; a directory of LaTeX chapters with no git in it at
 * all is a folder. This host does not have to know which it got.
 *
 * ## Why a path is the identity and a name is not
 *
 * The path is unique. Two rows on one folder are two names for one project, and
 * every count of "how many projects" would then disagree with the disk. The
 * name is not unique and must not be: two folders may both reasonably be called
 * `notes`, and a host refusing the second would be a host with an opinion
 * about somebody else's filing.
 */

export interface Project {
  id: number
  name: string
  /** Absolute, and real: the path as the filesystem resolved it. */
  path: string
  /** Whether `.kehikot/kehikko/epics` exists under it. Read now, never cached — see below. */
  epics: boolean
  /**
   * Whether this folder has a git history at all.
   *
   * The question only exists to decide whether `shared` is a setting or a
   * sentence. A project that is not a repository has no `.gitignore` worth
   * writing and nothing to share it WITH, and offering a checkbox there would
   * be offering a decision that changes nothing on disk.
   */
  git: boolean
  /**
   * Whether this project's `.kehikot/` goes into its history.
   *
   * `false` — the folder is ignored — is what every project has had until now,
   * because the modules wrote that rule themselves the first time they made
   * their folder. It stopped being obviously right when the papers moved in:
   * ignoring a person's own writing because it sits beside a checklist is the
   * opposite of what the rule was for.
   *
   * Computed on every read, like `epics` and for the same reason, with one
   * extra: the `.gitignore` is a file in somebody's repository that they may
   * edit by hand, another program may rewrite, and a checkout may replace. A
   * stored boolean would be this host reporting what the file said when the
   * project was added, and the first time the two disagreed the checkbox would
   * be lying about a file the person could see.
   */
  shared: boolean
  /**
   * Whether the folder is gone — renamed, moved or deleted since it was added.
   *
   * Read on every list, like `epics`. A missing project is still listed, so the
   * person can see what became of it, and nothing is ever written under it: see
   * `projectRoot.ts`, which is the rule every writer asks.
   */
  missing: boolean
  /**
   * The project's permanent id (protocol 2.1.0): what is in its own
   * `.kehikot/project.json`, and what `context.projectId` carries. Null for a
   * project this host has not yet met in its folder — one already gone when
   * this host first looked. See `identify` and `projectIdentity.ts`.
   */
  uid: string | null
}

/** How many projects a person may have open. Far above anybody, low enough to bound a list. */
const PROJECTS_MAX = 200
const NAME_MAX = 60

/**
 * Every project, in the order they were added.
 *
 * `epics` is computed on every read rather than stored, and that is the same
 * decision `holdings.ts` makes about epic files: a directory can appear under a
 * project between one call and the next — somebody runs a tool that makes
 * epics, or clones something — and a stored boolean would be this host
 * reporting what was true when the project was added. It is one `statSync` per
 * project against a local disk.
 */
export function listProjects(db: Database): Project[] {
  return db
    .query<Row, []>(
      'select id, name, path, uid from projects order by rank, id',
    )
    .all()
    .map((row) => described(row))
}

/**
 * Whether a folder is one of the projects a person added here: yes or no.
 *
 * For a module's SERVER, which is handed a path by its own page and by agents
 * and cannot otherwise tell a project the person added from any folder on the
 * disk. It is asked one path and told one word — never the list, for the
 * reason `projects.pick` has no `projects.list` beside it: a module holding
 * the list has been handed a listing of the disk.
 *
 * The folder itself, not something inside it, and compared resolved: a link
 * to a project is that project, and `/a/project/../project` is too. A path
 * that is relative, too long, or names nothing answers no, in the same word
 * as a real folder that is not a project — so the answer says nothing about
 * what else is on the disk.
 */
export function isProject(db: Database, asked: unknown): boolean {
  if (typeof asked !== 'string' || asked.length === 0 || asked.length > LIMITS.PATH || !isAbsolute(asked)) return false
  const resolved = (path: string): string | null => {
    try {
      return realpathSync(resolve(path))
    } catch {
      return null
    }
  }
  const real = resolved(asked)
  if (real === null) return false
  const rows = db.query<{ path: string }, []>('select path from projects').all()
  return rows.some((row) => resolved(row.path) === real)
}

/**
 * Whether a path is a project a person added whose folder is now gone.
 *
 * `isProject` says no for it — a module must not write there, and the folder
 * cannot be resolved to compare anyway — so this is the second word that says
 * why: the path is the one stored, character for character once made absolute,
 * and nothing is at it. Only ever true for a path the asker already holds.
 */
export function isMissingProject(db: Database, asked: unknown): boolean {
  if (typeof asked !== 'string' || asked.length === 0 || asked.length > LIMITS.PATH || !isAbsolute(asked)) return false
  const rows = db.query<{ path: string }, []>('select path from projects').all()
  const wanted = new Set([resolve(asked), throughParent(asked)])
  return rows.some((row) => wanted.has(resolve(row.path)) && !projectRootExists(row.path))
}

/**
 * A path whose last folder is gone, with its parent resolved by the filesystem:
 * `/tmp/x` is stored as `/private/tmp/x` on a Mac, and the folder `x` cannot be
 * resolved any more to say so.
 */
function throughParent(asked: string): string {
  const full = resolve(asked)
  try {
    return join(realpathSync(dirname(full)), basename(full))
  } catch {
    return full
  }
}

/** One project by id, or null. */
export function projectById(db: Database, id: number): Project | null {
  const row = db
    .query<Row, [number]>(
      'select id, name, path, uid from projects where id = ?',
    )
    .get(id)
  return row ? described(row) : null
}

/** A project's row, as stored. */
type Row = { id: number; name: string; path: string; uid: string | null }

/** A row as the page and the agents see it, read off the disk now. */
function described(row: Row): Project {
  const missing = !projectRootExists(row.path)
  return {
    ...row,
    name: named(row.path),
    epics: !missing && holdsEpics(row.path),
    /* A folder that is gone has no history of its own; walking up from it would
       answer for whatever folder it used to sit in. */
    git: !missing && hasGit(row.path),
    shared: missing ? false : sharesKehikot(row.path),
    missing,
    uid: row.uid,
  }
}

/**
 * What a project is called: the name of its folder.
 *
 * Read off the path on every list, never out of the row, and the `name` column
 * is now written once at insert and never read. That is the same decision
 * `epics`, `git` and `shared` make, for the reason this host keeps arriving at:
 * the disk is the truth and a stored copy is this host reporting what was true
 * when the project was added.
 *
 * ## Why a typed name is gone rather than merely defaulted
 *
 * It already defaulted to the folder. What it also allowed was a name that had
 * drifted from it — a project on this machine reads "Community portal" over a
 * folder called `hippos-portal`, and every sentence a module writes about that
 * project names one of the two while the person is looking at the other. The
 * user's ask was that they be the same thing, and the only way two things stay
 * the same is for there to be one of them.
 *
 * A renamed folder now renames the project, with nothing to keep in step.
 *
 * ## The cost, said out loud
 *
 * Two projects whose folders are both called `app` are two rows called `app`.
 * They were always allowed to share a name — a host refusing the second would
 * be a host with an opinion about somebody's filing — and the picker puts the
 * full path in the tooltip beside each one. `basename` is empty only at the
 * filesystem root, which is the one path nobody opens as a project, and that
 * falls back to the path itself.
 */
export function named(path: string): string {
  return basename(path) || path
}

/** Whether a folder brings its own epics. Not every project does — see `addProject`. */
export function holdsEpics(root: string): boolean {
  try {
    return statSync(epicsDir(resolve(root))).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether this folder is under git — here, or anywhere above it.
 *
 * `.git` as either a directory or a file: the file form is a worktree or a
 * submodule, both of which are real repositories, and a check that only knew
 * about the directory would tell somebody working in a worktree that their
 * project has no history. This host runs out of worktrees itself.
 *
 * ## It walks up, and the first version of this did not
 *
 * Looking only at `<project>/.git` is wrong for the project this setting was
 * built for. The thesis is at `…/CS-DEGREE/05_drafts/thesis_latex`, has no
 * `.git` of its own, and sits several directories inside one. Under the narrower
 * check the host would have said "no git history here" and withheld the setting
 * from the one project whose papers most needed to be committed — while `notes`
 * had been writing a `.gitignore` into that same folder for months, because it
 * walks up and always has. Two programs disagreeing about whether somebody's
 * folder is in a repository, with one of them acting on it.
 *
 * The objection to walking up is real and is answered by WHERE the file goes,
 * not by refusing to look: the `.gitignore` is written at the PROJECT root and
 * never at the repository root. Git honours one in any directory, so the rule
 * reaches exactly this folder and nothing beside it — which is both the correct
 * scope and the smallest edit to somebody else's repository. Appending to a
 * `.gitignore` five levels up, covering work that has nothing to do with this,
 * would be the much larger thing to do uninvited. `notes` makes this argument
 * first and at length; this is the same conclusion, reached by finding it there.
 *
 * A folder with no `.git` anywhere above it gets nothing: there is no history
 * for a rule to mean anything to, and the screen says so in a sentence rather
 * than with a disabled control.
 */
export function hasGit(root: string): boolean {
  let at = resolve(root)
  for (;;) {
    try {
      statSync(resolve(at, '.git'))
      return true
    } catch {
      const up = resolve(at, '..')
      /* `resolve('/', '..')` is `/`, so the root of the filesystem is where this
         stops. A loop that tested only for a `.git` would not terminate there. */
      if (up === at) return false
      at = up
    }
  }
}

/**
 * Whether this project's `.kehikot/` is in its history rather than ignored.
 *
 * The `.gitignore` is the truth and this reads it, so what the checkbox shows
 * is what the file says. A missing or unreadable `.gitignore` is not ignoring
 * anything, which is `true` — shared — and is the honest reading: git needs a
 * rule to ignore a path, and the absence of a file is the absence of a rule.
 */
export function sharesKehikot(root: string): boolean {
  try {
    return !ignoresKehikot(readFileSync(resolve(root, GITIGNORE), 'utf8'))
  } catch {
    return true
  }
}

/** The file this host will write, and the only one it will. */
const GITIGNORE = '.gitignore'

export type Forgotten =
  | { ok: true; project: Project; canvases: number }
  | { ok: false; why: string; status: number }

/**
 * Stop holding a folder as a project.
 *
 * ## It deletes nothing on disk, and that is the whole design
 *
 * The ask was "deleting should only erase the `.kehikot` folder from that
 * particular folder". It does not, and the reason is a change made an hour
 * before it was asked for: papers moved INTO `.kehikot/`. Erasing that folder
 * now deletes the person's thesis along with their checklists — a `main.tex`,
 * its chapters and its figures, from a control whose label says "project".
 *
 * That is not a refusal to build it. It is a refusal to put it behind THIS
 * word. Forgetting a project and erasing a project's material are two different
 * decisions with two different worst cases, and the one that cannot be undone
 * does not get to ride along with the one that can. What this does is undo the
 * add: the folder stops being a project, and everything in it — `.kehikot/`
 * included — is exactly as it was.
 *
 * ## What it DOES delete
 *
 * The project's kehikot, by `on delete cascade`, and their placements with
 * them. That is the arrangement of containers on a canvas, which somebody
 * built by hand and cannot get back, so this is destructive enough to be armed
 * rather than pressed — see the header control — and the count comes back so
 * the page can say how many before anyone commits to it.
 *
 * Adding the folder again gives a project with no kehikot and every module's
 * material still in place, which is the honest shape of "undo": what was on
 * disk survives, what this host was keeping does not.
 */
export function forgetProject(db: Database, id: number): Forgotten {
  const project = projectById(db, id)
  if (!project) return { ok: false, why: 'There is no project by that id.', status: 404 }

  /* Counted before the delete, because after it there is nothing to count and a
     number read afterwards would always be zero. */
  const canvases =
    db.query<{ n: number }, [number]>('select count(*) as n from canvases where project_id = ?').get(id)?.n ?? 0

  db.query('delete from projects where id = ?').run(id)
  return { ok: true, project, canvases }
}

export type Shared = { ok: true; project: Project } | { ok: false; why: string; status: number }

/**
 * Put this project's `.kehikot/` into its history, or take it out again.
 *
 * ## Why the host does this and the modules no longer do
 *
 * Four modules used to write that rule — notes, checklist and journeys each
 * called `withKehikotIgnored` the first time they created their folder, and
 * learning's migration did it a fourth time. That is four programs with an
 * opinion about one line in somebody else's repository, none of them able to
 * take it back, and no way for the person to say otherwise. It was also
 * invisible: the rule appeared the first time a module happened to save
 * something, which is not a moment anybody witnesses.
 *
 * One writer, and it is the host, because the host is what knows the project.
 * A module knows a `projectPath` it was handed; the host is where a project is
 * added, named, opened and listed, and where a person is already looking when
 * they want to decide something about it.
 *
 * ## What it refuses
 *
 * A folder with no git history. There is no `.gitignore` worth writing where
 * there is no history to keep something out of, and writing one anyway would
 * leave a file behind that does nothing and explains nothing.
 *
 * ## What it does NOT do
 *
 * It does not `git add` anything, and it does not touch the index. Turning
 * sharing on makes the files visible to git; whether they are committed is the
 * person's decision, made with their own tools, in their own history, under
 * their own name. A host that committed on somebody's behalf would be writing
 * that history for them.
 */
export function shareKehikot(db: Database, id: number, shared: boolean): Shared {
  const project = projectById(db, id)
  if (!project) return { ok: false, why: 'There is no project by that id.', status: 404 }
  if (project.missing) return { ok: false, why: `${MISSING_SAID} Its .gitignore was not touched.`, status: 409 }
  if (!project.git) {
    return {
      ok: false,
      why: `${project.name} has no git history of its own, so there is nothing here to keep out of one.`,
      status: 409,
    }
  }

  const file = resolve(project.path, GITIGNORE)
  let before = ''
  try {
    before = readFileSync(file, 'utf8')
  } catch {
    /* No `.gitignore` yet. Turning sharing ON has nothing to do — the absence
       of a rule is already the absence of an ignore — and turning it OFF makes
       the file, which is the one case where this host creates one. */
    if (shared) return { ok: true, project: { ...project, shared: true } }
  }

  const after = shared ? withoutKehikotIgnored(before) : withKehikotIgnored(before)
  /* Written only when it would change, so that pressing a checkbox that is
     already in the position you pressed it into does not put a modified file in
     somebody's `git status`. */
  if (after !== before) {
    try {
      writeFileSync(file, after, 'utf8')
    } catch (error) {
      return { ok: false, why: `That .gitignore could not be written: ${(error as Error).message}`, status: 500 }
    }
  }
  return { ok: true, project: { ...project, shared } }
}

export type Added =
  | { ok: true; project: Project; already: boolean; relinked?: boolean }
  | { ok: false; why: string; status: number }

/**
 * Add a project, given a folder.
 *
 * ## The refusals
 *
 * This is where a string from a page becomes a path this host will later read
 * files under, so the string is made absolute, resolved by the filesystem, and
 * checked to BE a directory before it is stored — and what is stored is what it
 * resolved to, not what was typed. A path that does not exist is refused rather
 * than remembered hopefully: a project pointing at nothing would report no
 * epics, and "no epics" is a sentence this host works hard to keep honest.
 *
 * ## A project with no epics is not an error
 *
 * The user's thesis lives in a folder with `main.tex`, `chapters/` and
 * `references.bib` and no `.kehikot/kehikko/epics` anywhere in it. A kehikko there is a
 * perfectly good kehikko — it is where the writing modules go — and it honestly
 * has no epics to pick. Refusing that folder would be this host insisting that
 * work it cannot index is not work. So `epics` is reported and never required,
 * and the header says there are none rather than drawing an empty picker that
 * looks broken.
 *
 * ## It comes with a kehikko
 *
 * A project with no kehikot has nothing to open, and the header would show an
 * empty dropdown over a blank canvas. Somebody who has just pressed "add a
 * project" has said what they want; making them press "new kehikko" as well is
 * a step the program could take itself. Nothing is PLACED on it — see `App.tsx`
 * on why a registration appearing is never a licence to arrange a canvas for
 * somebody.
 */
export function addProject(
  db: Database,
  asked: string,
  name?: string,
  /**
   * Whether to make it a first kehikko as well.
   *
   * True for every press of "add a project", which is the case the paragraph
   * above is about. False in exactly one place: `adopt`, seeding the first
   * project on a database that already has kehikot waiting to be filed into it.
   * Those three ARE its kehikot; adding a fourth empty one beside them would be
   * the migration leaving a stray behind, and the person would open their
   * project to find a blank canvas in front of the work they had arranged.
   */
  alsoAKehikko = true,
): Added {
  if (typeof asked !== 'string' || !asked || asked.length > LIMITS.PATH || asked.includes('\0')) {
    return { ok: false, why: 'A project is named by one absolute path.', status: 400 }
  }
  if (!isAbsolute(asked)) {
    return {
      ok: false,
      why: 'A project is an absolute path. A relative one would be resolved against wherever this server happens to have been started, which is not a place anybody chose.',
      status: 400,
    }
  }

  const found = folderAt(asked)
  if (!found.ok) return found
  const real = found.real

  /* A legacy `data/epics` / `data/state` moves under `.kehikot/kehikko/` the
     moment the folder becomes (or is re-added as) a project — see
     `hostData.ts`. Never overwrites; a folder with both keeps both. */
  migrateHostData(real)

  /* Already open. Not an error and not a second row: the person picked the
     folder they are already in, most likely because they could not tell from
     the browser that it was already a project. They get the one that exists. */
  const standing = db.query<{ id: number }, [string]>('select id from projects where path = ?').get(real)
  if (standing) {
    identify(db, standing.id)
    const project = projectById(db, standing.id)
    if (project) return { ok: true, project, already: true }
  }

  /* A folder carrying the id of a project this host knows is that project,
     moved or renamed: the row is pointed here, and its kehikot and Inbox
     history come with it. Unless the project is still where it was, carrying
     the same id — then this folder is a COPY of it (`cp -r`), and is added as a
     project of its own with a fresh id, below. */
  const carried = readProjectId(real)
  if (carried !== null) {
    const holder = db.query<Row, [string]>('select id, name, path, uid from projects where uid = ?').get(carried)
    if (holder && !(projectRootExists(holder.path) && readProjectId(holder.path) === carried)) {
      const moved = relinkProject(db, holder.id, real)
      if (!moved.ok) return moved
      return { ok: true, project: moved.project, already: true, relinked: true }
    }
  }

  const total = db.query<{ n: number }, []>('select count(*) as n from projects').get()?.n ?? 0
  if (total >= PROJECTS_MAX) {
    return {
      ok: false,
      why: `This host holds ${PROJECTS_MAX} projects, which is already more than anybody meant.`,
      status: 409,
    }
  }

  /* Written so the column is never null, and never read again: `named` answers
     that question off the path, on every list. The `name` argument is still
     accepted and still tidied, because a caller passing one is not an error and
     refusing it would break a door over a field nothing depends on. */
  const label = tidy(name) ?? named(real)

  const row = db
    .query<{ id: number }, [string, string]>(
      'insert into projects (name, path, rank) values (?, ?, (select coalesce(max(rank), 0) + 1 from projects)) returning id',
    )
    .get(label, real)
  if (!row) return { ok: false, why: 'The project was not written.', status: 500 }

  /* Its id: adopted from the folder, or minted and written there. A copy of
     a project still in place is given a fresh one here — see `identify`. */
  identify(db, row.id)
  if (alsoAKehikko) createCanvas(db, 'kehikko', row.id)
  const project = projectById(db, row.id)
  if (!project) return { ok: false, why: 'The project was not written.', status: 500 }
  return { ok: true, project, already: false }
}

/**
 * Make sure there is a project, and that no kehikko is orphaned outside one.
 *
 * Run once at startup, before anything is served. Two jobs, and the second is
 * the migration.
 *
 * ## The seed
 *
 * `KEHIKOT_SEED_PROJECT` says where this host's epics come from. `run.sh` defaults it and says so in the terminal, and an existing setup
 * has to keep starting — a host that suddenly had no projects would be a
 * regression a person meets before they meet the feature. So on a database with
 * no projects in it, that directory becomes the first one.
 *
 * With no `KEHIKOT_SEED_PROJECT` and no projects, the seed is the person's home
 * folder. That is a guess and it is deliberately a visible one: home certainly
 * exists, it holds no `.kehikot/kehikko/epics`, so the header says there are no epics here
 * — which is true — and "add a project" is one press away. The alternative was
 * leaving canvases in no project at all, and a kehikko no dropdown lists is
 * work somebody cannot reach.
 *
 * ## The adoption
 *
 * Every canvas written before projects existed has `project_id` NULL. They go
 * to the FIRST project — the seed — because on the run where this matters
 * there is only one, and it is where their epics came from.
 */
export function adopt(
  db: Database,
  env: Record<string, string | undefined> = process.env,
): { seeded: Project | null; adopted: number } {
  let projects = listProjects(db)
  /* Read BEFORE the seed is added, because whether the seed needs a kehikko of
     its own depends on whether these are about to become its kehikot. */
  const orphans = listCanvases(db).filter((canvas) => canvas.project === null)

  if (!projects.length) {
    const named = env.KEHIKOT_SEED_PROJECT
    const seed = named && existsSync(named) ? named : homedir()
    /* A seed that cannot be added is not fatal. The host starts, the header
       says there is no project, and "add a project" still works — a far better
       state than refusing to serve a page. */
    if (addProject(db, seed, undefined, orphans.length === 0).ok) projects = listProjects(db)
  }

  /* Every project this host already knows gets its legacy epics and state brought
     under `.kehikot/kehikko/` at startup, so a project added before the move
     reads the same epics after it. See `hostData.ts`. */
  for (const project of projects) if (!project.missing) migrateHostData(project.path)
  /* Every project's id, oldest first, so that of two folders carrying one id
     the project added first keeps it. See `identify`. */
  identifyAll(db)
  if (projects.length) projects = listProjects(db)

  const first = projects[0] ?? null
  if (!first) return { seeded: null, adopted: 0 }

  for (const orphan of orphans) {
    db.query('update canvases set project_id = ? where id = ?').run(first.id, orphan.id)
  }
  return { seeded: first, adopted: orphans.length }
}

/**
 * Whether a path is inside one of a set of roots.
 *
 * Exported because two callers need the same answer and a second implementation
 * of a containment check is a second thing that can be wrong. Compared with a
 * trailing separator, because `/Users/x/Projects-old` starts with
 * `/Users/x/Projects` and is not inside it — the off-by-one that turns a prefix
 * check into a way out.
 */
export function within(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))
}

function tidy(name: string | undefined): string | null {
  if (typeof name !== 'string') return null
  const trimmed = name.trim().slice(0, NAME_MAX)
  return trimmed || null
}

/**
 * A folder a person named, made absolute, resolved and checked to be one: the
 * refusals `addProject` and `locateProject` share, so neither grows a weaker copy.
 */
function folderAt(asked: string): { ok: true; real: string } | { ok: false; why: string; status: number } {
  let real: string
  try {
    real = realpathSync(resolve(asked))
  } catch {
    return { ok: false, why: 'There is no folder at that path.', status: 400 }
  }
  try {
    if (!statSync(real).isDirectory()) {
      return { ok: false, why: 'That is a file. A project is a folder.', status: 400 }
    }
  } catch {
    return { ok: false, why: 'There is no folder at that path.', status: 400 }
  }
  return { ok: true, real }
}

/**
 * Settle one project's id against its folder (protocol 2.1.0), and answer it.
 *
 * - A folder that is gone: nothing is read or written; the row keeps what it had.
 * - The folder carries a valid id that no other row holds: that is the id.
 * - It carries one another row holds — the folder is a COPY (`cp -r`, a clone
 *   or a worktree that carried the file). The OLDER row keeps the id; the newer
 *   folder is given a fresh one, its `project.json` rewritten (the only rewrite
 *   there is), and the terminal says so — and, once, that git tracks the file
 *   when it does, since ignoring a tracked file does not untrack it.
 * - No file, or one that does not parse: the row's id, or a fresh
 *   `crypto.randomUUID()`, written there — never into the home folder, and a
 *   folder that will not take the write keeps it in the database only.
 */
export function identify(db: Database, id: number): string | null {
  const row = db.query<Row, [number]>('select id, name, path, uid from projects where id = ?').get(id)
  if (!row) return null
  if (!projectRootExists(row.path)) return row.uid
  const git = (): boolean => hasGit(row.path)
  const set = (project: number, uid: string | null) =>
    db.query('update projects set uid = ? where id = ?').run(uid, project)

  const carried = readProjectId(row.path)
  if (carried !== null) {
    if (carried === row.uid) return carried
    const holder = db.query<Row, [string, number]>('select id, name, path, uid from projects where uid = ? and id <> ?').get(carried, row.id)
    if (holder && holder.id < row.id) {
      const fresh = crypto.randomUUID()
      set(row.id, fresh)
      const written = writeProjectId(row.path, fresh, git())
      sayIdentity(
        `kehikko: ${row.path} carries the id of ${named(holder.path)} (${holder.path}) — a copy of it. ${holder.path} keeps the id; `
          + `${row.path} is a project of its own now, id ${fresh}${written === 'written' ? '' : ' (kept by this host only: its project.json could not be rewritten)'}.`,
      )
      for (const path of [row.path, holder.path]) {
        if (git() && projectFileTracked(path)) {
          sayIdentity(
            `kehikko: git tracks ${path}/.kehikot/project.json. It should not be committed — every clone of it is taken for the same project. `
              + 'Untrack it with `git rm --cached .kehikot/project.json`.',
          )
        }
      }
      return fresh
    }
    if (holder) {
      /* This row is the older: it takes the id, and the newer is settled again
         — as the copy, if its folder still carries this id. */
      set(holder.id, null)
      set(row.id, carried)
      identify(db, holder.id)
      return carried
    }
    if (row.uid !== null) {
      sayIdentity(`kehikko: ${row.path} carries the id ${carried}, not the ${row.uid} this host had for it; it is known by the folder's now.`)
    }
    set(row.id, carried)
    return carried
  }

  const uid = row.uid ?? crypto.randomUUID()
  if (row.uid === null) set(row.id, uid)
  writeProjectId(row.path, uid, git())
  return uid
}

/** Every project's id, oldest row first. Run at startup, by `adopt`. */
export function identifyAll(db: Database): void {
  for (const { id } of db.query<{ id: number }, []>('select id from projects order by id').all()) identify(db, id)
}

export type Relinked = { ok: true; project: Project } | { ok: false; why: string; status: number; anyway?: boolean }

/**
 * Point a project at the folder it is in now, keeping everything keyed by its
 * row — its kehikot, their placements and its Inbox history, none of which
 * store the path. The path it had is kept in `project_paths`, with when.
 * Refused when another project is already that folder.
 */
export function relinkProject(db: Database, id: number, real: string): Relinked {
  const row = db.query<Row, [number]>('select id, name, path, uid from projects where id = ?').get(id)
  if (!row) return { ok: false, why: 'There is no project by that id.', status: 404 }
  if (row.path !== real) {
    const other = db.query<{ id: number }, [string, number]>('select id from projects where path = ? and id <> ?').get(real, id)
    if (other) {
      return { ok: false, why: `That folder is already a project here: ${named(real)}. Forget one of the two first.`, status: 409 }
    }
    db.transaction(() => {
      db.query('insert into project_paths (project_id, path, until) values (?, ?, ?)').run(id, row.path, new Date().toISOString())
      db.query('update projects set path = ? where id = ?').run(real, id)
    })()
  }
  const project = projectById(db, id)
  return project ? { ok: true, project } : { ok: false, why: 'The project was not written.', status: 500 }
}

/** The paths a project was relinked away from, newest first. */
export function formerPaths(db: Database, id: number): { path: string; until: string }[] {
  return db
    .query<{ path: string; until: string }, [number]>(
      'select path, until from project_paths where project_id = ? order by until desc, rowid desc',
    )
    .all(id)
}

/** The start of every refusal `locateProject` gives, on the page as it is here. */
export const NOT_THIS_PROJECT = "That folder isn't this project:"

/**
 * "Locate…": the person says where a project's folder went.
 *
 * The folder must carry the project's own id — that is what makes it the same
 * project rather than a folder that happens to be called the same. A folder
 * with no id, or another id, is refused in a sentence. A project that never
 * had an id (it was gone before this host first looked) has nothing to compare
 * with, so the refusal offers a second step, `anyway`, that takes the folder on
 * the person's word — unless the folder is another project this host knows.
 */
export function locateProject(db: Database, id: number, asked: unknown, anyway = false): Relinked {
  const row = db.query<Row, [number]>('select id, name, path, uid from projects where id = ?').get(id)
  if (!row) return { ok: false, why: 'There is no project by that id.', status: 404 }
  if (typeof asked !== 'string' || !asked || asked.length > LIMITS.PATH || asked.includes('\0') || !isAbsolute(asked)) {
    return { ok: false, why: 'A folder is named by one absolute path.', status: 400 }
  }
  const found = folderAt(asked)
  if (!found.ok) return found
  const real = found.real
  const carried = readProjectId(real)

  if (row.uid !== null) {
    if (carried !== row.uid) {
      const other = carried === null ? null : db.query<Row, [string]>('select id, name, path, uid from projects where uid = ?').get(carried)
      const why =
        carried === null
          ? `it has no Kehikot id (.kehikot/project.json), and ${named(row.path)} has one.`
          : other
            ? `it is ${named(other.path)}, another project here.`
            : 'it carries a different Kehikot id.'
      return { ok: false, why: `${NOT_THIS_PROJECT} ${why}`, status: 409 }
    }
  } else {
    const other = carried === null ? null : db.query<Row, [string, number]>('select id, name, path, uid from projects where uid = ? and id <> ?').get(carried, id)
    if (other) return { ok: false, why: `${NOT_THIS_PROJECT} it is ${named(other.path)}, another project here.`, status: 409 }
    if (!anyway) {
      return {
        ok: false,
        why: `${NOT_THIS_PROJECT} ${named(row.path)} never had a Kehikot id to compare it with, so this host cannot tell. Use the folder anyway only if you are sure it is the one.`,
        status: 409,
        anyway: true,
      }
    }
  }

  const moved = relinkProject(db, id, real)
  if (!moved.ok) return moved
  identify(db, id)
  const project = projectById(db, id)
  return project ? { ok: true, project } : { ok: false, why: 'The project was not written.', status: 500 }
}
