import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  LIMITS,
  dispositionSchema,
  moduleFile,
  type Disposition,
  type DispositionValue,
} from 'roadmap-module-protocol'
import { z } from 'zod'

import { HOST_ID } from './kehikot.ts'

/**
 * Why a project's closed references closed, in people's words.
 *
 * A tracker's `closed` covers finished work, work nobody will do, a duplicate
 * and something replaced by something else, and a module that reads `closed` as
 * `done` counts the last three as delivered. A disposition is somebody saying
 * which one it was. See `dispositionSchema` in the protocol's `wire.ts`.
 *
 * ## Per project, in the project
 *
 * `<project>/.kehikot/kehikko/dispositions.json`, beside `kehikot.json`, spelled
 * with `moduleFile` like everything this host keeps for a project. A verdict on
 * `#2274` is about the work and not about a canvas or a machine, so it travels
 * with the repository the way the arrangement does, and every kehikko standing
 * in that project reads the same marks.
 *
 * ## Only the marks
 *
 * What a tracker says about a close — GitHub's `stateReason`, an issue closed by
 * a merged change — is a DEFAULT, and it is not written here. Every module that
 * holds a tracker reading derives it on its own side (`deriveDisposition` in the
 * protocol's `facets.ts`) and a mark wins over it there. Kept apart, a module
 * can always say which one it is showing: "you said won't do" and "GitHub says
 * not planned" are different sentences, and a store that mixed them could only
 * ever say the first.
 *
 * ## `by` and `at` are this host's to fill in
 *
 * Neither arrives with the call. Who pressed and when are facts the host has
 * and the caller does not get to assert — a module that could write `by` could
 * write somebody else's name. The host writes the module's name for a press
 * inside a frame and says it was an agent for a call through its MCP door.
 */

/** The one file, named once, for the reason `moduleFile()` insists on a constant. */
const FILE_NAME = 'dispositions'

/** What is written at the top of the file, so a reader — or a later version — knows which shape this is. */
const VERSION = 1

const fileSchema = z
  .object({
    version: z.literal(VERSION),
    dispositions: z.array(dispositionSchema).max(LIMITS.DISPOSITIONS),
  })
  .strict()

/** The file for a project, or null when there is no project path to put it under. */
export function dispositionsFile(projectPath: string | null | undefined): string | null {
  return moduleFile(projectPath, HOST_ID, FILE_NAME)
}

/** One mark as it is asked for: `value: null` takes the ref's mark back. */
export interface Marking {
  ref: string
  value: DispositionValue | null
  target?: string
  note?: string
}

export type Read =
  | { ok: true; marks: Disposition[] }
  /* A file that is there and will not read. Not the same as no file: a
     hand-edit gone wrong is somebody's verdicts, and writing over it would
     throw them away without a word. */
  | { ok: false; file: string; why: string }

/**
 * The project's marks, or why they could not be read.
 *
 * No file is no marks, which is the true answer for a project where nobody has
 * said anything. Callers that only need something to show — the context every
 * module is told — use `marksOf`, which reads a broken file as nothing; a write
 * uses this and refuses, so it never replaces a file it could not read.
 */
export function readDispositions(projectPath: string | null | undefined): Read {
  const file = dispositionsFile(projectPath)
  if (file === null) return { ok: true, marks: [] }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: true, marks: [] }
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(text))
    if (parsed.success) return { ok: true, marks: parsed.data.dispositions }
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'the file'
    return { ok: false, file, why: `${where}: ${issue?.message ?? 'not the shape this host writes'}` }
  } catch {
    return { ok: false, file, why: 'it is not JSON' }
  }
}

/** The marks to tell modules about, with a file that will not read as none. */
export function marksOf(projectPath: string | null | undefined): Disposition[] {
  const read = readDispositions(projectPath)
  return read.ok ? read.marks : []
}

export type Marked =
  | { ok: true; marks: Disposition[]; mark: Disposition | null; changed: boolean }
  | { ok: false; why: string }

/**
 * Mark one ref, or take its mark back, and write the file.
 *
 * One mark per ref: a new verdict replaces the old one rather than piling up
 * beside it, because `context.dispositions` is "what has been said about each
 * ref" and two rows for one ref would be two answers to one question. A mark
 * that says exactly what the stored one already says is not rewritten — not
 * even its `at` — so that pressing the same thing twice does not put a change
 * in a file git is watching.
 *
 * The write is a rename over the old file, as `keep` in `kehikot.ts` does it,
 * so a crash mid-write leaves the previous verdicts whole.
 */
export function setDisposition(
  projectPath: string | null | undefined,
  marking: Marking,
  by: string,
  now: Date = new Date(),
): Marked {
  const file = dispositionsFile(projectPath)
  if (file === null) {
    return { ok: false, why: 'There is no project open, so there is nowhere to keep a disposition.' }
  }
  const read = readDispositions(projectPath)
  if (!read.ok) {
    return {
      ok: false,
      why: `${file} is there and will not read (${read.why}), so nothing was written over it. Fix or remove it first.`,
    }
  }

  const before = read.marks.find((mark) => mark.ref === marking.ref) ?? null
  const others = read.marks.filter((mark) => mark.ref !== marking.ref)

  if (marking.value === null) {
    if (!before) return { ok: true, marks: read.marks, mark: null, changed: false }
    write(file, others)
    return { ok: true, marks: others, mark: null, changed: true }
  }

  const target = marking.target ?? null
  const note = marking.note ?? ''
  if (before && before.value === marking.value && before.target === target && before.note === note) {
    return { ok: true, marks: read.marks, mark: before, changed: false }
  }
  if (!before && read.marks.length >= LIMITS.DISPOSITIONS) {
    return {
      ok: false,
      why: `This project already holds ${LIMITS.DISPOSITIONS} dispositions, which is as many as a context can carry. Take one back first.`,
    }
  }

  const mark = dispositionSchema.parse({
    ref: marking.ref,
    value: marking.value,
    target,
    note,
    by: by.slice(0, LIMITS.NAME),
    at: now.toISOString(),
  })
  /* Where it was, when it was there: a file somebody reads in a diff should
     show a changed line rather than one removed and one added at the end. */
  const marks = before ? read.marks.map((one) => (one.ref === mark.ref ? mark : one)) : [...read.marks, mark]
  write(file, marks)
  return { ok: true, marks, mark, changed: true }
}

function write(file: string, marks: readonly Disposition[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: VERSION, dispositions: marks }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}
