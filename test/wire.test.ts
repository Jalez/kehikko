import { describe, expect, test } from 'bun:test'
import { MAX_HEIGHT, MESSAGE, MIN_HEIGHT, PROTOCOL } from 'roadmap-module-protocol'

import { Conversation, type Answer } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'

/**
 * The wire, tested without a browser.
 *
 * `Conversation` takes the frame as `{ contentWindow }` and takes messages as
 * plain objects, which is not an accommodation for testing — it is what the
 * class actually depends on. A fake window here is a real window as far as
 * every line under test is concerned, and the one thing that would be untrue in
 * a fake — the identity of the sender — is the thing the tests below check
 * hardest.
 */

interface Sent {
  message: Record<string, unknown>
  targetOrigin: string
}

function frameAndWindow() {
  const sent: Sent[] = []
  const contentWindow = {
    postMessage(message: unknown, targetOrigin: string) {
      sent.push({ message: message as Record<string, unknown>, targetOrigin })
    },
  } as unknown as Window
  return { frame: { contentWindow }, contentWindow, sent }
}

const quiet = () => ({
  ready: () => {},
  silent: () => {},
  fault: () => {},
  height: () => {},
})

const nothing: Answer = { ok: true, data: null }
const context = toWireContext({ epic: null, project: null }, 'dark')

describe('the host greets first', () => {
  test('hello carries the protocol both sides settled on, a session, and the context', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, quiet(), {
      session: 'session-1',
    })

    conversation.greet(context)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.message).toMatchObject({
      type: MESSAGE.HELLO,
      protocol: PROTOCOL,
      session: 'session-1',
    })
    expect(sent[0]!.message.context).toEqual(context)
    conversation.close()
  })

  test("an opaque frame is addressed with '*', because it has no origin to name", () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, quiet())
    conversation.greet(context)
    expect(sent[0]!.targetOrigin).toBe('*')
    conversation.close()
  })

  test('a module that asked for storage has an origin, and is addressed by it', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(
      frame,
      'example.notes',
      'http://127.0.0.1:7811',
      async () => nothing,
      quiet(),
    )
    conversation.greet(context)
    expect(sent[0]!.targetOrigin).toBe('http://127.0.0.1:7811')
    conversation.close()
  })

  test('context is not sent before the greeting, because there is nobody to send it to yet', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, quiet())
    conversation.sendContext(context)
    expect(sent).toHaveLength(0)
    conversation.close()
  })

  test('context is re-sent whenever it changes', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, quiet())
    conversation.greet(context)
    conversation.sendContext(toWireContext({ epic: 'modes-are-modules', project: 'roadmap' }, 'dark'))
    expect(sent[1]!.message).toMatchObject({ type: MESSAGE.CONTEXT, protocol: PROTOCOL })
    conversation.close()
  })
})

describe('the identity is the frame, never the origin', () => {
  test('a message from another window is not this conversation, whatever its origin says', () => {
    const { frame } = frameAndWindow()
    let ready = 0
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, {
      ...quiet(),
      ready: () => {
        ready += 1
      },
    })
    conversation.greet(context)

    const impostor = { postMessage() {} } as unknown as Window
    const taken = conversation.receive({
      source: impostor,
      /* The origin every opaque frame in the browser reports. A host that
         compared origins would accept this. */
      origin: 'null',
      data: { type: MESSAGE.READY, id: 'example.notes', protocol: PROTOCOL },
    })

    expect(taken).toBe(false)
    expect(ready).toBe(0)
    conversation.close()
  })

  test('a message from the frame is taken even though its origin is the shared "null"', () => {
    const { frame, contentWindow } = frameAndWindow()
    let ready = 0
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, {
      ...quiet(),
      ready: () => {
        ready += 1
      },
    })
    conversation.greet(context)

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.READY, id: 'example.notes', protocol: PROTOCOL },
    })

    expect(ready).toBe(1)
    conversation.close()
  })

  test('when a module does have an origin, a mismatched one is refused as a second condition', () => {
    const { frame, contentWindow } = frameAndWindow()
    let ready = 0
    const conversation = new Conversation(
      frame,
      'example.notes',
      'http://127.0.0.1:7811',
      async () => nothing,
      { ...quiet(), ready: () => { ready += 1 } },
    )
    conversation.greet(context)

    conversation.receive({
      source: contentWindow,
      origin: 'http://127.0.0.1:9999',
      data: { type: MESSAGE.READY, id: 'example.notes', protocol: PROTOCOL },
    })

    expect(ready).toBe(0)
    conversation.close()
  })

  test('a ready under the wrong name is a fault, not an impersonation: the module is still ready', () => {
    const { frame, contentWindow } = frameAndWindow()
    const faults: string[] = []
    let ready = 0
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, {
      ...quiet(),
      ready: () => { ready += 1 },
      fault: (line) => faults.push(line),
    })
    conversation.greet(context)

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.READY, id: 'somebody.else', protocol: PROTOCOL },
    })

    expect(ready).toBe(1)
    expect(faults[0]).toContain('somebody.else')
    conversation.close()
  })
})

