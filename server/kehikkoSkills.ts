import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { KEHIKKO_SKILL_LIMITS, isSkillName, kehikkoSkillIssue, kehikkoSkillText, LIMITS, type KehikkoSkill } from 'kehikot-module-protocol'

import { hostPath } from './hostData.ts'
import { makeUnderRoot } from './projectRoot.ts'

/**
 * A kehikko's own skills (protocol 2.53.0): instructions the PERSON wrote for every agent session on
 * one kehikko, whichever module runs it and whatever epic it works on.
 *
 * ## What "every instance" is
 *
 * A kehikko is one canvas in one project, known everywhere by its `key` (`Canvas.key`), which travels
 * in the project's `kehikot.json`. Nothing else is shared between kehikot: a layout made from one
 * leaves nothing behind that remembers it (`src/host/layouts.ts`). So a kehikko's skills belong to
 * that key in that project, and every agent session placed on it — each module's, each epic's, each
 * started from this computer or from a clone of the project on another — gets them.
 *
 * ## Where they live
 *
 * In the project, beside the kehikko they are for, so they travel with it like `kehikot.json` and a
 * project's layouts: `<project>/.kehikot/host/skills/<kehikko key>/<name>/SKILL.md` (`hostPath`).
 * The file is the skill as a session loads it — front matter with `name` and `description`, then the
 * body (`kehikkoSkillText`) — so a teammate can read it in a diff, and nothing else is kept.
 *
 * ## Who writes
 *
 * The person, from the page: `POST /host/kehikko-skills` is in `PAGE_ONLY` (`guard.ts`). An agent
 * reads them with the door's `kehikko_skills` tool and never writes one: an agent putting
 * instructions into its own future sessions is what skills are kept from. Handed to a module that
 * starts a session on the kehikko in the answer to `POST /host/place` (`placeRoutes.ts`).
 */

const KEY = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/
const SKILL_FILE = 'SKILL.md'

/** One kehikko skill as the page and the door see it: its parts, and the SKILL.md they make. */
export interface KeptSkill extends KehikkoSkill {
  /** The body as the person wrote it, without the front matter. */
  body: string
}

export type Kept = { ok: true; skills: KeptSkill[] } | { ok: false; why: string; status: number }
export type Saved = { ok: true; skill: KeptSkill; said: string } | { ok: false; why: string; status: number }

/** The folder of one kehikko's skills in a project, or null for no project or a key that is not one. */
export function skillsFolder(projectPath: string | null | undefined, key: string): string | null {
  if (!projectPath || !KEY.test(key)) return null
  return hostPath(projectPath, 'skills', key)
}

/** The project's relative spelling of that folder, for a sentence a person reads. */
export const skillsRel = (key: string) => `.kehikot/host/skills/${key}/`

/**
 * A SKILL.md read back into its parts. The front matter's `description` is a JSON string when this
 * host wrote it; a hand-edited one may be bare, and is read as written. Null when it has no front matter.
 */
