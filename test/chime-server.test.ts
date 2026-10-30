import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importSound, labelOf, looksLike, readChime, soundsRoute, wavSeconds } from '../server/chime.ts'
import { settingsRoute } from '../server/agentSettings.ts'
import { refusal, PAGE_ONLY } from '../server/guard.ts'
import { DEFAULT_SOUNDS, FILE_LIMITS } from '../src/host/chime.ts'
import { soundsDir } from '../server/machineDirs.ts'

/* The chime's host side: the settings row, and the person's own clips. */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch() {
  const db = new Database(':memory:')
  db.exec('create table if not exists settings (key text primary key, value text not null)')
  const dir = mkdtempSync(join(tmpdir(), 'chime-'))
  dirs.push(dir)
  const sounds = join(dir, 'sounds')
  return { db, dir: sounds, route: soundsRoute({ db, dir: () => sounds }) }
}

/** A mono 8 kHz 8-bit PCM WAV of this many seconds. */
function wav(seconds: number): Uint8Array {
  const rate = 8000
  const data = Math.round(seconds * rate)
  const out = new Uint8Array(44 + data)
  const view = new DataView(out.buffer)
  const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + data, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  text(36, 'data')
  view.setUint32(40, data, true)
  return out
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const post = (route: ReturnType<typeof soundsRoute>, path: string, body: unknown) => {
  const url = new URL(`http://127.0.0.1${path}`)
  return route(new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), url)
}
const get = (route: ReturnType<typeof soundsRoute>, path: string) => {
  const url = new URL(`http://127.0.0.1${path}`)
  return route(new Request(url), url)
}

describe('importing a sound', () => {
  test('keeps a good WAV under an id of the host’s own, with the file name as its label', async () => {
    const { db, dir, route } = scratch()
    const answer = await (await post(route, '/host/sounds', { name: 'Cheer.WAV', data: b64(wav(1.5)), seconds: 1.5 }))!.json()
    expect(answer.ok).toBe(true)
    expect(answer.sound).toMatchObject({ name: 'Cheer.WAV', ext: 'wav', seconds: 1.5 })
    expect(readdirSync(dir)).toEqual([`${answer.sound.id}.wav`])
    expect(readChime(db).files).toHaveLength(1)
  })

  test('refuses a type that is not a sound, with a sentence', () => {
    const { db, dir } = scratch()
    const out = importSound({ db, dir: () => dir }, { name: 'notes.txt', data: b64(new Uint8Array([1, 2, 3])), seconds: 1 })
    expect(out).toMatchObject({ ok: false })
    expect((out as { why: string }).why).toContain('wav, mp3, ogg, m4a, aac')
    expect(existsSync(dir)).toBe(false)
  })

  test('refuses bytes that are not what the name says', () => {
    const { db, dir } = scratch()
    const out = importSound({ db, dir: () => dir }, { name: 'a.mp3', data: b64(new Uint8Array(100)), seconds: 1 })
    expect((out as { why: string }).why).toContain('not really')
  })

  test('refuses a file over 1 MB', () => {
    const { db, dir } = scratch()
    const big = wav(1)
    const bigger = new Uint8Array(FILE_LIMITS.bytes + 10)
    bigger.set(big)
    const out = importSound({ db, dir: () => dir }, { name: 'big.wav', data: b64(bigger), seconds: 1 })
    expect((out as { why: string }).why).toContain('at most 1 MB')
  })

  test('refuses a WAV longer than 5 seconds by its own header, whatever the page said', () => {
    const { db, dir } = scratch()
    const out = importSound({ db, dir: () => dir }, { name: 'long.wav', data: b64(wav(6)), seconds: 1 })
    expect((out as { why: string }).why).toContain('at most 5 seconds')
  })

  test('refuses a compressed file the page says is long', () => {
    const { db, dir } = scratch()
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0])
    expect((importSound({ db, dir: () => dir }, { name: 'a.ogg', data: b64(ogg), seconds: 9 }) as { why: string }).why).toContain('at most 5 seconds')
    expect(importSound({ db, dir: () => dir }, { name: 'a.ogg', data: b64(ogg), seconds: 2 }).ok).toBe(true)
  })

  test('refuses a name with a path in it, and writes nothing outside the folder', async () => {
    const { dir, route } = scratch()
    for (const name of ['../evil.wav', '..\\evil.wav', '/etc/x.wav', 'a/b.wav', 'a\u0000.wav', '..']) {
      expect(labelOf(name)).toBeNull()
      const answer = await (await post(route, '/host/sounds', { name, data: b64(wav(1)), seconds: 1 }))!.json()
      expect(answer.ok).toBe(false)
    }
    expect(existsSync(dir)).toBe(false)
  })

  test('sniffs the formats', () => {
    expect(looksLike('wav', wav(1))).toBe(true)
    expect(looksLike('m4a', new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe(true)
    expect(looksLike('mp3', new Uint8Array([0xff, 0xfb, 0x90]))).toBe(true)
    expect(looksLike('aac', new Uint8Array([0xff, 0xf1, 0x50]))).toBe(true)
    expect(looksLike('wav', new Uint8Array([1, 2, 3]))).toBe(false)
    expect(wavSeconds(wav(2))).toBe(2)
  })
})

