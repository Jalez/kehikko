import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isSkillName, LIMITS, skillPath, skillTextIssue, type ModuleSkill } from 'kehikot-module-protocol'

import { SKILL_STATUS_SAYS, type SkillRow, type SkillStatus } from '../src/host/skills.ts'

/**
 * Claude Code skills a module offers, installed by the PERSON (protocol 2.5.0).
 *
 * A module lists skills in `declares.skills` and serves each SKILL.md at
 * `skillPath(name)` on its own origin. A skill is instructions that land in
 * the person's Claude Code for every project, so nothing here installs one
 * on its own: the page shows the whole text (and for an update, what changed)
 * and the person presses. The server then fetches the text AGAIN from the
 * module — the registration's origin plus the path, never anything the
 * request carried — and writes it only if it is the text the person was
 * shown (`sha256`).
 *
 * What is written: `<skills>/<name>/SKILL.md` and a marker beside it
 * (`MARKER`) saying which module put it there, at which version, and the
 * sha256 of what was written. The marker is how this host tells its own
 * install from a skill somebody else made (`taken`), and an untouched install
 * from one the person edited (`edited`). An edited or foreign skill is never
 * overwritten or removed: the press is refused and the sentence says why.
 *
 * Page-only POSTs (`PAGE_ONLY` in `guard.ts`), and no MCP tool installs or
 * removes: an agent putting instructions into its own future sessions is the
 * thing this is built not to allow.
 */

type Env = Record<string, string | undefined>

/** The file beside SKILL.md that says Kehikot installed it. */
export const MARKER = '.kehikot-skill.json'
const SKILL_FILE = 'SKILL.md'
const FETCH_MS = 4000
const BODY_MAX = 4096

/**
 * Where Claude Code reads personal skills: `~/.claude/skills`.
 *
 * Beside the config file `agentConfigFile` names, so `CLAUDE_CONFIG` (which
 * the test suite points at a scratch `claude.json`) moves this too and a test
 * never reaches the real home. Otherwise `CLAUDE_CONFIG_DIR`, Claude Code's
 * own override, then the home directory.
 */
export function claudeSkillsDir(env: Env = process.env): string {
  if (env.CLAUDE_CONFIG) return join(dirname(env.CLAUDE_CONFIG), '.claude', 'skills')
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, 'skills')
  return join(env.HOME || homedir(), '.claude', 'skills')
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** What the marker records. */
export interface SkillMarker {
  module: string
  name: string
  version: string
  sha256: string
  at: string
}

/** What is on disk under one name, read against the module asking. */
export interface LocalSkill {
  /** `absent`, `taken` (not this module's, or not Kehikot's), `edited`, or `ours` (untouched). */
  kind: 'absent' | 'taken' | 'edited' | 'ours'
  marker: SkillMarker | null
  /** The installed SKILL.md, when there is one. */
  text: string | null
  /** For `taken`: whose it is, in words. */
  who?: string
}

