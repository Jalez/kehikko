import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What this host actually holds, when it is pointed at something.
 *
 * ## The host used to hold nothing, on purpose
 *
 * Every answer in `answers.ts` was an answer about emptiness, and the essay
 * there is still right about why the two kinds of emptiness must be told apart.
 * What changed first is that there was something to read: a roadmap directory
 * on this machine, named by `KEHIKKO_ROADMAP_DIR`.
 *
 * ## And then that one directory turned out to be one project's
 *
 * `$KEHIKKO_ROADMAP_DIR/data/epics` is not "the host's epics". It is the epics
 * of one folder — `~/Projects/roadmap` — which is one project among however
 * many a person has. A host that read epics from a variable set at startup
 * could show a person a second project and go on answering `epics.list` out of
 * the first, correctly, with nothing to indicate it.
 *
 * So the root is a PARAMETER now and never an environment lookup. Every
 * function here takes the project folder it is to read under, and the caller —
 * `server.ts`, which knows which project the call was made from — is the one
 * that decides. `KEHIKKO_ROADMAP_DIR` survives as the seed for the first
 * project and nothing else reads it; see `adopt()` in `projects.ts`.
 *
 * ## Not every project has any
 *
 * The user's thesis folder has `main.tex`, `chapters/` and `references.bib` and
 * no `data/epics` at all. `epicsIn` answers null for it, every question below
 * refuses rather than inventing an empty answer, and the header says there are
 * no epics here. A host with no holdings says "not mine to say" and means it;
 * it does not say "no epics" and quietly mean "I was not configured". Those are
 * the two sentences the whole design exists to keep apart, and both a
 * misconfiguration and a project that genuinely has none must land on the
 * honest side of the line.
 *
 * ## Two directories, and the split between them is not ours
 *
 * `data/epics/<slug>.json` is what a person wrote: the title, the project, the
 * prose, the order of things. `data/state/<slug>.json` is what the trackers
 * last reported, written by a refresh and never by hand. The roadmap that owns
 * those files enforces the split, and this reads both without blurring it —
 * `epic.get` answers from the first, `live.get` from the second, and neither
 * borrows from the other.
 *
 * ## Read on every call, and cached not at all
 *
 * A refresh rewrites those files while this host is running. Anything cached
 * here would be a copy of what the trackers said at some earlier moment,
 * presented as what they say now, which is the failure this whole codebase has
 * spent its time on. The files are small and local; reading them per call costs
 * nothing worth having.
 */

/**
 * The project folder to read epics under, or null when there are none there.
 *
 * Null covers two different situations on purpose, because from here they are
 * the same one: no project is open, and the open project brings no epics. Both
 * mean this host has nothing under that name to hand over, and `answers.ts`
 * turns both into the same refusal — which is the truthful one either way.
 */
export function epicsIn(root: string | null | undefined): string | null {
  if (!root) return null
  return existsSync(join(root, 'data', 'epics')) ? root : null
}

/**
 * A slug, checked before it is put in a path.
 *
 * This arrives from a framed module over the wire. `../../etc/passwd` is a
 * string, and joining it onto a directory is how a read of somebody's own data
 * becomes a read of anything on the disk. The shape is the check, and it
 * refuses identically whether or not a file exists — a refusal that came faster
 * for a real slug than a made-up one would answer the question anyway.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

export interface EpicSummary {
  slug: string
  title?: string
  project?: string
  lede?: string
  /** How many things this epic names, when the file says. Never invented. */
  size?: number
}

/**
 * Every epic the roadmap holds.
 *
 * Sorted by title so the list is stable between calls; a list that reordered
 * itself on every refresh would make a module look like it was flickering.
 * Unreadable files are skipped rather than throwing — one corrupt epic must not
 * make the other ten unreachable — and skipping is safe here because the caller
 * is being told what exists, not being told nothing exists.
 */
export function listEpics(dir: string): EpicSummary[] {
  const epics: EpicSummary[] = []
  let files: string[]
  try {
    files = readdirSync(join(dir, 'data', 'epics'))
  } catch {
    return []
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const slug = file.slice(0, -'.json'.length)
    if (!SLUG.test(slug)) continue
    const epic = read(join(dir, 'data', 'epics', file))
    if (!epic) continue
    epics.push(summarise(slug, epic))
  }

  return epics.sort((a, b) => (a.title ?? a.slug).localeCompare(b.title ?? b.slug))
}

/**
 * One epic, reduced to what a picker is shown.
 *
 * Pulled out of `listEpics` when `retitleEpic` needed to answer with one epic
 * rather than the list. Two implementations of "what a summary is" would drift,
 * and the field that would drift first is the one being written: a retitle that
 * answered `{ slug, title }` while the list answered `{ slug, title, lede,
 * size }` would make the row that had just been edited the only row with no
 * count beside it.
 *
 * Only fields that are actually there, and only at the type they are actually
 * at. A title that arrived as a number is a title this host could not read, and
 * sending `String(title)` would put somebody's object id on screen as the name
 * of an epic.
 */
