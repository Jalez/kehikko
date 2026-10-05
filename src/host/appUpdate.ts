import { z } from 'zod'

/**
 * The desktop app's own updater, as this page sees it.
 *
 * The shell (kehikko-desktop `src-tauri/src/update.rs`) checks, downloads and
 * verifies new versions of the app by itself, and draws no UI of its own: this
 * page is its only UI. The contract, from kehikko-desktop#8:
 *
 * - Three commands, no arguments, through `window.__TAURI_INTERNALS__.invoke`
 *   (the same door `remember_theme` uses in `theme.ts`): `update_status`,
 *   `check_for_update` (starts a check, answers the status) and `apply_update`
 *   (installs the ready update and relaunches).
 * - A push: the shell evaluates `window.kehikotAppUpdate?.(status)` on every
 *   change and after every page load.
 * - Calling any command tells the shell this page renders updates, so it does
 *   not raise its own native alert. `connect` calls `update_status` once for
 *   exactly that reason, and because the page may define the push function
 *   after the shell's last push.
 *
 * No engine at all — a browser tab, a dev host outside the app, a refused
 * command, or `enabled: false` — means no app row anywhere. Nothing is logged:
 * a missing app updater in a browser tab is not a fault.
 */

export const appStatusSchema = z.object({
  enabled: z.boolean(),
  current: z.string(),
  state: z.enum(['idle', 'checking', 'downloading', 'ready', 'installing', 'failed', 'uptodate']),
  version: z.string().nullable().default(null),
  progress: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
  checkedAt: z.number().nullable().default(null),
})

export type AppUpdateStatus = z.infer<typeof appStatusSchema>

/** The three commands, or nothing. Tests pass a stand-in through `__TAURI_INTERNALS__`. */
export interface AppEngine {
  status(): Promise<AppUpdateStatus | null>
  check(): Promise<AppUpdateStatus | null>
  apply(): Promise<void>
}

type Internals = { invoke?: (cmd: string, payload?: unknown) => Promise<unknown> }

/** A status the shell sent, or null for anything that is not one. */
export function readStatus(value: unknown): AppUpdateStatus | null {
  const parsed = appStatusSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The engine, when this page runs inside the desktop app; null otherwise. */
export function appEngine(): AppEngine | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: Internals }).__TAURI_INTERNALS__
  if (!internals || typeof internals.invoke !== 'function') return null
  const call = async (cmd: string): Promise<unknown> => {
    try {
      return await internals.invoke!(cmd)
    } catch {
      /* Refused (an origin without the grant) or the bridge failed. */
      return null
    }
  }
  return {
    status: async () => readStatus(await call('update_status')),
    check: async () => readStatus(await call('check_for_update')),
    apply: async () => {
      await call('apply_update')
    },
  }
}

type Push = (status: unknown) => void

/**
 * Listen to the shell's push and ask once for the status now. Returns the
 * engine (null when there is none) and a function that stops listening.
 */
export function connect(onStatus: (status: AppUpdateStatus) => void): { engine: AppEngine | null; stop(): void } {
  const engine = appEngine()
  if (!engine) return { engine: null, stop() {} }
  const target = globalThis as { kehikotAppUpdate?: Push }
  let live = true
  /* A push that lands before the first answer is newer than it. */
  let pushed = false
  const push: Push = (value) => {
    const status = readStatus(value)
    if (!live || !status) return
    pushed = true
    onStatus(status)
  }
  target.kehikotAppUpdate = push
  void engine.status().then((status) => {
    if (live && status && !pushed) onStatus(status)
  })
  return {
    engine,
    stop() {
      live = false
      if (target.kehikotAppUpdate === push) delete target.kehikotAppUpdate
    },
  }
}
