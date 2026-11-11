import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lockSaid } from '../server/gitLocks.ts'
import { waitSaid } from '../src/host/autoUpdates.ts'
import { fromSourceSaid } from '../src/host/moduleBuilds.ts'
import { releaseSaid, steppedBackSaid, needsNewerSaid, type ModuleRelease } from '../src/host/moduleReleases.ts'
import { keptNote, moduleNote, previewText, staleNote } from '../src/host/updateModel.ts'
import { installRefusedSaid } from '../src/host/worksWith.ts'

/* Every state an update can end in, with the sentence a person reads. Plain words: what happened, and what they will see next. */

const INTERNAL = /\b(new code|old code|process|registration|checkout|frame|token|protocol)\b/i

describe('what an update says', () => {
  const installs = mkdtempSync(join(tmpdir(), 'wording-'))
  const copy = join(installs, 'm')
  mkdirSync(copy)
  const sentences: [string, string][] = [
    ['page only', moduleNote({ ran: 'page' })],
    ['restarted', moduleNote({ ran: 'restarted' })],
    ['started', moduleNote({ ran: 'started' })],
    ['not running', moduleNote({ ran: 'idle' })],
    ['kept running', keptNote('<name>')],
    ['not restarted', staleNote('it is set to stay running.')],
    ['preview, page', previewText('page')],
    ['preview, restart', previewText('restart')],
    ['preview, self', previewText('self')],
    ['preview, kept', previewText('kept')],
    ['waiting for a newer Kehikot', waitSaid('<name>', { until: 'app', target: 'v1.2.0', detail: '0.1.70' })],
    ['waiting for a newer Kehikot, version unknown', waitSaid('<name>', { until: 'app', target: 'v1.2.0', detail: '' })],
    ['retry', waitSaid('<name>', { until: 'retry', target: 'v1.2.0', detail: 'GitHub could not be reached.' })],
    ['build did not finish', fromSourceSaid('<name>')],
    ['install refused', installRefusedSaid('<name>', { protocol: '2.40.0', has: '2.30.0' })],
    ['stepped back', steppedBackSaid('<name>', 'v1.4.0')],
    ['leftover lock, installed copy', `<name> was not updated. ${lockSaid('/p/.git/index.lock', copy, { KEHIKOT_INSTALLS_DIR: installs })}`],
    ['leftover lock, own folder', lockSaid('/p/.git/index.lock', '/elsewhere/m', { KEHIKOT_INSTALLS_DIR: '/installs' })],
  ]

  test('each state has its sentence', () => {
    expect(Object.fromEntries(sentences)).toEqual({
      'page only': 'Updated. Only its page changed, so it reloads by itself.',
      restarted: 'Updated and restarted. Anything it was running was ended.',
      started: 'Updated and running.',
      'not running': "Updated. It isn't running right now; you'll get the new version next time you open a kehikko that uses it.",
      'kept running': "<name> was updated, but it's kept running so your open shells aren't cut off. Restart it when you're ready; restarting ends the shells running in it.",
      'not restarted': "Updated, but it wasn't restarted, so it may still be the old version: it is set to stay running.",
      'preview, page': 'Only its page changes; nothing is restarted.',
      'preview, restart': 'It will be restarted, which ends anything it is running.',
      'preview, self': 'It restarts itself on this change, which ends anything it is running.',
      'preview, kept': "It's set to stay running, so Kehikot won't restart it. Its page may still reload.",
      'waiting for a newer Kehikot': '<name> needs Kehikot 0.1.70 or later. It updates once you do.',
      'waiting for a newer Kehikot, version unknown': '<name> needs a newer Kehikot. It updates once you update Kehikot.',
      retry: '<name> could not be updated to 1.2.0: GitHub could not be reached. It will try again at the next check.',
      'build did not finish': "<name> works, but its build didn't finish. The log says why.",
      'install refused': '<name> needs a newer Kehikot than this one.',
      'stepped back': '<name> was moved back to 1.4.0, which works with this Kehikot.',
      'leftover lock, installed copy': '<name> was not updated. A leftover git lock file was left in its installed copy (/p/.git/index.lock). Kehikot removes it by itself when nothing is using it, and will try again at the next check.',
      'leftover lock, own folder': 'A leftover git lock file was left in this folder. If nothing is using it, remove the leftover lock file by hand: /p/.git/index.lock.',
    })
  })

  test('no internal terms, and every sentence starts with a capital or a placeholder and ends whole', () => {
    for (const [, said] of sentences) {
      expect(said).not.toMatch(INTERNAL)
      expect(said).toMatch(/^[A-Z<]/)
      expect(said).toMatch(/[.:]$|\.$/)
    }
  })

  test('release lines', () => {
    const base = { installed: 'v1.5.0', target: null, newest: 'v1.6.0', follows: 'releases' } as unknown as ModuleRelease
    expect(releaseSaid({ ...base, follows: 'main', installed: null, newest: null } as ModuleRelease)).toBe('follows the latest version (no releases yet)')
    expect(releaseSaid({ ...base, follows: 'ahead' } as ModuleRelease)).toBe('running a newer version than the 1.6.0 release')
    expect(needsNewerSaid({ needsNewer: { tag: 'v1.7.0', protocol: '2.40.0' } } as unknown as ModuleRelease)).toBe('1.7.0 is out; it needs a newer Kehikot.')
  })
})
