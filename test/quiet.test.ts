import { describe, expect, test } from 'bun:test'

import { scriptsIn, whyQuiet } from '../server/quiet.ts'

/**
 * Four different faults used to share one sentence, and the sentence named none
 * of them. See the essay in `server/quiet.ts` — the one that actually happened
 * was a dependency rebuild leaving open pages holding stale script addresses,
 * against which the only offered remedy, Start, is powerless.
 */

const ENTRY = 'http://127.0.0.1:7920/app'

/** A fetch that answers from a table, so every branch is reachable on demand. */
function answering(table: Record<string, { status: number; body?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const found = table[url]
    if (!found) throw new Error(`nothing at ${url}`)
    return new Response(found.body ?? '', { status: found.status })
  }) as unknown as typeof fetch
}

describe('finding the scripts a page asks for', () => {
  test('a module script is found', () => {
    expect(scriptsIn('<script type="module" src="/src/main.tsx"></script>')).toEqual(['/src/main.tsx'])
  })

  test('single quotes and extra attributes do not hide one', () => {
    expect(scriptsIn("<script defer crossorigin src='/a.js' data-x='1'></script>")).toEqual(['/a.js'])
  })

  /* An inline script cannot 504, so it is not something to go looking for. */
  test('an inline script is not a fetch', () => {
    expect(scriptsIn('<script>console.log(1)</script>')).toEqual([])
  })

  test('the same source twice is one script', () => {
    expect(scriptsIn('<script src="/a.js"></script><script src="/a.js"></script>')).toEqual(['/a.js'])
  })
})

describe('why a module is quiet', () => {
  /*
   * The one that happened. Vite fingerprints its optimised dependency bundles
   * from what is installed; rewriting node_modules under an open page leaves it
   * asking for the previous fingerprints, which answer 504.
   */
  test('a rebuilt dependency is named, and so is the remedy', async () => {
    const said = await whyQuiet(
      'Terminal',
      ENTRY,
      answering({
        [ENTRY]: { status: 200, body: '<script type="module" src="/node_modules/.vite/deps/react.js?v=old"></script>' },
        'http://127.0.0.1:7920/node_modules/.vite/deps/react.js?v=old': { status: 504 },
      }),
    )
    expect(said.kind).toBe('stale')
    expect(said.line).toContain('reload')
    /* And it must say Start is useless, because Start is what a person reaches
       for and it cannot touch a stale page. */
    expect(said.line).toContain('Starting it again cannot help')
  })

  test('a script that is simply missing is a different sentence', async () => {
    const said = await whyQuiet(
      'Terminal',
      ENTRY,
      answering({
        [ENTRY]: { status: 200, body: '<script type="module" src="/src/main.tsx"></script>' },
        'http://127.0.0.1:7920/src/main.tsx': { status: 404 },
      }),
    )
    expect(said.kind).toBe('script')
    expect(said.line).toContain('404')
    expect(said.line).not.toContain('reload')
  })

  test('a page that does not answer is not blamed on its scripts', async () => {
    const said = await whyQuiet('Terminal', ENTRY, answering({ [ENTRY]: { status: 500 } }))
    expect(said.kind).toBe('page')
    expect(said.line).toContain('500')
  })

  /* Everything loads. The silence really is the module's, and saying so is the
     honest end of the ladder rather than a guess at a cause. */
  test('when everything loads, the fault is named as the module’s own', async () => {
    const said = await whyQuiet(
      'Terminal',
      ENTRY,
      answering({
        [ENTRY]: { status: 200, body: '<script type="module" src="/src/main.tsx"></script>' },
        'http://127.0.0.1:7920/src/main.tsx': { status: 200 },
      }),
    )
    expect(said.kind).toBe('module')
    expect(said.line).toContain('choosing not to answer')
  })

  /* A page with no scripts explains itself, and the sentence should say so
     rather than reporting a mystery. */
  test('a page that asks for no scripts says that', async () => {
    const said = await whyQuiet('Terminal', ENTRY, answering({ [ENTRY]: { status: 200, body: '<p>hello</p>' } }))
    expect(said.kind).toBe('module')
    expect(said.line).toContain('no scripts at all')
  })

  /* The probe must never throw: it runs on a deadline that has already been
     missed, and a host that crashed diagnosing a quiet module would take the
     whole canvas with it. */
  test('a module that has gone away mid-probe still produces a sentence', async () => {
    const said = await whyQuiet('Terminal', ENTRY, answering({}))
    expect(said.kind).toBe('page')
    expect(said.line).toContain('did not come back')
  })
})