function readMarker(path: string): SkillMarker | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SkillMarker>
    if (typeof raw.module !== 'string' || typeof raw.sha256 !== 'string' || typeof raw.name !== 'string') return null
    return { module: raw.module, name: raw.name, version: String(raw.version ?? ''), sha256: raw.sha256, at: String(raw.at ?? '') }
  } catch {
    return null
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** What is installed under `name`, as far as `module` is concerned. */
export function readLocal(root: string, name: string, module: string): LocalSkill {
  const dir = join(root, name)
  if (!existsSync(dir)) return { kind: 'absent', marker: null, text: null }
  const text = statSync(dir).isDirectory() ? readText(join(dir, SKILL_FILE)) : null
  const marker = readMarker(join(dir, MARKER))
  if (!marker) return { kind: 'taken', marker: null, text, who: 'a skill Kehikot did not install' }
  if (marker.module !== module) {
    return { kind: 'taken', marker, text, who: `a skill ${marker.module} installed` }
  }
  /* Anything but the two files is the person's addition, and so is a text that is not what was written. */
  const extra = readdirSync(dir).some((entry) => entry !== SKILL_FILE && entry !== MARKER)
  if (text === null || extra || sha256(text) !== marker.sha256) return { kind: 'edited', marker, text }
  return { kind: 'ours', marker, text }
}

/** One local reading and the module's current text, as a status. */
export function statusOf(local: LocalSkill, current: string | null): SkillStatus {
  if (local.kind === 'absent') return 'absent'
  if (local.kind === 'taken') return 'taken'
  if (local.kind === 'edited') return 'edited'
  if (current !== null && sha256(current) !== local.marker!.sha256) return 'outdated'
  return 'installed'
}

/** The module's SKILL.md, fetched from its own origin and read against the protocol. */
export type Fetched = { ok: true; text: string; sha256: string } | { ok: false; why: string }

export async function fetchSkillText(origin: string, name: string, fetcher: typeof fetch = fetch): Promise<Fetched> {
  if (!isSkillName(name)) return { ok: false, why: `"${String(name).slice(0, 41)}" is not a skill name.` }
  const at = new URL(skillPath(name), origin).toString()
  let response: Response
  try {
    /* `redirect: 'error'`: the text comes from the module's own origin or not at all. */
    response = await fetcher(at, { redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) })
  } catch (error) {
    return { ok: false, why: `Nothing answered at ${at}. ${(error as Error).message}` }
  }
  if (!response.ok) return { ok: false, why: `The module answered ${response.status} at ${at}.` }
  const length = Number(response.headers.get('content-length') ?? '0')
  if (length > LIMITS.SKILL_TEXT) return { ok: false, why: `The skill’s text is larger than ${LIMITS.SKILL_TEXT / 1024} KB.` }
  const bytes = await readCapped(response, LIMITS.SKILL_TEXT + 1)
  if (bytes.length > LIMITS.SKILL_TEXT) return { ok: false, why: `The skill’s text is larger than ${LIMITS.SKILL_TEXT / 1024} KB.` }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, why: 'The skill’s text is not UTF-8.' }
  }
  const issue = skillTextIssue(text, name)
  if (issue) return { ok: false, why: issue }
  return { ok: true, text, sha256: sha256(text) }
}

/** At most `cap` bytes of a body, without holding more than that. */
async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer()).slice(0, cap)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < cap) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(total, cap))
  let at = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, out.length - at)
    out.set(part, at)
    at += part.length
    if (at >= out.length) break
  }
  return out
}

export type Done = { ok: true; said: string } | { ok: false; why: string; status: number }

const markerFor = (module: string, skill: ModuleSkill, text: string): SkillMarker => ({
  module,
  name: skill.name,
  version: skill.version,
  sha256: sha256(text),
  at: new Date().toISOString(),
})

const tmpName = (root: string, name: string) => join(root, `.${name}.kehikot-${randomBytes(6).toString('hex')}`)

/** Write a file by renaming a sibling into place, so a reader never sees half of it. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.kehikot-${randomBytes(6).toString('hex')}`
  writeFileSync(tmp, content, { mode: 0o644 })
  renameSync(tmp, path)
}

function refusedFor(local: LocalSkill, name: string, root: string): Done | null {
  if (local.kind === 'taken') {
    return {
      ok: false,
      status: 409,
      why: `${join(root, name)} is ${local.who}. Kehikot will not write over it; rename or remove that folder yourself to install this one.`,
    }
  }
  if (local.kind === 'edited') {
    return {
      ok: false,
      status: 409,
      why: `${join(root, name)} has been changed since Kehikot installed it. Kehikot will not overwrite or remove your changes; move or delete that folder yourself first.`,
    }
  }
  return null
}

/** Install a skill that is not there yet. `text` is what the module served and the person was shown. */
export function installSkill(root: string, module: string, skill: ModuleSkill, text: string): Done {
  const local = readLocal(root, skill.name, module)
  const refused = refusedFor(local, skill.name, root)
  if (refused) return refused
  if (local.kind === 'ours') return { ok: false, status: 409, why: `${skill.name} is already installed. Update it instead.` }
  mkdirSync(root, { recursive: true })
  const tmp = tmpName(root, skill.name)
  try {
    mkdirSync(tmp)
    writeFileSync(join(tmp, SKILL_FILE), text, { mode: 0o644 })
    writeFileSync(join(tmp, MARKER), `${JSON.stringify(markerFor(module, skill, text), null, 2)}\n`)
    /* One rename makes the whole folder appear. It fails, and nothing is written, if a folder arrived meanwhile. */
    renameSync(tmp, join(root, skill.name))
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    return { ok: false, status: 500, why: `Could not write ${join(root, skill.name)}: ${(error as Error).message}` }
  }
  return { ok: true, said: `Installed ${skill.name} in ${join(root, skill.name)}.` }
}

