import { afterEach, describe, expect, test } from 'bun:test'

import { appEngine, connect, readStatus, type AppUpdateStatus } from '../src/host/appUpdate.ts'
import { appRow, indicator, moduleRow, stateText, updateRows, type UpdateRow } from '../src/host/updateModel.ts'
import type { Reading } from '../src/host/updates.ts'

/* One update model: the desktop app's updater and the module checkouts, read
   into the same rows and summed up into one header line. */

const status = (more: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  enabled: true,
  current: '0.1.1',
  state: 'uptodate',
  version: null,
  progress: null,
  error: null,
  checkedAt: 1,
  ...more,
})

const checkout = (id: string, behind: number, more: Partial<Reading> = {}): Reading => ({
  id,
  name: id,
  dir: `/${id}`,
  branch: 'main',
  commit: 'abc1234',
  dirty: false,
  upstream: 'origin/main',
  behind,
  ahead: 0,
  incoming: [],
  fetchFailed: null,
  blocked: behind ? null : 'already up to date',
  ...more,
})

describe('the app row', () => {
  test('is absent without an engine, and when the engine never checks', () => {
    expect(appRow(null)).toBeNull()
    expect(appRow(status({ enabled: false }))).toBeNull()
  })

  test('maps every engine state onto the shared vocabulary', () => {
    const at = (more: Partial<AppUpdateStatus>) => appRow(status(more))!
    expect(at({ state: 'idle' }).state).toBe('unknown')
    expect(at({ state: 'checking' }).state).toBe('checking')
    expect(at({ state: 'uptodate' }).state).toBe('uptodate')
    const downloading = at({ state: 'downloading', version: '0.1.2', progress: 0.45 })
    expect(downloading).toMatchObject({ state: 'updating', activity: 'downloading', progress: 0.45, version: '0.1.2' })
    expect(at({ state: 'downloading', progress: 7 }).progress).toBe(1)
    expect(at({ state: 'installing', version: '0.1.2' })).toMatchObject({ state: 'updating', activity: 'installing' })
    expect(at({ state: 'ready', version: '0.1.2' })).toMatchObject({ state: 'ready', version: '0.1.2' })
    expect(at({ state: 'failed', error: 'signature mismatch' })).toMatchObject({ state: 'failed', reason: 'signature mismatch' })
    expect(at({ state: 'failed' }).reason).toContain('did not say why')
  })
})

describe('a module row', () => {
  test('maps checkouts and what was just done onto the same vocabulary', () => {
    expect(moduleRow(checkout('a', 0), null, false).state).toBe('uptodate')
    expect(moduleRow(checkout('a', 2), null, false)).toMatchObject({ state: 'available', behind: 2 })
    expect(moduleRow(checkout('a', 2, { blocked: 'there are uncommitted changes' }), null, false)).toMatchObject({
      state: 'blocked',
      reason: 'there are uncommitted changes',
    })
    expect(moduleRow(checkout('a', 0, { fetchFailed: 'offline' }), null, false).state).toBe('failed')
    expect(moduleRow({ id: 'u', name: 'u', dir: '/u', error: 'not a git checkout' }, null, false)).toMatchObject({
      state: 'failed',
      reason: 'not a git checkout',
    })
    expect(moduleRow(checkout('a', 2), null, true)).toMatchObject({ state: 'updating', activity: 'updating' })
    expect(moduleRow(checkout('a', 2), { kind: 'failed', why: 'no' }, false)).toMatchObject({ state: 'failed', reason: 'no' })
    const updated = { kind: 'updated', note: 'Updated', installFailed: null } as const
    expect(moduleRow(checkout('a', 0), { ...updated, restart: 'module' }, false).state).toBe('ready')
    expect(moduleRow(checkout('a', 0), { ...updated, restart: null }, false).state).toBe('uptodate')
    expect(moduleRow(checkout('a', 0), { kind: 'restarted' }, false).state).toBe('uptodate')
  })
})

describe('the rows together', () => {
  test('put the app first, then the modules in order; no app row without an engine', () => {
    const modules = [checkout('notes', 1), checkout('paper', 0)]
    expect(updateRows(status(), modules, {}, null).map((r) => r.id)).toEqual(['app', 'notes', 'paper'])
    expect(updateRows(null, modules, {}, null).map((r) => r.id)).toEqual(['notes', 'paper'])
    expect(updateRows(status({ enabled: false }), modules, {}, null).map((r) => r.id)).toEqual(['notes', 'paper'])
    expect(updateRows(null, modules, {}, 'notes')[0]?.state).toBe('updating')
  })
})

