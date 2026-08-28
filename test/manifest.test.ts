import { describe, expect, test } from 'bun:test'
import { PROTOCOL, WELL_KNOWN } from 'roadmap-module-protocol'

import { look, resolveOnOrigin } from '../server/discover.ts'
import type { Registration } from '../server/registrations.ts'

/**
 * Reading a manifest, and deciding whether it can be honoured.
 *
 * Every test here goes through `look`, which is the whole decision as one
 * function over one fetch. Testing the pieces separately would let the pieces
 * all pass while the decision came out wrong, and the decision is the thing.
 */

const AT = 'http://127.0.0.1:7811'
const registration: Registration = {
  id: 'example.journey-notes',
  url: AT,
  file: '/tmp/example.journey-notes.json',
}

/** A fetch that serves one document at the well-known path and nothing else. */
function serving(document: unknown, options: { status?: number; raw?: string } = {}) {
  return (async (input: string | URL) => {
    const url = String(input)
    if (!url.endsWith(WELL_KNOWN)) return new Response('not here', { status: 404 })
    const body = options.raw ?? JSON.stringify(document)
    return new Response(body, { status: options.status ?? 200 })
  }) as unknown as typeof fetch
}

const good = {
  kind: 'roadmap.module',
  protocol: PROTOCOL,
  id: 'example.journey-notes',
  name: 'Journey notes',
  version: '1.0.0',
  summary: 'A note per epic, kept here rather than in the host.',
  entry: '/app',
  modes: [{ id: 'notes', label: 'Notes' }],
  declares: { protocol: `>=${PROTOCOL}`, uses: ['epics:read'], storage: false },
}

describe('a manifest the host can honour', () => {
  test('is ready, and its entry comes back absolute on the module\'s own origin', async () => {
    const presence = await look(registration, serving(good))
    expect(presence.condition).toBe('ready')
    expect(presence.module?.entry).toBe(`${AT}/app`)
    expect(presence.protocols).toEqual({ host: PROTOCOL, module: PROTOCOL, range: `>=${PROTOCOL}` })
  })

  test('carries health rather than validating it and dropping it', async () => {
    const presence = await look(registration, serving({ ...good, health: '/healthz' }))
    expect(presence.module?.health).toBe(`${AT}/healthz`)
  })

  test('carries the mcp address, which the host prints and never speaks to', async () => {
    const presence = await look(
      registration,
      serving({ ...good, mcp: { url: '/mcp', transport: 'http', about: 'The notes.' } }),
    )
    expect(presence.module?.mcp?.url).toBe(`${AT}/mcp`)
  })
})

describe('a protocol version the host cannot honour', () => {
  test('a module built against a later protocol is incompatible, with both numbers', async () => {
    const presence = await look(registration, serving({ ...good, protocol: PROTOCOL + 1 }))

    expect(presence.condition).toBe('incompatible')
    expect(presence.protocols).toEqual({
      host: PROTOCOL,
      module: PROTOCOL + 1,
      range: `>=${PROTOCOL}`,
    })
    /* Both numbers in the sentence, not only in the data beside it. A person
       reading the pane has to be able to tell which of the two programs to
       update, and that decision is entirely in the two numbers. */
    expect(presence.line).toContain(String(PROTOCOL + 1))
    expect(presence.line).toContain(String(PROTOCOL))
  })

  test('a range that excludes this host is incompatible, and the range is quoted', async () => {
    const presence = await look(
      registration,
      serving({ ...good, declares: { ...good.declares, protocol: `>=${PROTOCOL + 1}` } }),
    )
    expect(presence.condition).toBe('incompatible')
    expect(presence.line).toContain(`>=${PROTOCOL + 1}`)
    expect(presence.line).toContain(String(PROTOCOL))
  })

  test('a range this host cannot read names nothing, rather than everything', async () => {
    const presence = await look(
      registration,
      serving({ ...good, declares: { ...good.declares, protocol: 'whatever you like' } }),
    )
    expect(presence.condition).toBe('incompatible')
  })

  test('a permissive range does not rescue a module claiming a protocol from the future', async () => {
    const presence = await look(
      registration,
      serving({ ...good, protocol: 99, declares: { ...good.declares, protocol: '>=1' } }),
    )
    expect(presence.condition).toBe('incompatible')
    expect(presence.protocols?.module).toBe(99)
  })
})

describe('a document that is not a manifest', () => {
  test('something answering with JSON that is not a manifest is not a module', async () => {
    const presence = await look(registration, serving({ hello: 'I am a different program' }))
    expect(presence.condition).toBe('silent')
    expect(presence.line).toContain('answering')
  })

  test('a manifest without the kind word cannot become a pane by accident', async () => {
    const { kind, ...withoutKind } = good
    expect(kind).toBe('roadmap.module')
    const presence = await look(registration, serving(withoutKind))
    expect(presence.condition).toBe('silent')
  })

  test('a program answering under a different name is not the module registered here', async () => {
    const presence = await look(registration, serving({ ...good, id: 'somebody.else' }))
    expect(presence.condition).toBe('silent')
    expect(presence.line).toContain('somebody.else')
    expect(presence.line).toContain('example.journey-notes')
  })

  test('nothing this host shows is unbounded, because the schema refuses before it is shown', async () => {
    const presence = await look(registration, serving({ ...good, name: 'x'.repeat(5000) }))
    expect(presence.condition).toBe('silent')
    expect(presence.line.length).toBeLessThan(500)
  })
})

describe('a module may describe itself and not somebody else', () => {
  test('an entry pointing off the module\'s own origin leaves nothing here to frame', async () => {
    const presence = await look(registration, serving({ ...good, entry: 'https://example.com/app' }))
    expect(presence.condition).toBe('silent')
    expect(presence.line).toContain('example.com')
  })

  test('an icon pointing elsewhere is a module with no icon, not a refused module', async () => {
    const presence = await look(registration, serving({ ...good, icon: 'https://example.com/i.png' }))
    expect(presence.condition).toBe('ready')
    expect(presence.module?.icon).toBeNull()
  })

  test('resolveOnOrigin is the check, and it is the host\'s because only the host knows the origin', () => {
    expect(resolveOnOrigin('/app', AT)).toBe(`${AT}/app`)
    expect(resolveOnOrigin('http://127.0.0.1:9999/app', AT)).toBeNull()
    expect(resolveOnOrigin('//example.com/app', AT)).toBeNull()
    expect(resolveOnOrigin('javascript:alert(1)', AT)).toBeNull()
  })
})