function summarise(slug: string, epic: Record<string, unknown>): EpicSummary {
  const summary: EpicSummary = { slug: str(epic.slug) ?? slug }
  const title = str(epic.title)
  if (title) summary.title = title
  const project = str(epic.project)
  if (project) summary.project = project
  const lede = str(epic.lede)
  if (lede) summary.lede = lede
  const size = countOf(epic)
  if (size !== null) summary.size = size
  return summary
}

/** One epic, exactly as it is written down. `null` when there is no such file. */
export function readEpic(dir: string, slug: string): Record<string, unknown> | null {
  if (!SLUG.test(slug)) return null
  return read(join(dir, 'data', 'epics', `${slug}.json`))
}

export type Retitled = { ok: true; epic: EpicSummary } | { ok: false; why: string; status: number }

/**
 * How long a title may be. Not a protocol number, because there is none.
 *
 * `LIMITS` bounds `EPIC_SLUG` and says nothing about a title, so this host
 * picks one and says why: the longest title on this machine is 90 characters,
 * across twelve epics in two projects, and the field under it — `lede` — is
 * where the sentence goes when the name has become a sentence. Two hundred is
 * far enough above the real ones to refuse nothing anybody wrote and low enough
 * that a paragraph pasted by accident is refused rather than drawn as the name
 * of an epic in a 220-pixel header.
 */
const TITLE_MAX = 200

/** Anything that is not one line of text. A title is one line. */
const NOT_ONE_LINE = /[\u0000-\u001f\u007f]/

/**
 * Change what one epic is CALLED. Its slug — what it IS — does not move.
 *
 * ## The two renames, and why only one of them is here
 *
 * An epic has a `slug` and a `title` and they are not the same thing, so
 * "rename" names two operations with two different costs.
 *
 * A title is a label. It lives in one field of one file, nothing keys off it,
 * and `listEpics` already falls back to the slug when it is missing — so
 * changing it is one write and it is over.
 *
 * A slug is an identity, and everything that has ever pointed at this epic
 * points at it by that string:
 *
 * - `canvases.epic`, the column this host writes when somebody picks an epic;
 * - `roadmap.context.epic`, which every framed module on the kehikko is told;
 * - `data/state/<slug>.json`, written by a tracker refresh and never by hand;
 * - `.kehikot/journeys/journeys.json`, a record whose KEYS are slugs;
 * - `.kehikot/checklist/<slug>.json`, one file per epic;
 * - `.kehikot/paper/<epic>/`, a whole DIRECTORY named by the slug, with
 *   somebody's chapters in it.
 *
 * All six were checked on this machine and all six are real. A re-slug that
 * renamed `data/epics/<slug>.json` and stopped there would leave a project's
 * papers, journeys, checklists and questions filed under a name nothing asks
 * for again — silently, because every one of those readers answers "nothing
 * here" for an unknown slug rather than failing. That is a migration across
 * six programs, four of which this host does not own and cannot see inside, and
 * it does not belong behind a pencil in a dropdown. It is not built, and the
 * control does not say "rename": it says what it does.
 *
 * ## What it refuses
 *
 * A slug that is not one, a title that is empty, a title longer than
 * `TITLE_MAX`, a title with a newline in it, a project with no `data/epics`, an
 * epic that is not in THIS project, and a file this host cannot read as JSON —
 * because overwriting a file you could not read is how somebody's narrative
 * becomes two fields and a lost afternoon.
 *
 * ## What it preserves
 *
 * Everything else in the file, byte for byte. These are hand-written documents
 * in somebody's repository, under their name in `git log`, and a host that
 * reformatted one while changing a label would put a hundred-line diff in front
 * of a person who changed six characters. See `withTitle`.
 */
