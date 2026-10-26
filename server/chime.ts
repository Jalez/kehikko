import type { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  chimeFrom,
  FILE_ID,
  FILE_LIMITS,
  withoutFile,
  fellBackWords,
  type ChimeSettings,
  type SoundFile,
} from '../src/host/chime.ts'
import { soundsDir } from './machineDirs.ts'

/**
 * The Inbox chime's settings and the person's own sounds. The rules and the
 * shapes are `src/host/chime.ts`.
 *
 * ## Where
 *
 * The settings are one row of the host's `settings` table (`inbox-chime`):
 * machine-wide, like "Keep modules up to date automatically". The clips are
 * files in `soundsDir()` named `<id>.<ext>` by an id this host made; the
 * person's file name is only a label in the row, so no name from the page ever
 * becomes a path. A clip is played by `GET /host/sounds/<id>`, which serves
 * only an id the row names. The writes are the page's alone (`PAGE_ONLY`), and
 * no MCP tool sees any of it.
 *
 * ## What is checked
 *
 * Here: the extension, the size, that the bytes are what the extension says
 * (a header sniff), a name with no path in it, and — for a WAV, whose length
 * is in its header — the duration. For the compressed formats the length is
 * the page's (it decoded the clip before sending it) and is bounded, and the
 * size cap bounds what a lie can cost.
 */

const KEY = 'inbox-chime'

export function readChime(db: Database): ChimeSettings {
  try {
    const row = db.query<{ value: string }, [string]>('select value from settings where key = ?').get(KEY)
    return chimeFrom(row ? (JSON.parse(row.value) as unknown) : null)
  } catch {
    return chimeFrom(null)
  }
}

export function writeChime(db: Database, settings: ChimeSettings): void {
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  db.query('insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value').run(KEY, JSON.stringify(settings))
}

const MIME: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' }

/** Whether the bytes begin the way a file of this extension does. */
export function looksLike(ext: string, bytes: Uint8Array): boolean {
  const text = (from: number, length: number) => String.fromCharCode(...bytes.slice(from, from + length))
  switch (ext) {
    case 'wav':
      return text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE'
    case 'ogg':
      return text(0, 4) === 'OggS'
    case 'm4a':
      return text(4, 4) === 'ftyp'
    case 'mp3':
      return text(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    case 'aac':
      return text(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf0) === 0xf0)
    default:
      return false
  }
}

/** The length of a PCM WAV in seconds, from its header; `null` when it cannot be read. */
export function wavSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let byteRate = 0
  let at = 12
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.slice(at, at + 4))
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ' && at + 20 <= bytes.length) byteRate = view.getUint32(at + 16, true)
    if (id === 'data') {
      /* A streamed file may say 0 or too much for its data; what is there is what plays. */
      const have = Math.min(size === 0 ? bytes.length : size, bytes.length - (at + 8))
      return byteRate > 0 ? have / byteRate : null
    }
    at += 8 + size + (size % 2)
  }
  return null
}

/** A name that is a file's name and nothing more: no path, no control characters. `null` otherwise. */
export function labelOf(name: unknown): string | null {
  if (typeof name !== 'string') return null
  if (/[\\/\u0000-\u001f]/.test(name) || name.includes('..')) return null
  const clean = name.trim()
  return clean && clean.length <= FILE_LIMITS.nameMax ? clean : null
}

