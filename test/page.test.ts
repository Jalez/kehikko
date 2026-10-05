import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cacheControl, contentType, servePage } from '../server/page.ts'

/*
 * The page as the desktop app's compiled host serves it. The binary hands over
 * a map of published paths to embedded files; these are real files on disk
 * standing in for the embedded ones, because `Bun.file` reads both the same way.
 */

const root = mkdtempSync(join(tmpdir(), 'kehikko-page-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

mkdirSync(join(root, 'assets'))
writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div>')
writeFileSync(join(root, 'assets', 'index-abc.js'), 'console.log(1)')
writeFileSync(join(root, 'assets', 'index-abc.css'), 'body{}')
writeFileSync(join(root, 'icon.svg'), '<svg/>')

const files = new Map([
  ['/index.html', join(root, 'index.html')],
  ['/assets/index-abc.js', join(root, 'assets', 'index-abc.js')],
  ['/assets/index-abc.css', join(root, 'assets', 'index-abc.css')],
  ['/icon.svg', join(root, 'icon.svg')],
])

const get = (path: string, method = 'GET') => {
  const url = new URL(path, 'http://127.0.0.1')
  return servePage(files, new Request(url, { method }), url.pathname)
}

describe('servePage', () => {
  test('/ is index.html, revalidated every time', async () => {
    const res = get('/')!
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('id="root"')
  })

  test('a hashed asset is served with its type and kept for a year', async () => {
    const js = get('/assets/index-abc.js')!
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect(await js.text()).toBe('console.log(1)')
    expect(get('/assets/index-abc.css')!.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  test('a file outside assets is not cached forever', () => {
    const svg = get('/icon.svg')!
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('cache-control')).toBe('no-cache')
  })

  test('a route the page owns falls back to index.html', async () => {
    const res = get('/kehikko/3/deep')!
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toContain('id="root"')
  })

  test('a missing asset is a 404, never the document', () => {
    expect(get('/assets/gone.js')!.status).toBe(404)
  })

  test('HEAD answers headers only; other methods are not the page', async () => {
    const head = get('/', 'HEAD')!
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(get('/', 'POST')).toBeNull()
  })

  test('nothing outside the map can be named', async () => {
    const res = get('/%2e%2e/%2e%2e/etc/passwd')!
    expect(await res.text()).toContain('id="root"')
  })

  test('types and caching rules', () => {
    expect(contentType('/a.woff2')).toBe('font/woff2')
    expect(contentType('/noext')).toBe('application/octet-stream')
    expect(cacheControl('/assets/x.js')).toContain('max-age=31536000')
    expect(cacheControl('/index.html')).toBe('no-cache')
  })
})