describe('the header indicator', () => {
  const rows = (app: Partial<AppUpdateStatus> | null, modules: Reading[] = []) =>
    updateRows(app ? status(app) : null, modules, {}, null)

  test('says nothing when everything is up to date, checking, or not checked', () => {
    expect(indicator(rows({ state: 'uptodate' }, [checkout('a', 0)]))).toBeNull()
    expect(indicator(rows({ state: 'checking' }))).toBeNull()
    expect(indicator(rows({ state: 'idle' }))).toBeNull()
    expect(indicator(rows(null, [checkout('a', 0)]))).toBeNull()
    expect(indicator([])).toBeNull()
  })

  test('a download shows its version and percent, and wins over everything else', () => {
    const shown = indicator(rows({ state: 'downloading', version: '0.1.2', progress: 0.45 }, [checkout('a', 3)]))
    expect(shown).toEqual({ label: 'Downloading Kehikot 0.1.2 · 45%', tone: 'busy' })
    expect(indicator(rows({ state: 'downloading', version: '0.1.2' }))?.label).toBe('Downloading Kehikot 0.1.2')
    expect(indicator(rows({ state: 'installing', version: '0.1.2' }))?.label).toBe('Installing Kehikot 0.1.2')
  })

  test('a ready update asks for a restart, before counting updates', () => {
    expect(indicator(rows({ state: 'ready', version: '0.1.2' }, [checkout('a', 1)]))).toEqual({
      label: 'Restart to update',
      tone: 'action',
    })
    const module = updateRows(null, [checkout('a', 0)], { a: { kind: 'updated', note: '', restart: 'module', installFailed: null } }, null)
    expect(indicator(module)?.label).toBe('Restart to update')
  })

  test('counts the updates that can be taken, not the blocked or unreachable ones', () => {
    const modules = [
      checkout('a', 1),
      checkout('b', 4),
      checkout('c', 2),
      checkout('d', 1, { blocked: 'there are uncommitted changes' }),
      checkout('e', 0, { fetchFailed: 'offline' }),
    ]
    expect(indicator(rows(null, modules))).toEqual({ label: '3 updates', tone: 'info' })
    expect(indicator(rows(null, [checkout('a', 1)]))?.label).toBe('1 update')
    expect(indicator(rows(null, [modules[3]!, modules[4]!]))).toBeNull()
  })

  test('a module being updated, and an app update that failed', () => {
    expect(indicator(updateRows(null, [checkout('notes', 1)], {}, 'notes'))?.label).toBe('Updating notes')
    expect(indicator(rows({ state: 'failed', error: 'x' }))).toEqual({ label: 'Update failed', tone: 'error' })
  })
})

describe('the words for a row', () => {
  const app = (more: Partial<AppUpdateStatus>) => appRow(status(more)) as UpdateRow
  test('read the same for the app and a module', () => {
    expect(stateText(app({ state: 'uptodate' }))).toBe('Up to date')
    expect(stateText(moduleRow(checkout('a', 0), null, false))).toBe('Up to date')
    expect(stateText(app({ state: 'downloading', version: '0.1.2', progress: 0.3 }))).toBe('Downloading 0.1.2 · 30%')
    expect(stateText(app({ state: 'ready', version: '0.1.2' }))).toBe('Kehikot 0.1.2 is ready — restart to update')
    expect(stateText(app({ state: 'failed', error: 'offline' }))).toBe('Failed: offline')
    expect(stateText(moduleRow(checkout('a', 2), null, false))).toBe('2 new commits')
    expect(stateText(moduleRow(checkout('a', 2, { blocked: 'uncommitted changes' }), null, false))).toBe(
      'Not updated automatically: uncommitted changes',
    )
    expect(stateText({ ...moduleRow(checkout('a', 0), null, false), state: 'pinned', version: 'v1.2' })).toBe('Pinned to v1.2')
  })
})

describe('the engine', () => {
  const g = globalThis as { __TAURI_INTERNALS__?: unknown; kehikotAppUpdate?: (s: unknown) => void }
  afterEach(() => {
    delete g.__TAURI_INTERNALS__
    delete g.kehikotAppUpdate
  })

  test('is absent outside the desktop app, and a refused command reads as no status', async () => {
    expect(appEngine()).toBeNull()
    expect(connect(() => {}).engine).toBeNull()
    expect(g.kehikotAppUpdate).toBeUndefined()
    g.__TAURI_INTERNALS__ = { invoke: async () => Promise.reject(new Error('not allowed')) }
    expect(await appEngine()!.status()).toBeNull()
    expect(readStatus({ nonsense: true })).toBeNull()
  })

  test('connect asks for the status once, then follows the push, and stops cleanly', async () => {
    const calls: string[] = []
    g.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd)
        return status({ state: 'checking' })
      },
    }
    const seen: string[] = []
    const link = connect((s) => seen.push(s.state))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toEqual(['update_status'])
    g.kehikotAppUpdate?.(status({ state: 'downloading', progress: 0.1 }))
    g.kehikotAppUpdate?.('garbage')
    expect(seen).toEqual(['checking', 'downloading'])
    link.stop()
    expect(g.kehikotAppUpdate).toBeUndefined()
  })
})
