import { describe, expect, test } from 'bun:test'
import { PROTOCOL, WELL_KNOWN } from 'roadmap-module-protocol'

import { look } from '../server/discover.ts'
import type { Registration } from '../server/registrations.ts'
import { Conversation } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'

/**
 * Silence, which is the condition that has to be got right.
 *
 * A module that is not running looks exactly like a module that was never
 * installed: an address with nothing on it. The difference between them is the
 * difference between pressing start and searching the internet for something
 * that does not exist, and everything in this file is about the host saying
 * which of the two it is.
 *
 * These tests check the SENTENCES as well as the word, and that is deliberate.
 * `condition === 'silent'` passing while the sentence read "module not found"
 * would be a green test over the exact failure the condition exists to prevent.
 */

const AT = 'http://127.0.0.1:7811'
const registration: Registration = {
  id: 'example.journey-notes',
  url: AT,
  file: '/tmp/example.journey-notes.json',
}

/** Words that would make a stopped program look like a missing one. */
function readsAsAbsent(line: string): boolean {
  const lower = line.toLowerCase()
  return (
    /\bnot found\b/.test(lower) ||
    /\bdoes not exist\b/.test(lower) ||
    /\bunknown module\b/.test(lower) ||
    (/\bmissing\b/.test(lower) && !/\bnot (gone |)missing\b/.test(lower))
  )
}

/** Words that would make a stopped program look like a broken one. */
function readsAsBroken(line: string): boolean {
  return /\b(error|crash|failed to load|broken|invalid)\b/i.test(line)
}

describe('a program that is not running', () => {
  test('is silent, and the sentence says so without saying it is missing or broken', async () => {
    const refuses = (async () => {
      throw new TypeError('Unable to connect')
    }) as unknown as typeof fetch

    const presence = await look(registration, refuses)

    expect(presence.condition).toBe('silent')
    expect(presence.line).toContain(AT)
    expect(presence.line).toContain('not running')
    expect(readsAsAbsent(presence.line)).toBe(false)
    expect(readsAsBroken(presence.line)).toBe(false)
  })

  test('a program that accepts a connection and never writes is silent, not hung', async () => {
    const neverAnswers = ((_input: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })) as unknown as typeof fetch

    const began = Date.now()
    const presence = await look(registration, neverAnswers, 60)

    expect(presence.condition).toBe('silent')
    expect(presence.line).toContain('did not answer')
    expect(Date.now() - began).toBeLessThan(2000)
    expect(readsAsAbsent(presence.line)).toBe(false)
  })

  test('a 404 at the well-known path is silence at an address, not an absent program', async () => {
    const notThere = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const presence = await look(registration, notThere)

    expect(presence.condition).toBe('silent')
    expect(presence.line).toContain(AT)
    expect(presence.line).toContain(WELL_KNOWN)
    expect(readsAsAbsent(presence.line)).toBe(false)
  })
})

describe('a page that loads and never speaks', () => {
  test('is reported silent, counted from the greeting rather than from the mount', async () => {
    const contentWindow = { postMessage() {} } as unknown as Window
    const said: string[] = []

    const conversation = new Conversation(
      { contentWindow },
      'example.journey-notes',
      null,
      async () => ({ ok: true, data: null }),
      {
        ready: () => said.push('ready'),
        silent: (line) => said.push(line),
        fault: () => {},
        height: () => {},
      },
      { readyTimeoutMs: 30 },
    )

    /* Nothing is said before the greeting: a module cannot be silent in answer
       to a word nobody has said yet. */
    await Bun.sleep(60)
    expect(said).toHaveLength(0)

    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    await Bun.sleep(60)

    expect(said).toHaveLength(1)
    expect(readsAsAbsent(said[0]!)).toBe(false)
    expect(readsAsBroken(said[0]!)).toBe(false)
    /* The distinction this sentence has to carry: the PROGRAM answered — its
       manifest was read and its page loaded — and the page in it did not. */
    expect(said[0]).toContain('running')
    conversation.close()
  })

  test('a module that answers late is not reported silent at all', async () => {
    const contentWindow = { postMessage() {} } as unknown as Window
    const said: string[] = []

    const conversation = new Conversation(
      { contentWindow },
      'example.journey-notes',
      null,
      async () => ({ ok: true, data: null }),
      {
        ready: () => said.push('ready'),
        silent: (line) => said.push(line),
        fault: () => {},
        height: () => {},
      },
      { readyTimeoutMs: 60 },
    )

    conversation.greet(toWireContext({ epic: null, project: null }, 'dark'))
    await Bun.sleep(10)
    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: 'roadmap.ready', id: 'example.journey-notes', protocol: PROTOCOL },
    })
    await Bun.sleep(90)

    expect(said).toEqual(['ready'])
    conversation.close()
  })
})
