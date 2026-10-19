import { describe, expect, test } from 'bun:test'

import { changes, hasBody, own, ownHosts, PAGE_ONLY, pageOriginsOf, refusal, saysJson, type Own } from '../server/guard.ts'

/**
 * The rule every request passes before a route is chosen (`server/guard.ts`),
 * branch by branch. Headers in, a refusal or null out; nothing is served here.
 */

const PORT = 4180
const PAGE = 'http://127.0.0.1:4181'
const SELF: Own = own({}, PORT, [PAGE, 'http://localhost:4181'])
const JSON_TYPE = { 'content-type': 'application/json' }

function ask(method: string, pathname: string, headers: Record<string, string> = {}) {
  return refusal({ method, pathname, headers: new Headers({ host: `127.0.0.1:${PORT}`, ...headers }) }, SELF)
}

describe('what this host knows about itself', () => {
  test('the page’s origins are its own, what it was started with, and the desktop window’s', () => {
    expect(pageOriginsOf({}, [PAGE])).toEqual([PAGE, 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'])
    expect(pageOriginsOf({ KEHIKOT_ORIGINS: 'http://a:1  http://b:2', KEHIKOT_ORIGIN: 'http://c:3' }, [PAGE])).toEqual([
      PAGE,
      'http://a:1',
      'http://b:2',
      'http://c:3',
      'tauri://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
    ])
    /* The name the desktop shell passes. */
    expect(pageOriginsOf({ KEHIKOT_ORIGIN: 'tauri://localhost http://127.0.0.1:4170' }, [])).toContain('http://127.0.0.1:4170')
  })

  test('another host’s default page is not this host’s page', () => {
    /* A bundled host on 4170 is not told about the development page on 4181, and the other way round. */
    expect(pageOriginsOf({}, ['http://127.0.0.1:4170'])).not.toContain('http://127.0.0.1:4181')
    expect(pageOriginsOf({}, [PAGE])).not.toContain('http://127.0.0.1:4170')
  })

  test('its addresses are loopback names with its own port or its page’s', () => {
    expect([...ownHosts(4180, [PAGE, 'http://localhost:4181'])].sort()).toEqual([
      '127.0.0.1:4180',
      '127.0.0.1:4181',
      'localhost:4180',
      'localhost:4181',
    ])
    /* Bundled: one port. Origins that are not loopback http add nothing. */
    expect([...ownHosts(4170, ['http://127.0.0.1:4170', 'tauri://localhost', 'http://tauri.localhost', 'https://example.org:9', 'not a url'])].sort()).toEqual([
      '127.0.0.1:4170',
      'localhost:4170',
    ])
  })

  test('JSON is said by the content type, with or without a charset', () => {
    expect(saysJson(new Headers(JSON_TYPE))).toBe(true)
    expect(saysJson(new Headers({ 'content-type': 'Application/JSON; charset=utf-8' }))).toBe(true)
    expect(saysJson(new Headers({ 'content-type': 'text/plain' }))).toBe(false)
    expect(saysJson(new Headers({ 'content-type': 'application/jsonx' }))).toBe(false)
    expect(saysJson(new Headers({ 'content-type': 'application/json-seq' }))).toBe(false)
    expect(saysJson(new Headers())).toBe(false)
  })

  test('a body is one the request says it has', () => {
    expect(hasBody(new Headers())).toBe(false)
    expect(hasBody(new Headers({ 'content-length': '0' }))).toBe(false)
    expect(hasBody(new Headers({ 'content-length': '12' }))).toBe(true)
    expect(hasBody(new Headers({ 'content-length': 'many' }))).toBe(true)
    expect(hasBody(new Headers({ 'transfer-encoding': 'chunked' }))).toBe(true)
  })

  test('GET, HEAD and OPTIONS ask; the rest may change something', () => {
    expect(['GET', 'HEAD', 'OPTIONS', 'get'].map(changes)).toEqual([false, false, false, false])
    expect(['POST', 'PATCH', 'DELETE', 'PUT', 'post'].map(changes)).toEqual([true, true, true, true, true])
  })
})

describe('the address a request names', () => {
  test('this host’s own, by either loopback name and either of its ports, is answered', () => {
    for (const host of ['127.0.0.1:4180', 'localhost:4180', '127.0.0.1:4181', 'LOCALHOST:4181']) {
      expect(ask('GET', '/host/modules', { host })).toBeNull()
      expect(ask('GET', '/', { host })).toBeNull()
    }
  })

  test('any other name or port is refused, for the page and the API alike', () => {
    for (const host of ['example.org', 'example.org:4180', 'other.localhost:4180', '127.0.0.1', '127.0.0.1:9999', '[::1]:4180', '127.0.0.1:4180.example.org']) {
      for (const [method, pathname] of [['GET', '/'], ['GET', '/assets/x.js'], ['GET', '/host/modules'], ['POST', '/host/epics'], ['POST', '/mcp']] as const) {
        const refused = ask(method, pathname, { host, ...JSON_TYPE })
        expect(refused?.status, `${method} ${pathname} as ${host}`).toBe(403)
        expect(refused?.why).toContain('named another')
      }
    }
  })

  test('a request with no Host at all is a program’s, and goes on to the rest of the rule', () => {
    const bare = (method: string, pathname: string, headers: Record<string, string> = {}) =>
      refusal({ method, pathname, headers: new Headers(headers) }, SELF)
    expect(bare('GET', '/host/health')).toBeNull()
    expect(bare('POST', '/host/epics', { origin: 'https://example.org', ...JSON_TYPE })?.status).toBe(403)
  })
})

describe('a request that changes something', () => {
  const body = { ...JSON_TYPE, 'content-length': '2' }

  test('from the page: its origin and JSON', () => {
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      expect(ask(method, '/host/epics', { origin: PAGE, 'sec-fetch-site': 'same-origin', ...body })).toBeNull()
      expect(ask(method, '/host/epics', { origin: 'http://localhost:4181', ...body })).toBeNull()
    }
  })

  test('from the page with no body needs no content type', () => {
    expect(ask('DELETE', '/host/canvases/3', { origin: PAGE })).toBeNull()
    expect(ask('POST', '/host/restart', { origin: PAGE, 'content-length': '0' })).toBeNull()
  })

  test('from a program: no Origin, no Sec-Fetch-Site, and JSON', () => {
    expect(ask('POST', '/host/epics', body)).toBeNull()
    expect(ask('DELETE', '/host/canvases/3')).toBeNull()
  })

  test('from any other origin is refused, whatever else it says', () => {
    const others = ['https://example.org', 'http://127.0.0.1:4180', 'http://127.0.0.1:9925', 'http://localhost:3000', 'http://127.0.0.1:4170', 'null', '']
    for (const origin of others) {
      for (const extra of [body, { 'content-type': 'text/plain', 'content-length': '2' }, {}, { ...body, 'sec-fetch-site': 'same-origin' }]) {
        const refused = ask('POST', '/host/epics', { origin, ...extra })
        expect(refused?.status, `Origin ${origin}`).toBe(403)
        expect(refused?.why).toContain('came from neither')
      }
    }
  })

  test('from a browser that states no origin is refused', () => {
    for (const site of ['cross-site', 'same-site', 'same-origin', 'none']) {
      expect(ask('POST', '/host/epics', { 'sec-fetch-site': site, ...body })?.status, site).toBe(403)
    }
  })

  test('with a body that is not said to be JSON is refused, from the page and from a program', () => {
    for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      for (const origin of [{ origin: PAGE }, {}] as Record<string, string>[]) {
        const refused = ask('POST', '/host/epics', { ...origin, 'content-type': type, 'content-length': '2' })
        expect(refused?.status, type).toBe(415)
        expect(refused?.why).toContain('JSON')
      }
    }
    expect(ask('POST', '/host/epics', { origin: PAGE, 'content-length': '2' })?.status).toBe(415)
    expect(ask('POST', '/host/epics', { 'transfer-encoding': 'chunked' })?.status).toBe(415)
  })

  test('is held to the rule wherever it is addressed, not only under /host/', () => {
    expect(ask('POST', '/', { origin: 'https://example.org' })?.status).toBe(403)
    expect(ask('PUT', '/assets/index.js', { origin: 'https://example.org', ...body })?.status).toBe(403)
    expect(ask('POST', '/anything', { 'content-type': 'text/plain', 'content-length': '2' })?.status).toBe(415)
  })
})