describe('serving, renaming and removing', () => {
  test('a sound is served by its id and only by an id the settings name', async () => {
    const { route } = scratch()
    const { sound } = await (await post(route, '/host/sounds', { name: 'a.wav', data: b64(wav(1)), seconds: 1 }))!.json()
    const ok = await get(route, `/host/sounds/${sound.id}`)
    expect(ok!.status).toBe(200)
    expect(ok!.headers.get('content-type')).toBe('audio/wav')
    expect((await ok!.arrayBuffer()).byteLength).toBe(44 + 8000)
    /* A dot-dot is resolved by the URL itself, and lands outside the route. */
    expect(await get(route, '/host/sounds/../../etc/passwd')).toBeNull()
    for (const path of ['/host/sounds/ffffffffffffffff', '/host/sounds/..%2F..%2Fetc%2Fpasswd', `/host/sounds/${sound.id}.wav`, '/host/sounds/', '/host/sounds/x']) {
      const answer = await get(route, path)
      expect(answer!.status).toBe(404)
    }
  })

  test('a name is changed by id; removing falls the kinds that used it back and says so', async () => {
    const { db, dir, route } = scratch()
    const { sound } = await (await post(route, '/host/sounds', { name: 'a.wav', data: b64(wav(1)), seconds: 1 }))!.json()
    expect((await (await post(route, '/host/sounds/rename', { id: sound.id, name: 'Victory' }))!.json()).chime.files[0].name).toBe('Victory')
    expect((await post(route, '/host/sounds/rename', { id: sound.id, name: '../x' }))!.status).toBe(400)
    /* In use by Finished, then removed. */
    const settings = settingsRoute({ db, status: () => ({ at: 0, running: false, problems: [], modules: [] }), changed: () => {}, skillsAt: () => '', hook: () => ({ file: '', on: false }) })
    const url = new URL('http://127.0.0.1/host/settings')
    const set = await settings(new Request(url, { method: 'POST', body: JSON.stringify({ chime: { sounds: { done: { type: 'file', id: sound.id } } } }) }), url)
    expect((await set!.json()).chime.sounds.done).toEqual({ type: 'file', id: sound.id })
    const gone = await (await post(route, '/host/sounds/remove', { id: sound.id }))!.json()
    expect(gone.said).toContain('Finished')
    expect(gone.said).toContain('went back to its default')
    expect(gone.chime.sounds.done).toEqual(DEFAULT_SOUNDS.done)
    expect(readdirSync(dir)).toEqual([])
    expect((await get(route, `/host/sounds/${sound.id}`))!.status).toBe(404)
  })
})