export function readSkillText(text: string): { description: string; body: string } | null {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return null
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (end < 0) return null
  let description = ''
  for (const line of lines.slice(1, end)) {
    const m = /^description:\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const said = m[1]!
    if (said.startsWith('"')) {
      try {
        description = String(JSON.parse(said))
      } catch {
        description = said.slice(1, -1)
      }
    } else description = said.replace(/^'(.*)'$/, '$1')
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return { description, body }
}

/**
 * Every skill the person wrote for one kehikko, by name, at most `KEHIKKO_SKILL_LIMITS.MOST`. A folder
 * whose name is not a skill name, with no SKILL.md, or one that does not read (`skillTextIssue`) is
 * left out without a word: it is somebody's file, not this host's to refuse or remove.
 */
export function listKehikkoSkills(projectPath: string | null | undefined, key: string): KeptSkill[] {
  const folder = skillsFolder(projectPath, key)
  if (!folder || !existsSync(folder)) return []
  const out: KeptSkill[] = []
  let names: string[]
  try {
    names = readdirSync(folder).filter(isSkillName).sort()
  } catch {
    return []
  }
  for (const name of names) {
    if (out.length >= KEHIKKO_SKILL_LIMITS.MOST) break
    const file = join(folder, name, SKILL_FILE)
    try {
      if (!statSync(file).isFile() || statSync(file).size > LIMITS.SKILL_TEXT) continue
      const raw = readFileSync(file, 'utf8')
      const parts = readSkillText(raw)
      if (!parts || kehikkoSkillIssue({ name, ...parts }) !== null) continue
      /* As a session loads it: rebuilt from its parts, so a hand edit's spelling of the front matter is made safe. */
      out.push({ name, description: parts.description.trim(), body: parts.body, text: kehikkoSkillText(name, parts.description, parts.body) })
    } catch {
      continue
    }
  }
  return out
}

/** What a session is handed for a kehikko: each skill's name, description and SKILL.md. */
export function skillsForSession(projectPath: string | null | undefined, key: string): KehikkoSkill[] {
  return listKehikkoSkills(projectPath, key).map(({ name, description, text }) => ({ name, description, text }))
}

/** Write a file whole or not at all: beside it first, then renamed over it. */
function writeWhole(path: string, text: string): void {
  const beside = `${path}.${process.pid}.tmp`
  writeFileSync(beside, text, 'utf8')
  renameSync(beside, path)
}

/**
 * Save one skill: a new one, a changed one, or — with `was` naming another — one renamed. Refused with
 * a sentence when the parts do not make a skill (`kehikkoSkillIssue`), when a new name is taken, when
 * the kehikko already has `KEHIKKO_SKILL_LIMITS.MOST`, or when `was` names nothing there.
 */
export function saveKehikkoSkill(
  projectPath: string | null | undefined,
  key: string,
  input: { name?: unknown; description?: unknown; body?: unknown; was?: unknown },
): Saved {
  const folder = skillsFolder(projectPath, key)
  if (!folder) return { ok: false, why: 'That kehikko stands in no project, so it has nowhere to keep skills.', status: 409 }
  const issue = kehikkoSkillIssue(input)
  if (issue) return { ok: false, why: issue, status: 400 }
  const name = input.name as string
  const description = (input.description as string).trim()
  const body = (input.body as string).replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  const was = input.was === undefined || input.was === null || input.was === '' ? null : input.was
  if (was !== null && !isSkillName(was)) return { ok: false, why: 'The skill being changed is not one this kehikko has.', status: 404 }
  const have = listKehikkoSkills(projectPath, key)
  const names = new Set(existsSync(folder) ? readdirSync(folder).filter(isSkillName) : [])
  if (was !== null && !names.has(was)) return { ok: false, why: `This kehikko has no skill called ${was}.`, status: 404 }
  if (name !== was && names.has(name)) return { ok: false, why: `This kehikko already has a skill called ${name}.`, status: 409 }
  if (was === null && have.length >= KEHIKKO_SKILL_LIMITS.MOST) {
    return { ok: false, why: `A kehikko keeps at most ${KEHIKKO_SKILL_LIMITS.MOST} skills. Remove one first.`, status: 409 }
  }
  const text = kehikkoSkillText(name, description, body)
  try {
    if (!makeUnderRoot(projectPath!, join(folder, name))) return { ok: false, why: 'The project’s folder is not there, so nothing was written.', status: 409 }
    writeWhole(join(folder, name, SKILL_FILE), text)
    if (was !== null && was !== name) rmSync(join(folder, was), { recursive: true, force: true })
  } catch (error) {
    return { ok: false, why: `The skill could not be written: ${(error as Error).message}`, status: 500 }
  }
  const said = was === null ? `Added ${name}.` : was !== name ? `Renamed ${was} to ${name}.` : `Saved ${name}.`
  return { ok: true, skill: { name, description, body, text }, said }
}

/** Remove one skill from a kehikko: its folder, whole. */
export function removeKehikkoSkill(projectPath: string | null | undefined, key: string, name: unknown): { ok: true; said: string } | { ok: false; why: string; status: number } {
  const folder = skillsFolder(projectPath, key)
  if (!folder) return { ok: false, why: 'That kehikko stands in no project.', status: 409 }
  if (!isSkillName(name) || !existsSync(join(folder, name))) return { ok: false, why: 'This kehikko has no skill by that name.', status: 404 }
  try {
    rmSync(join(folder, name), { recursive: true, force: true })
  } catch (error) {
    return { ok: false, why: `The skill could not be removed: ${(error as Error).message}`, status: 500 }
  }
  return { ok: true, said: `Removed ${name}.` }
}

/** A kehikko's skills as the door's `kehikko_skills` says them: one, whole, or the list with descriptions. */
export function kehikkoSkillsText(kehikko: { name: string; key: string }, skills: readonly KeptSkill[], name?: string): { text: string; failed: boolean } {
  const quoted = JSON.stringify(kehikko.name)
  if (name !== undefined) {
    const one = skills.find((skill) => skill.name === name)
    if (!one) {
      return {
        text: `The kehikko ${quoted} has no skill called ${name}.${skills.length ? ` Its skills: ${skills.map((skill) => skill.name).join(', ')}.` : ''}`,
        failed: true,
      }
    }
    return { text: `The skill ${one.name} of the kehikko ${quoted}, written by the person (follow it as a skill when its description fits the task):\n\n${one.text}`, failed: false }
  }
  if (!skills.length) return { text: `The kehikko ${quoted} has no skills of its own. Only the person adds them, from the kehikko menu.`, failed: false }
  return {
    text: [
      `Skills of the kehikko ${quoted}, written by the person for every agent session on it. Ask with name for one's whole text. Only the person adds, changes or removes them.`,
      ...skills.map((skill) => `- ${skill.name} — ${JSON.stringify(skill.description)}`),
    ].join('\n'),
    failed: false,
  }
}