describe('a request that asks', () => {
  test('for the page is answered whatever browser sent it', () => {
    expect(ask('GET', '/')).toBeNull()
    expect(ask('GET', '/', { 'sec-fetch-site': 'cross-site' })).toBeNull()
    expect(ask('GET', '/assets/index.js', { origin: 'https://example.org', 'sec-fetch-site': 'cross-site' })).toBeNull()
    expect(ask('HEAD', '/index.html', { 'sec-fetch-site': 'none' })).toBeNull()
  })

  test('under /host/ from the page or a program is answered', () => {
    expect(ask('GET', '/host/modules')).toBeNull()
    expect(ask('GET', '/host/modules', { 'sec-fetch-site': 'same-origin' })).toBeNull()
    expect(ask('GET', '/host/modules', { 'sec-fetch-site': 'none' })).toBeNull()
    expect(ask('GET', '/host/watch', { origin: PAGE, 'sec-fetch-site': 'same-origin' })).toBeNull()
    expect(ask('HEAD', '/host/health')).toBeNull()
  })

  test('under /host/ from anywhere else is refused', () => {
    for (const site of ['cross-site', 'same-site', 'something-new']) {
      expect(ask('GET', '/host/modules', { 'sec-fetch-site': site })?.status, site).toBe(403)
    }
    for (const origin of ['https://example.org', 'http://127.0.0.1:9925', 'null']) {
      expect(ask('GET', '/host/watch', { origin })?.status, origin).toBe(403)
      expect(ask('GET', '/host/canvases', { origin, 'sec-fetch-site': 'same-origin' })?.status, origin).toBe(403)
      expect(ask('OPTIONS', '/host/epics', { origin, 'access-control-request-method': 'POST' })?.status, origin).toBe(403)
    }
  })
})