export function retitleEpic(root: string, slug: string, title: string): Retitled {
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    return {
      ok: false,
      why: 'An epic is named by a slug: lowercase letters, digits and dashes, starting with a letter or a digit.',
      status: 400,
    }
  }
  if (typeof title !== 'string') {
    return { ok: false, why: 'A title is a line of text.', status: 400 }
  }

  const wanted = title.trim()
  if (!wanted) {
    return {
      ok: false,
      why: 'An epic has to be called something. Type a title, or leave the one it has.',
      status: 400,
    }
  }
  if (wanted.length > TITLE_MAX) {
    return {
      ok: false,
      why: `A title is at most ${TITLE_MAX} characters and that one is ${wanted.length}. The lede underneath it is where a longer sentence goes.`,
      status: 400,
    }
  }
  if (NOT_ONE_LINE.test(wanted)) {
    return { ok: false, why: 'A title is one line, and that one has a line break or a control character in it.', status: 400 }
  }

  if (!epicsIn(root)) {
    return { ok: false, why: 'This project has no data/epics, so there is no epic in it to retitle.', status: 409 }
  }

  const path = join(root, 'data', 'epics', `${slug}.json`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { ok: false, why: `There is no epic called ${slug} in this project.`, status: 404 }
  }

  const epic = parse(raw)
  if (!epic) {
    /* Read before written, always. `listEpics` skips a file it cannot parse and
       the epic simply does not appear; here the file has been named, so the
       refusal is a sentence — and the file is left exactly as it is, because a
       host that overwrote what it could not read would be turning a syntax
       error into a lost document. */
    return {
      ok: false,
      why: `${slug}.json could not be read as JSON, and this host will not overwrite a file it cannot read.`,
      status: 409,
    }
  }

  /* Already called that. Written only when it would change, for the reason
     `shareKehikot` gives about the `.gitignore`: pressing a control that is
     already where you pressed it must not put a modified file in somebody's
     `git status`. */
  if (str(epic.title) === wanted) return { ok: true, epic: summarise(slug, epic) }

  const next = withTitle(raw, wanted)
  if (next === null) {
    return {
      ok: false,
      why: `${slug}.json is not laid out in a way this host can change one field of without rewriting the rest of it. Its title can be edited by hand.`,
      status: 409,
    }
  }

  try {
    writeFileSync(path, next, 'utf8')
  } catch (error) {
    return { ok: false, why: `${slug}.json could not be written: ${(error as Error).message}`, status: 500 }
  }

  return { ok: true, epic: summarise(slug, { ...epic, title: wanted }) }
}

/**
 * The same file with one field changed, and every other byte where it was.
 *
 * ## Why this is not a `JSON.stringify`
 *
 * Round-tripping through `JSON.parse` and `JSON.stringify(epic, null, 2)` would
 * in fact reproduce both of the projects on this machine exactly — that is the
 * shape the roadmap's own `writeEpic` writes. It would also be this host
 * asserting that shape over a file it did not write, and the first file laid
 * out any other way would come back reformatted from top to bottom with the
 * person's own name on the commit. "Change one field" should change one field.
 *
 * ## Why it is not a regular expression either
 *
 * `"title"` is not a unique key in these documents. Every step in an epic has
 * one — `the-roadmap-tracks-itself.json` has dozens — so a pattern matching the
 * first `"title": "…"` in the text is a pattern that rewrites the title of a
 * step in some files and the epic in others, depending on nothing a person can
 * see. What is needed is the top-level member and only that, so the text is
 * walked rather than searched: `members` reads the outermost object's keys and
 * the exact span each value occupies, and the value's span is what is replaced.
 *
 * `null` when the file is not one object with named members — which the caller
 * turns into a refusal rather than a rewrite.
 */
export function withTitle(raw: string, title: string): string | null {
  const list = members(raw)
  if (!list) return null

  const found = list.find((member) => member.name === 'title')
  if (found) return raw.slice(0, found.valueStart) + JSON.stringify(title) + raw.slice(found.valueEnd)

  /* No title at all — which `listEpics` allows, falling back to the slug — so
     one is inserted rather than the file being rebuilt around it. It goes in
     front of the first member, at that member's own indentation, which is the
     only indentation this file has told us about. A first member that shares
     its line with the brace tells us nothing, and guessing there would be the
     reformatting this function exists to avoid. */
  const first = list[0]
  if (!first) return null
  const indent = raw.slice(raw.lastIndexOf('\n', first.start) + 1, first.start)
  if (!/^[ \t]+$/.test(indent)) return null
  return `${raw.slice(0, first.start)}"title": ${JSON.stringify(title)},\n${indent}${raw.slice(first.start)}`
}

interface Member {
  name: string
  /** Where the key's opening quote is. */
  start: number
  valueStart: number
  /** One past the last character of the value. */
  valueEnd: number
}

/**
 * The members of the outermost object, and where each value sits in the text.
 *
 * Deliberately strict and deliberately shallow: it walks the top level only,
 * skipping over nested objects and arrays as opaque spans, because the only
 * question being asked is "where is the outermost `title`". It is given text
 * that has already parsed as JSON — the caller parsed it before deciding to
 * write — so anything surprising here means the walk and the parser disagree,
 * and the honest answer to that is `null` rather than a byte offset.
 */
