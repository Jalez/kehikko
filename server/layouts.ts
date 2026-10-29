import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BUILT_IN_LAYOUTS,
  containersOf,
  layoutFileSchema,
  layoutFromFile,
  layoutText,
  LAYOUT_VERSION,
  slugFor,
  type Layout,
  type LayoutSource,
} from '../src/host/layouts.ts'
import type { Canvas } from './canvases.ts'
import { hostPath } from './hostData.ts'
import { shared } from './kehikot.ts'
import { layoutsDir } from './machineDirs.ts'
import { makeUnderRoot, projectRootExists } from './projectRoot.ts'

/**
 * The suggested layouts on disk: the project's shelf
 * (`<project>/.kehikot/host/layouts/<slug>.json`, travels with the project) and
 * the person's own (`layoutsDir()`, this machine). The rules and the built-in
 * ones are `src/host/layouts.ts`.
 *
 * Read on every ask — a handful of small files — so a layout a teammate
 * committed is there after a `git pull` without a restart. A file that will not
 * read is left where it is and said in a sentence; it is a person's file.
 */

/** At most this many files are read from one shelf. */
const SHELF_MAX = 100

/** A project's layouts folder, or null when there is no project. */
export function projectLayoutsDir(projectPath: string | null | undefined): string | null {
  return hostPath(projectPath, 'layouts')
}

function shelf(dir: string | null, from: LayoutSource, trouble: string[]): Layout[] {
  if (dir === null || !existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.json') && slugFor(name.slice(0, -5)) === name.slice(0, -5))
      .sort()
      .slice(0, SHELF_MAX)
  } catch {
    return []
  }
  const out: Layout[] = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      const read = layoutFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
      if (!read.success) {
        const issue = read.error.issues[0]
        trouble.push(`${file} is not a layout: ${issue ? `${issue.path.join('.') || 'the top level'} ${issue.message}` : 'it did not read'}.`)
        continue
      }
      /* In the rows a canvas has now, whichever version wrote it. */
      const layout = layoutFromFile(read.data)
      out.push({ id: name.slice(0, -5), from, name: layout.name, summary: layout.summary, containers: layout.containers })
    } catch (error) {
      trouble.push(`${file} could not be read: ${(error as Error).message}.`)
    }
  }
  return out
}

export interface Shelves {
  builtIn: Layout[]
  project: Layout[]
  mine: Layout[]
  trouble: string[]
}

/** Every layout for a project (or none): ours, the project's and the person's. */
export function readShelves(projectPath: string | null, builtIn: readonly Layout[] = BUILT_IN_LAYOUTS): Shelves {
  const trouble: string[] = []
  const project = projectPath && projectRootExists(projectPath) ? shelf(projectLayoutsDir(projectPath), 'project', trouble) : []
  const mine = shelf(layoutsDir(), 'mine', trouble)
  return { builtIn: builtIn.map((one) => ({ ...one, containers: [...one.containers] })), project, mine, trouble }
}

export type Saved = { ok: true; layout: Layout; file: string } | { ok: false; why: string; status: 400 | 409 }

/**
 * Save one kehikko as a layout — the project's (`where: 'project'`) or this
 * person's (`'mine'`). Its placements as the shared file has them, so what
 * anybody had folded does not shape the layout. A name whose file already
 * exists is refused, not replaced: somebody may have committed it.
 */
export function saveLayout(
  canvas: Canvas,
  projectPath: string | null,
  ask: { name?: unknown; summary?: unknown; where?: unknown },
): Saved {
  const name = typeof ask.name === 'string' ? ask.name.trim() : ''
  if (!name) return { ok: false, why: 'A layout needs a name.', status: 400 }
  const slug = slugFor(name)
  if (!slug) return { ok: false, why: 'Give the layout a name with a letter or a digit in it.', status: 400 }
  if (ask.where !== 'project' && ask.where !== 'mine') {
    return { ok: false, why: 'A layout is saved for the project or for you.', status: 400 }
  }
  if (canvas.placements.length === 0) return { ok: false, why: 'There is nothing on this kehikko to save.', status: 400 }

  const parsed = layoutFileSchema.safeParse({
    version: LAYOUT_VERSION,
    name,
    summary: typeof ask.summary === 'string' ? ask.summary.trim() : '',
    containers: containersOf(shared(canvas.placements)),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, why: `That layout could not be saved: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(), status: 400 }
  }

  let dir: string
  if (ask.where === 'project') {
    const folder = projectLayoutsDir(projectPath)
    if (folder === null || projectPath === null || !makeUnderRoot(projectPath, folder)) {
      return { ok: false, why: 'This kehikko is in no project folder that is there, so there is nowhere to keep a project layout.', status: 400 }
    }
    dir = folder
  } else {
    dir = layoutsDir()
    mkdirSync(dir, { recursive: true })
  }
  const file = join(dir, `${slug}.json`)
  if (existsSync(file)) {
    return { ok: false, why: `There is already a layout called ${name} there (${slug}.json). Give this one another name.`, status: 409 }
  }
  writeFileSync(`${file}.tmp`, layoutText(parsed.data))
  renameSync(`${file}.tmp`, file)
  const where = ask.where
  return {
    ok: true,
    file,
    layout: { id: slug, from: where, name: parsed.data.name, summary: parsed.data.summary, containers: parsed.data.containers },
  }
}
