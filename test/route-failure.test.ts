import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { answerLogged, REASON_MOST } from '../server/routeFailure.ts'

/** A host route that answers 5xx is logged once, with its stack, and its body says why in words. */

function aLog() {
  const lines: { level: string; area: string; message: string }[] = []
  return { lines, write: (level: string, area: string, message: string) => void lines.push({ level, area, message }) }
}

describe('answerLogged', () => {
  test('a route that throws: one ERROR line with the route, the message and the stack, and a reasoned JSON body', async () => {
    const log = aLog()
    const answer = await answerLogged('post', '/host/inbox/task', async () => {
      throw new TypeError('Body already used')
    }, log)
    expect(answer.status).toBe(500)
    expect(answer.headers.get('content-type')).toContain('application/json')
    const body = (await answer.json()) as { ok: boolean; error: string; why: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('Kehikot failed while answering POST /host/inbox/task: Body already used')
    expect(body.why).toBe(body.error)
    expect(log.lines).toHaveLength(1)
    expect(log.lines[0]!.level).toBe('error')
    expect(log.lines[0]!.area).toBe('route')
    expect(log.lines[0]!.message).toContain('POST /host/inbox/task failed: TypeError: Body already used')
    expect(log.lines[0]!.message).toContain('route-failure.test.ts')
  })

  test('a route that answers 5xx on its own is logged with the reason its body gave, and passed on untouched', async () => {
    const log = aLog()
    const answer = await answerLogged('GET', '/host/x', async () => Response.json({ ok: false, error: 'The logs folder could not be opened.' }, { status: 503 }), log)
    expect(answer.status).toBe(503)
    expect(((await answer.json()) as { error: string }).error).toBe('The logs folder could not be opened.')
    expect(log.lines.map((one) => one.message)).toEqual(['GET /host/x answered 503: The logs folder could not be opened.'])
  })

  test('a route that answers below 500 is not logged', async () => {
    const log = aLog()
    await answerLogged('GET', '/host/y', async () => Response.json({ ok: false }, { status: 400 }), log)
    expect(log.lines).toEqual([])
  })

  test('the reason is a sentence, not a stack', async () => {
    const answer = await answerLogged('GET', '/host/z', async () => {
      throw new Error('x'.repeat(5000))
    }, aLog())
    expect(((await answer.json()) as { error: string }).error.length).toBeLessThanOrEqual(REASON_MOST)
  })
})

describe('the one place', () => {
  test('every route in server.ts is answered through answerLogged', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'server', 'server.ts'), 'utf8')
    expect(source).toMatch(/answerLogged\(request\.method, path, \(\) => because\(/)
    /* Nothing hands Bun a bare 500 any more. */
    expect(source).not.toContain('new Response(null, { status: 500 })')
  })
})