describe('the settings route', () => {
  const desk = () => {
    const { db } = scratch()
    const route = settingsRoute({ db, status: () => ({ at: 0, running: false, problems: [], modules: [] }), changed: () => {}, skillsAt: () => '', hook: () => ({ file: '', on: false }) })
    const url = new URL('http://127.0.0.1/host/settings')
    return { db, read: async () => (await (await route(new Request(url), url))!.json()).chime, post: (body: unknown) => route(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url) }
  }

  test('how long a toast stays: until dismissed by default, kept machine-wide, a bad value refused', async () => {
    const { db, read, post } = desk()
    expect((await read()).toastFor).toBe('dismiss')
    expect((await post({ chime: { toastFor: 7 } }))!.status).toBe(400)
    await post({ chime: { toastFor: 10 } })
    expect((await read()).toastFor).toBe(10)
    expect(readChime(db).toastFor).toBe(10)
    await post({ chime: { toastFor: 'dismiss' } })
    expect(readChime(db).toastFor).toBe('dismiss')
  })

  test('answers the chime, on by default, and keeps a mute and a chosen sound machine-wide', async () => {
    const { db, read, post } = desk()
    expect((await read()).on).toBe(true)
    await post({ chime: { on: false, sounds: { attention: { type: 'preset', id: 'playful' } } } })
    const now = await read()
    expect(now.on).toBe(false)
    expect(now.sounds.attention).toEqual({ type: 'preset', id: 'playful' })
    expect(readChime(db).on).toBe(false)
    expect(db.query("select count(*) as n from settings where key = 'inbox-chime'").get()).toEqual({ n: 1 })
  })

  test('keeps a custom tune and refuses one off the scale, a bad sound or an unknown file', async () => {
    const { read, post } = desk()
    const tune = { notes: [72, 76, null, 79], tempo: 140, wave: 'triangle', volume: 0.7 }
    expect((await post({ chime: { custom: tune } }))!.status).toBe(200)
    expect((await read()).custom).toEqual(tune)
    expect((await post({ chime: { custom: { ...tune, notes: [61, 76, 79] } } }))!.status).toBe(400)
    expect((await post({ chime: { sounds: { done: { type: 'file', id: '0123456789abcdef' } } } }))!.status).toBe(400)
    expect((await post({ chime: { sounds: { done: { type: 'preset', id: 'x' } } } }))!.status).toBe(400)
    expect((await read()).custom).toEqual(tune)
  })
})

describe('the page alone', () => {
  const self = { hosts: new Set(['127.0.0.1:4180']), origins: ['http://127.0.0.1:4180'] }
  const ask = (method: string, pathname: string, headers: Record<string, string>) =>
    refusal({ method, pathname, headers: new Headers({ host: '127.0.0.1:4180', ...headers }) }, self)

  test('every write is a page-only route; a program is refused, the page’s press is not', () => {
    for (const path of ['/host/sounds', '/host/sounds/rename', '/host/sounds/remove', '/host/settings']) expect(PAGE_ONLY).toContain(path)
    expect(ask('POST', '/host/sounds', { 'content-type': 'application/json' })).not.toBeNull()
    expect(ask('POST', '/host/sounds', { 'content-type': 'application/json', origin: 'http://127.0.0.1:4180' })).toBeNull()
    expect(ask('POST', '/host/sounds', { 'content-type': 'application/json', origin: 'https://evil.example' })).not.toBeNull()
  })

  test('the folder is the machine directory’s, and the suite never reaches the real one', () => {
    expect(soundsDir({ HOME: '/h' }, 'darwin')).toBe('/h/Library/Application Support/Kehikot/sounds')
    expect(soundsDir({ KEHIKOT_SOUNDS_DIR: '/x' })).toBe('/x')
    expect(soundsDir().startsWith(tmpdir()) || soundsDir().includes('/tmp') || soundsDir().includes('/var/folders')).toBe(true)
  })
})