/** Replace an untouched install with the module's current text. */
export function updateSkill(root: string, module: string, skill: ModuleSkill, text: string): Done {
  const local = readLocal(root, skill.name, module)
  const refused = refusedFor(local, skill.name, root)
  if (refused) return refused
  if (local.kind === 'absent') return { ok: false, status: 409, why: `${skill.name} is not installed. Install it instead.` }
  const dir = join(root, skill.name)
  try {
    /* The text first, then the marker: interrupted between the two, the folder reads as edited and is left alone. */
    writeAtomic(join(dir, SKILL_FILE), text)
    writeAtomic(join(dir, MARKER), `${JSON.stringify(markerFor(module, skill, text), null, 2)}\n`)
  } catch (error) {
    return { ok: false, status: 500, why: `Could not write ${dir}: ${(error as Error).message}` }
  }
  return { ok: true, said: `Updated ${skill.name} to ${skill.version}.` }
}

/** Remove an untouched install, and only that. */
export function removeSkill(root: string, module: string, name: string): Done {
  const local = readLocal(root, name, module)
  if (local.kind === 'absent') return { ok: false, status: 409, why: `${name} is not installed.` }
  const refused = refusedFor(local, name, root)
  if (refused) return refused
  const dir = join(root, name)
  try {
    unlinkSync(join(dir, SKILL_FILE))
    unlinkSync(join(dir, MARKER))
    rmdirSync(dir)
  } catch (error) {
    return { ok: false, status: 500, why: `Could not remove ${dir}: ${(error as Error).message}` }
  }
  return { ok: true, said: `Removed ${name} from ${root}.` }
}

/**
 * THE one way a skill is installed, updated or removed: the page's press goes
 * through it, and so will anything later that keeps skills in step without a
 * press (an app-wide "keep every module's skills installed" setting). Every
 * safety rule lives in the three functions it calls, not in the caller: an
 * edited skill is never overwritten or removed, a name that is not this
 * module's is never taken, and only an untouched install of this module's is
 * removed. `text` is the module's SKILL.md as fetched (`fetchSkillText`) and
 * is required for install and update.
 */
export type SkillMode = 'install' | 'update' | 'remove'
export function syncSkill(
  root: string,
  module: string,
  skill: ModuleSkill,
  mode: SkillMode,
  text?: string,
): Done {
  if (mode === 'remove') return removeSkill(root, module, skill.name)
  if (text === undefined) return { ok: false, status: 400, why: `To ${mode} ${skill.name}, the module's text is needed.` }
  return mode === 'install' ? installSkill(root, module, skill, text) : updateSkill(root, module, skill, text)
}

/** What the routes need to know about a module: found from the registry, never from the request. */
export type SkillsOf =
  | { ok: true; module: string; name: string; origin: string; skills: ModuleSkill[] }
  | { ok: false; why: string; status: number }

