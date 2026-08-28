import { describe, expect, test } from 'bun:test'

import { isLoopback, parseRegistrationBody, readRegistration } from '../server/registrations.ts'

/**
 * How the host finds anything at all.
 *
 * A registration silently skipped is the worst failure this design has:
 * somebody wrote a file, nothing appeared, and there is nowhere to look. Every
 * refusal below produces a sentence, and the tests check that it does.
 */

describe('the file name is the module id', () => {
  test('a registration cannot claim to be for a module it is not', () => {
    const read = readRegistration('example.journey-notes.json', '{"url":"http://127.0.0.1:7811"}')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.registration.id).toBe('example.journey-notes')
  })

  test('an id inside the file does not override the one on it', () => {
    const read = readRegistration(
      'example.journey-notes.json',
      '{"url":"http://127.0.0.1:7811","id":"somebody.else"}',
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.registration.id).toBe('example.journey-notes')
  })

  test('a file name that is not a module id is refused with a sentence', () => {
    const read = readRegistration('Not An Id.json', '{"url":"http://127.0.0.1:7811"}')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.why).toContain('module id')
  })
})

describe('what a registration may say', () => {
  test('a port alone is enough, and means loopback', () => {
    const read = readRegistration('a.b.json', '{"port":7811}')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.registration.url).toBe('http://127.0.0.1:7811')
  })

  test('the flat yaml the example registration is written in is read', () => {
    const read = readRegistration(
      'example.journey-notes.yaml',
      ['# a comment', 'url: http://127.0.0.1:7811  # where it answers', 'port: 7811'].join('\n'),
    )
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.registration.url).toBe('http://127.0.0.1:7811')
  })

  test('a registration saying nothing about where to look says so', () => {
    const read = readRegistration('a.b.json', '{}')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.why).toContain('nowhere to look')
  })

  test('an address on another machine is refused, and the refusal says what this host is', () => {
    const read = readRegistration('a.b.json', '{"url":"https://modules.example.com"}')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.why).toContain('loopback')
  })

  test('a body a stranger wrote cannot reach through the prototype', () => {
    const fields = parseRegistrationBody('{"url":"http://127.0.0.1:1"}', 'a.json')
    expect(Object.getPrototypeOf(fields)).toBeNull()
    expect((fields as Record<string, unknown>).constructor).toBeUndefined()
  })
})

describe('loopback, written out rather than guessed at', () => {
  test('the addresses of this machine', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopback(host)).toBe(true)
    }
  })

  test('and everything else', () => {
    for (const host of ['example.com', '10.0.0.1', '0.0.0.0', '127.example.com', '1270.0.0.1']) {
      expect(isLoopback(host)).toBe(false)
    }
  })
})