export interface SoundsDeps {
  db: Database
  /** Where the clips are; `soundsDir()`. */
  dir?: () => string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

const SENT_MAX = Math.ceil((FILE_LIMITS.bytes * 4) / 3) + 4096

export type Imported = { ok: true; sound: SoundFile; chime: ChimeSettings } | { ok: false; why: string }

/** A clip the page sent, checked and kept. The refusal is a sentence for the person. */
export function importSound(deps: SoundsDeps, sent: { name?: unknown; data?: unknown; seconds?: unknown }): Imported {
  const dir = (deps.dir ?? soundsDir)()
  const label = labelOf(sent.name)
  if (!label) return { ok: false, why: 'That file has no name Kehikot can use. Rename it to a plain file name and add it again.' }
  const ext = label.includes('.') ? label.slice(label.lastIndexOf('.') + 1).toLowerCase() : ''
  if (!(FILE_LIMITS.exts as readonly string[]).includes(ext)) {
    return { ok: false, why: `Sounds are ${FILE_LIMITS.exts.join(', ')} files. “${label}” is not one.` }
  }
  if (typeof sent.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(sent.data)) return { ok: false, why: 'The file did not arrive whole. Try adding it again.' }
  const bytes = new Uint8Array(Buffer.from(sent.data, 'base64'))
  if (bytes.length === 0) return { ok: false, why: 'That file is empty.' }
  if (bytes.length > FILE_LIMITS.bytes) {
    return { ok: false, why: `Sounds are at most ${FILE_LIMITS.bytes / 1024 / 1024} MB. “${label}” is ${(bytes.length / 1024 / 1024).toFixed(1)} MB.` }
  }
  if (!looksLike(ext, bytes)) return { ok: false, why: `“${label}” is not really a ${ext} file.` }
  const told = typeof sent.seconds === 'number' && Number.isFinite(sent.seconds) && sent.seconds > 0 ? sent.seconds : null
  const seconds = ext === 'wav' ? (wavSeconds(bytes) ?? told) : told
  if (seconds === null) return { ok: false, why: `Could not tell how long “${label}” is.` }
  if (seconds > FILE_LIMITS.seconds) {
    return { ok: false, why: `Sounds are at most ${FILE_LIMITS.seconds} seconds. “${label}” is ${seconds.toFixed(1)}.` }
  }
  const was = readChime(deps.db)
  if (was.files.length >= FILE_LIMITS.count) return { ok: false, why: `That is ${FILE_LIMITS.count} sounds already. Remove one first.` }
  const id = randomBytes(8).toString('hex')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.${ext}`), bytes)
  const sound: SoundFile = { id, name: label, ext, bytes: bytes.length, seconds: Math.round(seconds * 100) / 100 }
  const chime = { ...was, files: [...was.files, sound] }
  writeChime(deps.db, chime)
  return { ok: true, sound, chime }
}

/** `GET /host/sounds/<id>`, `POST /host/sounds`, `/host/sounds/rename`, `/host/sounds/remove`. Null for any other request. */
export function soundsRoute(deps: SoundsDeps) {
  const dir = () => (deps.dir ?? soundsDir)()
  return async (request: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname
    if (path !== '/host/sounds' && !path.startsWith('/host/sounds/')) return null

    if (request.method === 'GET') {
      const id = path.slice('/host/sounds/'.length)
      /* Only an id this host made, and only one the settings still name: never a path. */
      if (!FILE_ID.test(id)) return json({ ok: false, why: 'There is no such sound.' }, 404)
      const file = readChime(deps.db).files.find((one) => one.id === id)
      const at = file ? join(dir(), `${file.id}.${file.ext}`) : null
      if (!file || !at || !existsSync(at)) return json({ ok: false, why: 'There is no such sound.' }, 404)
      return new Response(readFileSync(at), {
        headers: { 'content-type': MIME[file.ext] ?? 'application/octet-stream', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' },
      })
    }
    if (request.method !== 'POST') return json({ ok: false, why: 'GET or POST.' }, 405)

    const raw = await request.text()
    if (raw.length > SENT_MAX) return json({ ok: false, why: `Sounds are at most ${FILE_LIMITS.bytes / 1024 / 1024} MB.` }, 413)
    let body: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
      body = parsed as Record<string, unknown>
    } catch {
      return json({ ok: false, why: 'The body is a JSON object.' }, 400)
    }

    if (path === '/host/sounds') {
      const done = importSound(deps, body)
      return done.ok ? json(done) : json(done, 400)
    }
    const was = readChime(deps.db)
    const id = typeof body.id === 'string' ? body.id : ''
    const file = was.files.find((one) => one.id === id)
    if (!file) return json({ ok: false, why: 'There is no such sound.' }, 404)
    if (path === '/host/sounds/rename') {
      const label = labelOf(body.name)
      if (!label) return json({ ok: false, why: 'That is not a name for a sound.' }, 400)
      const chime = { ...was, files: was.files.map((one) => (one.id === id ? { ...one, name: label } : one)) }
      writeChime(deps.db, chime)
      return json({ ok: true, chime })
    }
    if (path === '/host/sounds/remove') {
      const out = withoutFile(was, id)
      writeChime(deps.db, out.settings)
      rmSync(join(dir(), `${file.id}.${file.ext}`), { force: true })
      return json({ ok: true, chime: out.settings, said: fellBackWords(file.name, out.fellBack, out.modules) })
    }
    return json({ ok: false, why: 'There is no such sound route.' }, 404)
  }
}