export interface SkillDeps {
  /** The module's registered origin and its manifest's skills, asked now. */
  lookup(module: string): Promise<SkillsOf>
  fetcher?: typeof fetch
  /** Where skills are installed; `claudeSkillsDir()` by default. */
  root?(): string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const moduleOf = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null

/** The module's skills with what is installed, for the dialog. */
export async function skillRows(found: Extract<SkillsOf, { ok: true }>, root: string, fetcher: typeof fetch = fetch): Promise<SkillRow[]> {
  return Promise.all(
    found.skills.map(async (skill): Promise<SkillRow> => {
      const fetched = await fetchSkillText(found.origin, skill.name, fetcher)
      const local = readLocal(root, skill.name, found.module)
      const status = statusOf(local, fetched.ok ? fetched.text : null)
      return {
        name: skill.name,
        summary: skill.summary,
        version: skill.version,
        status,
        says: SKILL_STATUS_SAYS[status],
        installedVersion: local.kind === 'ours' || local.kind === 'edited' ? (local.marker?.version ?? null) : null,
        text: fetched.ok ? fetched.text : null,
        sha256: fetched.ok ? fetched.sha256 : null,
        unreadable: fetched.ok ? null : fetched.why,
        installedText: status === 'outdated' || status === 'edited' || status === 'taken' ? local.text : null,
        path: join(root, skill.name),
        ...(local.who ? { who: local.who } : {}),
      }
    }),
  )
}

/**
 * `GET /host/skills?module=<id>`: the module's skills, each with its text and status.
 * `POST /host/skills` `{ module, name, press: 'install' | 'update' | 'remove', sha256? }`: one press.
 * The POST is in `PAGE_ONLY`.
 */
export function skillsRoute(deps: SkillDeps) {
  const fetcher = deps.fetcher ?? fetch
  const root = deps.root ?? (() => claudeSkillsDir())

  return async (request: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== '/host/skills') return null

    if (request.method === 'GET') {
      const module = moduleOf(url.searchParams.get('module'))
      if (!module) return json({ ok: false, why: 'A request for skills names one module.' }, 400)
      const found = await deps.lookup(module)
      if (!found.ok) return json({ ok: false, why: found.why }, found.status)
      const at = root()
      return json({ ok: true, module, name: found.name, writesTo: at, skills: await skillRows(found, at, fetcher) })
    }

    if (request.method !== 'POST') return json({ ok: false, why: 'GET or POST.' }, 405)

    const raw = await request.text()
    if (raw.length > BODY_MAX) return json({ ok: false, why: 'That request is too large.' }, 413)
    let body: { module?: unknown; name?: unknown; press?: unknown; sha256?: unknown }
    try {
      body = JSON.parse(raw)
    } catch {
      return json({ ok: false, why: 'The body is not JSON.' }, 400)
    }
    const module = moduleOf(body.module)
    const name = body.name
    const press = body.press
    if (!module || !isSkillName(name) || (press !== 'install' && press !== 'update' && press !== 'remove')) {
      return json({ ok: false, why: 'A press names a module, a skill and one of install, update or remove.' }, 400)
    }
    const found = await deps.lookup(module)
    if (!found.ok) return json({ ok: false, why: found.why }, found.status)
    const at = root()

    if (press === 'remove') {
      /* A skill the module stopped offering can still be removed: the marker says it is this module's. */
      const offered = found.skills.find((one) => one.name === name) ?? { name, summary: '', version: '' }
      const done = syncSkill(at, module, offered, 'remove')
      return done.ok ? json(done) : json(done, done.status)
    }

    const skill = found.skills.find((one) => one.name === name)
    if (!skill) return json({ ok: false, why: `${found.name} does not offer a skill called ${name}.` }, 404)
    const fetched = await fetchSkillText(found.origin, name, fetcher)
    if (!fetched.ok) return json({ ok: false, why: fetched.why }, 502)
    /* What is written is what the person read: a text that changed since is shown again first. */
    if (typeof body.sha256 !== 'string' || body.sha256 !== fetched.sha256) {
      return json({ ok: false, why: `${found.name} now serves a different text for ${name} than the one you read. Read it again before you accept it.` }, 409)
    }
    const done = syncSkill(at, module, skill, press, fetched.text)
    return done.ok ? json(done) : json(done, done.status)
  }
}
