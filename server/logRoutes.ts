import { mkdirSync } from 'node:fs'

import { logsDir } from './machineDirs.ts'
import { moduleAddresses } from './moduleAddresses.ts'
import { BODY_MAX as PAGE_LOG_BODY_MAX, type PageLog } from './pageLog.ts'
import { diagnostics, readLogs } from './readLogs.ts'
import { json, routes, type Desk, type RouteTable } from './routes.ts'
import { fromThePage } from './traffic.ts'

/**
 * The host's own logs and self-checks, for the page:
 *
 *  - `GET  /host/module-addresses` — whether modules are at stable addresses here (`moduleAddresses.ts`).
 *  - `POST /host/module-addresses/check` — what the page's self-check found. The page's alone.
 *  - `POST /host/log` — the page's log (`pageLog.ts`). The page's alone.
 *  - `GET  /host/diagnostics` — "Copy recent diagnostics" (`readLogs.ts`).
 *  - `GET  /host/logs` — the last lines of one log.
 *  - `POST /host/logs/open` — "Open logs folder". The page's alone.
 */
export const LOG_ROUTES = {
  addresses: { method: 'GET', path: '/host/module-addresses' },
  addressCheck: { method: 'POST', path: '/host/module-addresses/check', pageOnly: true },
  pageLog: { method: 'POST', path: '/host/log', pageOnly: true },
  diagnostics: { method: 'GET', path: '/host/diagnostics' },
  logs: { method: 'GET', path: '/host/logs' },
  openLogs: { method: 'POST', path: '/host/logs/open', pageOnly: true },
} as const satisfies RouteTable

export interface LogDeps {
  /** Whether module addresses are on (`addressesOn`), and this start's self-check answer. */
  addresses: boolean
  addressCheck: string
  pageLog: Pick<PageLog, 'take'>
  /** Every origin this host's page is served from. */
  origins: readonly string[]
  /** What "Copy recent diagnostics" says first. */
  diagnosticFacts(): Record<string, string | number | boolean | null>
}

export function logDesk(deps: LogDeps): Desk {
  const { pageLog } = deps
  return routes(LOG_ROUTES, {
    /* Whether modules are at stable addresses here, and whether a frame may be given one (`moduleAddresses.ts`). */
    addresses: () => json(moduleAddresses.said(deps.addresses, deps.addressCheck)),
    /* The page's self-check did not reach this host at a frame's address: why, for the log. Its frames keep their ports. */
    addressCheck: async (request) => {
      const body = (await request.json().catch(() => null)) as { ok?: unknown; why?: unknown } | null
      moduleAddresses.checked(body?.ok === true, typeof body?.why === 'string' ? body.why : null)
      return json({ ok: true })
    },

    /* The page's log (`pageLog.ts`): its console warnings and errors and its decisions, batched. The page's alone. */
    pageLog: async (request) => {
      if (!fromThePage(request, deps.origins)) return json({ ok: false, error: 'Only this host’s own page writes its log. Nothing was written.' }, 403)
      if (Number(request.headers.get('content-length') ?? '0') > PAGE_LOG_BODY_MAX) return json({ ok: false, error: `At most ${PAGE_LOG_BODY_MAX} bytes a request.` }, 413)
      const taken = pageLog.take(await request.text())
      return taken.ok ? json(taken) : json({ ok: false, error: taken.why }, taken.status)
    },
    /* "Copy recent diagnostics" (Settings › About): versions and the last lines of the host's and the page's logs, scrubbed (`readLogs.ts`). */
    diagnostics: () => {
      const text = diagnostics(deps.diagnosticFacts())
      return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
    },
    /* The last lines of one log, for the page (the same reading as `read_logs`). */
    logs: (_request, url) => {
      const read = readLogs({
        which: url.searchParams.get('which') ?? 'host',
        module: url.searchParams.get('module') ?? undefined,
        since: url.searchParams.get('since') ?? undefined,
        grep: url.searchParams.get('grep') ?? undefined,
        lines: url.searchParams.has('lines') ? Number(url.searchParams.get('lines')) : undefined,
      })
      return read.ok ? json({ ok: true, file: read.file, lines: read.lines }) : json({ ok: false, error: read.why }, 400)
    },
    /* "Open logs folder" (Settings › About): the folder, in the system's file browser. The page's alone. */
    openLogs: () => {
      const dir = logsDir()
      try {
        mkdirSync(dir, { recursive: true })
        Bun.spawn(process.platform === 'darwin' ? ['open', dir] : ['xdg-open', dir], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
        return json({ ok: true, dir })
      } catch (error) {
        return json({ ok: false, error: `The logs folder could not be opened (${(error as Error).message}). It is ${dir}.`, dir }, 500)
      }
    },
  })
}
