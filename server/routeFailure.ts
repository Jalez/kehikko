import { errorText, type LogLevel } from '../src/host/logLine.ts'

/**
 * A host route that answers 5xx is never silent, and never only a number.
 *
 * A route that threw used to reach Bun's own error handler: the page got an HTML error page it could
 * not read ("HTTP 500") and `host.log` got nothing, because Bun prints that error itself rather than
 * through the console the log captures. So the one place every request passes (`fetch` in
 * `server.ts`) answers through these two:
 *
 *  - `failedAnswer`: a route threw. One ERROR line (`[route]`: method, path, the error and its
 *    stack), and a 500 whose JSON body says why in a short sentence the page shows as it is
 *    (`error` and `why`, the two fields the page's readers look for).
 *  - `noted5xx`: a route answered 5xx on its own. One ERROR line with the method, path, status and
 *    the reason its body gave.
 *
 * Every current and future route gets both without doing anything.
 */

export interface RouteLog {
  write(level: LogLevel, area: string, message: string): void
}

/** The longest reason a body carries: a sentence, not a stack. */
export const REASON_MOST = 300

const AREA = 'route'

/** The short sentence a page shows for a route that threw. */
export function failedReason(error: unknown, method: string, path: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'an unknown error'
  const said = message.trim().replace(/\s+/g, ' ') || (error instanceof Error ? error.name : 'an unknown error')
  return `Kehikot failed while answering ${method.toUpperCase()} ${path}: ${said}`.slice(0, REASON_MOST)
}

/** A route threw: logged once, with its stack, and answered with a reason in words. */
export function failedAnswer(error: unknown, method: string, path: string, log: RouteLog): Response {
  log.write('error', AREA, `${method.toUpperCase()} ${path} failed: ${errorText(error, 16)}`)
  const why = failedReason(error, method, path)
  return new Response(JSON.stringify({ ok: false, error: why, why }), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** A route answered 5xx without throwing: one line with the reason its body gave. The response is not consumed. */
export async function noted5xx(response: Response, method: string, path: string, log: RouteLog): Promise<void> {
  if (response.status < 500) return
  let reason = ''
  try {
    const text = await response.clone().text()
    try {
      const body = JSON.parse(text) as { error?: unknown; why?: unknown; message?: unknown }
      const said = [body.error, body.why, body.message].find((one) => typeof one === 'string' && one.length > 0)
      reason = typeof said === 'string' ? said : text
    } catch {
      reason = text
    }
  } catch {
    /* A body that cannot be read (a stream) is not read. */
  }
  reason = reason.trim().replace(/\s+/g, ' ').slice(0, REASON_MOST)
  log.write('error', AREA, `${method.toUpperCase()} ${path} answered ${response.status}${reason ? `: ${reason}` : ' with no reason'}`)
}

/**
 * Answer one request through a route, never silently failing: what it threw is `failedAnswer`, a
 * 5xx it answered is `noted5xx`. The one wrapper `fetch` in `server.ts` puts every route in.
 */
export async function answerLogged(method: string, path: string, route: () => Promise<Response>, log: RouteLog): Promise<Response> {
  let answered: Response
  try {
    answered = await route()
  } catch (error) {
    return failedAnswer(error, method, path, log)
  }
  if (answered.status >= 500) await noted5xx(answered, method, path, log)
  return answered
}
