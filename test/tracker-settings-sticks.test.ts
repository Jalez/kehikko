import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { editTrackers } from '../server/trackers/edit.ts'
import { Trackers } from '../server/trackers/reading.ts'

/**
 * A change in Settings › Trackers is one write, kept: turning a remote off and on, the remotes
 * switch, and the person's `reading` mode all survive each other's edits.
 */

let folder: string
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kehikko-tracker-sticks-')))
})
afterEach(() => rmSync(folder, { recursive: true, force: true }))

const fileOf = () => join(folder, '.kehikot', 'host', 'trackers.json')
const json = () => JSON.parse(readFileSync(fileOf(), 'utf8'))
const put = (value: unknown) => {
  mkdirSync(join(folder, '.kehikot', 'host'), { recursive: true })
  writeFileSync(fileOf(), JSON.stringify(value))
}
const ORIGIN = [{ name: 'origin', url: 'https://github.com/Jalez/kehikko.git' }]
const OWN = { tracker: 'github', host: 'github.com', repo: 'Jalez/kehikko' } as const

describe('turning a remote off and on', () => {
  test('off writes the entry, on takes it away again, and the reading mode is kept throughout', () => {
    put({ version: 1, reading: 'manual', every: 30 })
    expect(editTrackers(folder, { kind: 'set', ...OWN, off: true }, ORIGIN).outcome).toBe('changed')
    expect(json()).toEqual({ version: 1, sources: [{ tracker: 'github', repo: 'Jalez/kehikko', off: true }], every: 30, reading: 'manual' })

    const back = editTrackers(folder, { kind: 'set', ...OWN, off: false }, ORIGIN)
    expect(back.outcome).toBe('changed')
    expect(json()).toEqual({ version: 1, sources: [], every: 30, reading: 'manual' })
  })

  test('the remotes switch off and on again writes the key each time and keeps the rest', () => {
    put({ version: 1, reading: 'off', sources: [{ tracker: 'github', repo: 'a/b', list: true }] })
    expect(editTrackers(folder, { kind: 'remotes', on: false }, ORIGIN).outcome).toBe('changed')
    expect(json().remotes).toBe(false)
    expect(editTrackers(folder, { kind: 'remotes', on: true }, ORIGIN).outcome).toBe('changed')
    expect(json()).toEqual({ version: 1, sources: [{ tracker: 'github', repo: 'a/b', list: true }], remotes: true, reading: 'off' })
  })

  test('a mode edit keeps the sources, and a source edit keeps the mode', () => {
    expect(editTrackers(folder, { kind: 'set', ...OWN, off: true }, ORIGIN).outcome).toBe('changed')
    expect(editTrackers(folder, { kind: 'mode', mode: 'manual' }, ORIGIN).outcome).toBe('changed')
    expect(json().sources).toHaveLength(1)
    expect(editTrackers(folder, { kind: 'set', ...OWN, off: false }, ORIGIN).outcome).toBe('changed')
    expect(json().reading).toBe('manual')
  })

  test('the listing the page is handed after the edit is what is on disk', async () => {
    const trackers = new Trackers({ run: async () => ({ ok: true, stdout: '', stderr: '' }) } as never)
    put({ version: 1 })
    const off = await trackers.edit(folder, { kind: 'remotes', on: false })
    expect(off.listing.remotes).toBe(false)
    const on = await trackers.edit(folder, { kind: 'remotes', on: true })
    expect(on.listing.remotes).toBe(true)
    expect(existsSync(fileOf())).toBe(true)
    expect(json().remotes).toBe(true)
  })
})