describe('one question, one answer, one id', () => {
  test('a request is answered with a response carrying the same id', async () => {
    const { frame, contentWindow, sent } = frameAndWindow()
    const conversation = new Conversation(
      frame,
      'example.notes',
      null,
      async (method) => ({ ok: true, data: { asked: method } }),
      quiet(),
    )
    conversation.greet(context)

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.REQUEST, id: 'q1', method: 'epics.list', params: {} },
    })
    await Bun.sleep(0)

    const response = sent.find((one) => one.message.type === MESSAGE.RESPONSE)
    expect(response?.message).toEqual({
      type: MESSAGE.RESPONSE,
      id: 'q1',
      ok: true,
      data: { asked: 'epics.list' },
    })
    conversation.close()
  })

  test('a refusal carries both halves: a reason for the program and a sentence for the person', async () => {
    const { frame, contentWindow, sent } = frameAndWindow()
    const conversation = new Conversation(
      frame,
      'example.notes',
      null,
      async () => ({ ok: false, reason: 'unknown-method', error: 'Nothing here answers it.' }),
      quiet(),
    )
    conversation.greet(context)

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.REQUEST, id: 'q2', method: 'nope', params: {} },
    })
    await Bun.sleep(0)

    const response = sent.find((one) => one.message.type === MESSAGE.RESPONSE)
    expect(response?.message).toEqual({
      type: MESSAGE.RESPONSE,
      id: 'q2',
      ok: false,
      reason: 'unknown-method',
      error: 'Nothing here answers it.',
    })
    conversation.close()
  })

  test('a message with the roadmap prefix and the wrong shape is a fault, not silence', () => {
    const { frame, contentWindow } = frameAndWindow()
    const faults: string[] = []
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, {
      ...quiet(),
      fault: (line) => faults.push(line),
    })
    conversation.greet(context)

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.REQUEST, id: '', method: '', params: 'not an object' },
    })

    expect(faults).toHaveLength(1)
    conversation.close()
  })

  test('anything without the roadmap prefix is not ours and is left alone', () => {
    const { frame, contentWindow } = frameAndWindow()
    const faults: string[] = []
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, {
      ...quiet(),
      fault: (line) => faults.push(line),
    })
    conversation.greet(context)

    /* A bundler's hot-reload socket, which posts at every window it can reach. */
    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: 'vite:beforeUpdate', updates: [] },
    })

    expect(faults).toHaveLength(0)
    conversation.close()
  })
})

describe('a height is asked for, and the host does its own arithmetic', () => {
  test('a reasonable height is passed through', () => {
    const { frame, contentWindow } = frameAndWindow()
    const heights: number[] = []
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, {
      ...quiet(),
      height: (px) => heights.push(px),
    })
    conversation.greet(context)
    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.RESIZE, height: 640 },
    })
    expect(heights).toEqual([640])
    conversation.close()
  })

  test('a module cannot make itself disappear, or push everything below it over the horizon', () => {
    const { frame, contentWindow } = frameAndWindow()
    const heights: number[] = []
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, {
      ...quiet(),
      height: (px) => heights.push(px),
    })
    conversation.greet(context)
    for (const height of [2, 10_000_000]) {
      conversation.receive({
        source: contentWindow,
        origin: 'null',
        data: { type: MESSAGE.RESIZE, height },
      })
    }
    expect(heights).toEqual([MIN_HEIGHT, MAX_HEIGHT])
    conversation.close()
  })

  test('a height that is not a number never reaches the arithmetic', () => {
    const { frame, contentWindow } = frameAndWindow()
    const heights: number[] = []
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, {
      ...quiet(),
      height: (px) => heights.push(px),
    })
    conversation.greet(context)
    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.RESIZE, height: '600' },
    })
    expect(heights).toEqual([])
    conversation.close()
  })
})

describe('goto is the one place the host waits, so it always stops waiting', () => {
  test('an answer resolves the walk', async () => {
    const { frame, contentWindow, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, quiet(), {
      wentTimeoutMs: 50,
    })
    conversation.greet(context)

    const walk = conversation.goto({ ref: 'gh#41' })
    const asked = sent.find((one) => one.message.type === MESSAGE.GOTO)
    expect(asked?.message).toMatchObject({ type: MESSAGE.GOTO, ref: 'gh#41' })

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.WENT, id: asked!.message.id, found: true, why: '' },
    })

    expect(await walk).toEqual({ found: true, why: '' })
    conversation.close()
  })

  test('a module that never answers cannot hang a reference: the timeout means found: false', async () => {
    const { frame } = frameAndWindow()
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, quiet(), {
      wentTimeoutMs: 20,
    })
    conversation.greet(context)

    const walk = await conversation.goto({ ref: 'gh#41' })

    expect(walk.found).toBe(false)
    expect(walk.why).toContain('did not answer')
    conversation.close()
  })

  test('closing the conversation settles a walk still in flight rather than dropping it', async () => {
    const { frame } = frameAndWindow()
    const conversation = new Conversation(frame, 'example.notes', null, async () => nothing, quiet(), {
      wentTimeoutMs: 10_000,
    })
    conversation.greet(context)
    const walk = conversation.goto({ ref: 'gh#41' })
    conversation.close()
    expect(await walk).toEqual({ found: false, why: 'the frame was taken off the canvas' })
  })
})