describe('the door at /mcp', () => {
  const body = { ...JSON_TYPE, 'content-length': '2' }

  test('a program with JSON is answered', () => {
    expect(ask('POST', '/mcp', body)).toBeNull()
    expect(ask('POST', '/mcp', { ...body, 'sec-fetch-site': 'none' })).toBeNull()
    /* Not a POST: let through to the route, which says the door takes POST. */
    expect(ask('GET', '/mcp')).toBeNull()
  })

  test('anything a page sent is refused — this host’s own page included', () => {
    for (const origin of [PAGE, 'https://example.org', 'http://127.0.0.1:9925', 'null']) {
      const refused = ask('POST', '/mcp', { origin, ...body })
      expect(refused?.status, origin).toBe(403)
      expect(refused?.why).toContain('for programs')
    }
    for (const site of ['cross-site', 'same-site', 'same-origin']) {
      expect(ask('POST', '/mcp', { 'sec-fetch-site': site, ...body })?.status, site).toBe(403)
      expect(ask('GET', '/mcp', { 'sec-fetch-site': site })?.status, site).toBe(403)
    }
  })

  test('a POST that is not said to be JSON is refused', () => {
    expect(ask('POST', '/mcp', { 'content-type': 'text/plain', 'content-length': '2' })?.status).toBe(415)
    expect(ask('POST', '/mcp')?.status).toBe(415)
  })
})

describe('the routes that are the page’s alone', () => {
  const body = { ...JSON_TYPE, 'content-length': '2' }

  test('are the restart of a kept module, the two header postings, the four inbox writes, the tracker edit and Locate', () => {
    expect([...PAGE_ONLY].sort()).toEqual([
      '/host/headers',
      '/host/inbox/act',
      '/host/inbox/migrate',
      '/host/inbox/notice',
      '/host/inbox/report',
      '/host/pressed',
      '/host/projects/locate',
      '/host/restart-anyway',
      '/host/trackers',
    ])
  })

  test('answer the page: its Origin and JSON', () => {
    for (const pathname of PAGE_ONLY) {
      expect(ask('POST', pathname, { origin: PAGE, 'sec-fetch-site': 'same-origin', ...body })).toBeNull()
      expect(ask('POST', pathname, { origin: 'http://localhost:4181', 'content-type': 'application/json; charset=utf-8', 'content-length': '2' })).toBeNull()
    }
  })

  test('answer no program, no other origin, and nothing but JSON', () => {
    for (const pathname of PAGE_ONLY) {
      for (const headers of [
        { ...body },
        { origin: 'https://example.org', ...body },
        { origin: 'http://127.0.0.1:7920', ...body },
        { origin: 'null', ...body },
        { origin: PAGE, 'content-type': 'text/plain', 'content-length': '2' },
        { origin: PAGE },
        {},
      ] as Record<string, string>[]) {
        const refused = ask('POST', pathname, headers)
        expect(refused?.status, `${pathname} ${JSON.stringify(headers)}`).toBe(403)
        expect(refused?.why).toContain('Nothing was done.')
      }
    }
  })

  test('are the only ones: a program is answered at every other', () => {
    for (const pathname of ['/host/start', '/host/restart', '/host/open', '/host/epics', '/host/agent']) {
      expect(ask('POST', pathname, body), pathname).toBeNull()
    }
  })
})
