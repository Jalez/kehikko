import { describe, expect, test } from 'bun:test'
import { settingsDeclarationSchema } from 'kehikot-module-protocol'

import { makeAsk, type CanvasControls } from '@/host/ask.ts'
import { ANSWERED_BY_THE_VIEW } from '@/host/division.ts'
import { SETTINGS_OPEN_SAYS, settingsOpenAsked } from '@/host/moduleSettings.ts'

/**
 * A module's page opening its own settings at one setting (protocol 2.90.0, `settings.open`): the
 * page's dialog, on the person's press, only a setting the module declared.
 */

const ME = 'example.tool'
const fields = settingsDeclarationSchema.parse([{ key: 'limit', label: 'Limit', type: 'number', default: 0, scope: 'machine' }])

describe('settingsOpenAsked', () => {
  test('opens at a declared setting, or at the top, on the person press', () => {
    expect(settingsOpenAsked({ name: 'Tool', fields, key: 'limit', pressed: true })).toEqual({ outcome: 'opened', why: '', target: 'limit' })
    expect(settingsOpenAsked({ name: 'Tool', fields, key: undefined, pressed: true })).toEqual({ outcome: 'opened', why: '', target: null })
  })
  test('declines without a press, without settings, or for a key it did not declare', () => {
    expect(settingsOpenAsked({ name: 'Tool', fields, key: 'limit', pressed: false })).toEqual({ outcome: 'declined', why: SETTINGS_OPEN_SAYS.noPress })
    expect(settingsOpenAsked({ name: 'Tool', fields: [], key: undefined, pressed: true })).toEqual({ outcome: 'declined', why: 'Tool has no settings it shows here.' })
    expect(settingsOpenAsked({ name: 'Tool', fields, key: 'other', pressed: true })).toEqual({ outcome: 'declined', why: 'Tool has no such setting.' })
  })
})

describe('settings.open on the wire', () => {
  const asked: { from: string; key?: string; pressed: boolean }[] = []
  const controls = {
    openSettings: (from: string, call: { key?: string }, pressed: boolean) => {
      asked.push({ from, ...call, pressed })
      return pressed ? { outcome: 'opened', why: '' } : { outcome: 'declined', why: 'no press' }
    },
  } as unknown as CanvasControls

  test('is answered by the page', () => {
    expect(ANSWERED_BY_THE_VIEW as readonly string[]).toContain('settings.open')
  })

  test('carries who asked, the key and whether the press was fresh', async () => {
    const ask = makeAsk(ME, controls)
    expect(await ask('settings.open', { key: 'limit' }, { pressed: true })).toEqual({ ok: true, data: { outcome: 'opened', why: '' } })
    expect(await ask('settings.open', {})).toEqual({ ok: true, data: { outcome: 'declined', why: 'no press' } })
    expect(asked).toEqual([
      { from: ME, key: 'limit', pressed: true },
      { from: ME, pressed: false },
    ])
    expect((await ask('settings.open', { key: 'Not A Key' }, { pressed: true })).ok).toBe(false)
  })

  test('a canvas without it declines; a module that did not declare settings:open is declined', async () => {
    expect(await makeAsk(ME, {} as CanvasControls)('settings.open', {}, { pressed: true })).toEqual({ ok: true, data: { outcome: 'declined', why: 'This canvas opens no settings.' } })
    const out = await makeAsk(ME, controls, () => false)('settings.open', {}, { pressed: true })
    expect(out.ok).toBe(true)
    if (out.ok) expect((out.data as { outcome: string }).outcome).toBe('declined')
  })
})
