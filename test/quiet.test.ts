import { describe, expect, test } from 'bun:test'

import { importsIn, scriptsIn, whyQuiet } from '../server/quiet.ts'

/**
 * Four different faults used to share one sentence, and the sentence named none
 * of them. See the essay in `server/quiet.ts` — the one that actually happened
 * was a dependency rebuild leaving open pages holding stale script addresses,
 * against which the only offered remedy, Start, is powerless.
 */

const ENTRY = 'http://127.0.0.1:7920/app'

/**
 * A fetch that answers from a table, so every branch is reachable on demand.
 *
 * `type` matters and defaults to something that is not JavaScript on purpose:
 * the walk reads a body for its imports only when the server called it
 * JavaScript, so a table entry that does not say so is a leaf, and a test about
 * one thing does not have to describe a graph.
 */
function answering(table: Record<string, { status: number; body?: string; type?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const found = table[url]
    if (!found) throw new Error(`nothing at ${url}`)
    return new Response(found.body ?? '', {
      status: found.status,
      headers: { 'content-type': found.type ?? 'text/plain' },
    })
  }) as unknown as typeof fetch
}

/** Shorthand for a table entry the walk will read for its imports. */
const js = (body: string) => ({ status: 200, body, type: 'text/javascript' })

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

describe('finding the modules a script asks for', () => {
  test('a bare side-effect import is a path to fetch', () => {
    expect(importsIn("import '/src/index.css'")).toEqual(['/src/index.css'])
  })

  test('named, default and star imports are all the same fetch', () => {
    expect(importsIn("import { App } from '/src/app.tsx'\nimport React from './react.js'\nexport * from '../x.js'"))
      .toEqual(['/src/app.tsx', './react.js', '../x.js'])
  })

  test('a braced list broken over lines is still one import', () => {
    expect(importsIn('import {\n  a,\n  b,\n} from "/src/lib.ts"')).toEqual(['/src/lib.ts'])
  })

  /*
   * The false positive that the first live run of this walk produced, kept as a
   * test because it is the whole argument for leaving dynamic imports alone.
   * React's pre-bundled chunk carries this sentence as an error STRING; a regex
   * cannot see the quotes around it, and the probe reported a healthy module as
   * 404ing on a file nobody has ever had.
   */
  test('a dynamic import quoted inside a string is not chased', () => {
    const react = '"lazy: Expected the result of a dynamic import() call. Your code should look like: \\n'
      + '  const MyComponent = lazy(() => import(\'./MyComponent\'))"'
    expect(importsIn(react)).toEqual([])
  })

  /* And a real one is left alone too, on purpose: the browser does not fetch it
     until it is called, so it cannot be why a page ran nothing. */
  test('a real dynamic import is not in the graph the entry needs, so it is not followed', () => {
    expect(importsIn("const late = () => import('/src/late.tsx')")).toEqual([])
  })

  /* This codebase argues in long comments, and several of them quote imports. */
  test('an import quoted in a doc comment is not a fetch', () => {
    expect(importsIn(" * Imported for its side effect:\n * import '/src/client.ts'\n */")).toEqual([])
  })

  /* A bare specifier is a name a bundler resolves. Resolving it here would mean
     inventing a URL and then reporting somebody for the 404 the invention got. */
  test('a bare specifier is not guessed at', () => {
    expect(importsIn("import React from 'react'")).toEqual([])
  })

  test('import.meta is not an import', () => {
    expect(importsIn('const here = import.meta.url')).toEqual([])
  })

  test('the same path twice is one fetch', () => {
    expect(importsIn("import '/a.js'\nimport '/a.js'")).toEqual(['/a.js'])
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

  /*
   * The one that happened second, and the reason the walk follows imports.
   *
   * References was left with the same `export const` twice in `manifest.ts`.
   * esbuild refused it, Vite answered that one path with 500, and because
   * `app.tsx` imports it the browser's module graph never instantiated — so
   * `main.tsx` never ran a line and nothing ever called `connect`. The page and
   * both of its scripts were served perfectly. The old walk stopped there and
   * called it a fault inside the module, which sent a person looking for a bug
   * in a page that had never executed.
   */
  test('a transitive import that does not load is found and named', async () => {
    const said = await whyQuiet(
      'References',
      ENTRY,
      answering({
        [ENTRY]: { status: 200, body: '<script type="module" src="/src/main.tsx"></script>' },
        'http://127.0.0.1:7920/src/main.tsx': js("import { App } from '/src/app.tsx'"),
        'http://127.0.0.1:7920/src/app.tsx': js("import { ID } from '/manifest.ts'"),
        'http://127.0.0.1:7920/manifest.ts': { status: 500 },
      }),
    )
    /* Not `module`. That was the whole of the wrong answer. */
    expect(said.kind).toBe('script')
    expect(said.line).toContain('/manifest.ts')
    expect(said.line).toContain('500')
    /* And the importer, because a file named without its asker is one more thing
       to go and find. */
    expect(said.line).toContain('/src/app.tsx')
    expect(said.line).not.toContain('fault inside the module')
  })

  test('a deep graph that loads all the way down is still the module’s own silence', async () => {
    const said = await whyQuiet(
      'References',
      ENTRY,
      answering({
        [ENTRY]: { status: 200, body: '<script type="module" src="/src/main.tsx"></script>' },
        'http://127.0.0.1:7920/src/main.tsx': js("import '/src/app.tsx'\nimport '/src/index.css'"),
        'http://127.0.0.1:7920/src/app.tsx': js("import '/manifest.ts'"),
        'http://127.0.0.1:7920/src/index.css': { status: 200 },
        'http://127.0.0.1:7920/manifest.ts': js('export const ID = "x"'),
      }),
    )
    expect(said.kind).toBe('module')
    expect(said.line).toContain('choosing not to answer')
    /* It says how far it looked, so the shrug is a report rather than a guess. */
    expect(said.line).toContain('following every import')
  })

  /* A graph somebody else writes may have a cycle in it, and this probe runs on
     a deadline that has already been missed. It must terminate. */
  test('a cycle between two modules does not hang the probe', async () => {
    const said = await whyQuiet(
      'References',
      ENTRY,
      answering({
        [ENTRY]: { status: 200, body: '<script type="module" src="/a.js"></script>' },
        'http://127.0.0.1:7920/a.js': js("import '/b.js'"),
        'http://127.0.0.1:7920/b.js': js("import '/a.js'"),
      }),
    )
    expect(said.kind).toBe('module')
  })

  /*
   * A stale dependency is still the reading that wins, even reached through an
   * import, because reload is the remedy a person can actually carry out.
   *
   * The `https://` import beside it is load-bearing: it is not in the table, so
   * fetching it would answer nothing and this would come back `script`. A module
   * naming another origin is that origin's business, and the walk leaves it.
   */
  test('a rebuilt dependency reached through an import still reads as stale', async () => {
    const said = await whyQuiet(
      'References',
      ENTRY,
      answering({
        [ENTRY]: { status: 200, body: '<script type="module" src="/src/main.tsx"></script>' },
        'http://127.0.0.1:7920/src/main.tsx': js("import 'https://elsewhere.example/x.js'\nimport '/deps/react.js?v=old'"),
        'http://127.0.0.1:7920/deps/react.js?v=old': { status: 504 },
      }),
    )
    expect(said.kind).toBe('stale')
    expect(said.line).toContain('reload')
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