function members(raw: string): Member[] | null {
  let at = skip(raw, 0)
  if (raw[at] !== '{') return null
  at = skip(raw, at + 1)
  if (raw[at] === '}') return []

  const found: Member[] = []
  for (;;) {
    if (raw[at] !== '"') return null
    const start = at
    const keyEnd = endOfString(raw, at)
    if (keyEnd < 0) return null
    let name: string
    try {
      name = JSON.parse(raw.slice(start, keyEnd)) as string
    } catch {
      return null
    }

    at = skip(raw, keyEnd)
    if (raw[at] !== ':') return null
    const valueStart = skip(raw, at + 1)
    const valueEnd = endOfValue(raw, valueStart)
    if (valueEnd < 0) return null
    found.push({ name, start, valueStart, valueEnd })

    at = skip(raw, valueEnd)
    if (raw[at] === ',') {
      at = skip(raw, at + 1)
      continue
    }
    if (raw[at] === '}') return found
    return null
  }
}

/** The next index that is not whitespace. */
function skip(raw: string, from: number): number {
  let at = from
  while (at < raw.length && (raw[at] === ' ' || raw[at] === '\n' || raw[at] === '\r' || raw[at] === '\t')) at += 1
  return at
}

/** One past the closing quote of the string starting at `from`, or -1. */
function endOfString(raw: string, from: number): number {
  for (let at = from + 1; at < raw.length; at += 1) {
    /* A backslash escapes whatever follows it, including a quote and including
       another backslash. Counting the quote after `\\` as a closing one is the
       classic way a scanner like this loses its place in a document full of
       prose. */
    if (raw[at] === '\\') {
      at += 1
      continue
    }
    if (raw[at] === '"') return at + 1
  }
  return -1
}

/** One past the last character of the value starting at `from`, or -1. */
function endOfValue(raw: string, from: number): number {
  const first = raw[from]
  if (first === '"') return endOfString(raw, from)

  if (first === '{' || first === '[') {
    let depth = 0
    for (let at = from; at < raw.length; at += 1) {
      const char = raw[at]
      if (char === '"') {
        const end = endOfString(raw, at)
        if (end < 0) return -1
        /* Minus one, because the loop's own increment moves past the closing
           quote. Nested prose is why this whole walk exists: a `}` inside a
           step's body must not be counted as the end of anything. */
        at = end - 1
        continue
      }
      if (char === '{' || char === '[') depth += 1
      else if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) return at + 1
      }
    }
    return -1
  }

  /* A number, `true`, `false` or `null`: it ends where the member does. */
  let at = from
  while (at < raw.length && !',}] \n\r\t'.includes(raw[at]!)) at += 1
  return at > from ? at : -1
}

/**
 * What the trackers last reported about one epic.
 *
 * The file is handed back close to verbatim: its four bags — `issues`, `mrs`,
 * `ghIssues`, `ghPrs` — are the shape a module reading references already
 * expects, because both sides learned it from the same roadmap. `generated` is
 * carried with them, and it is the most important field in the answer: it is
 * the only thing that says how old this is, and a module drawing tracker state
 * with no date on it is a module presenting last week as now.
 */
export function readLive(dir: string, slug: string): Record<string, unknown> | null {
  if (!SLUG.test(slug)) return null
  return read(join(dir, 'data', 'state', `${slug}.json`))
}

/** The steps of one epic, when it has any written down. */
export function readSteps(dir: string, slug: string): unknown[] | null {
  const epic = readEpic(dir, slug)
  if (!epic) return null
  return Array.isArray(epic.steps) ? epic.steps : []
}

function read(path: string): Record<string, unknown> | null {
  try {
    return parse(readFileSync(path, 'utf8'))
  } catch {
    /* Absent, unreadable, or not JSON. All three mean the same thing to a
       caller — there is nothing here to hand over — and none of them is worth
       an exception thrown through a wire call. */
    return null
  }
}

/**
 * Text as one JSON object, or null.
 *
 * Split out of `read` for `retitleEpic`, which has already got the text — it
 * needs the bytes as well as the values, because it writes the bytes back — and
 * must not read the same file twice to get both. Two reads of one file are two
 * different files if anything writes between them, and a refresh rewriting
 * `data/` under a running host is the ordinary case here, not the exotic one.
 */
function parse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * How much an epic names, when that can be said honestly.
 *
 * `null` rather than `0` when there is nothing to count, because a module is
 * required to tell "no size given" from "a size of none" — see the reading
 * rules in Atlas, which say the same thing from the other end. A zero here
 * would be this host asserting a fact it does not have.
 */
function countOf(epic: Record<string, unknown>): number | null {
  const steps = Array.isArray(epic.steps) ? epic.steps.length : 0
  const exists = Array.isArray(epic.exists) ? epic.exists.length : 0
  const open = Array.isArray(epic.open) ? epic.open.length : 0
  const total = steps + exists + open
  return total > 0 ? total : null
}
