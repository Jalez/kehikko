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
    conversation.sendContext(toWireContext(
      { epic: 'modes-are-modules', project: { id: 1, name: 'roadmap', path: '/Users/x/Projects/roadmap', epics: true } },
      'dark',
    ))
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

describe('an event goes into the frame and is never answered', () => {
  const event = {
    type: MESSAGE.EVENT,
    protocol: PROTOCOL,
    extension: 'roadmap.notifications@1',
    payload: { epic: 'modes-are-modules', message: 'the tests passed', level: 'info', refs: [] },
    from: 'roadmap.checklist',
    at: '2026-08-28T09:00:00.000Z',
    kehikko: { id: 1, name: 'workbench' },
  }

  test('after the greeting it is posted, whole, with no correlation id on it', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'roadmap.notifications', null, async () => nothing, quiet())
    conversation.greet(context)
    sent.length = 0

    conversation.sendEvent(event)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.message).toEqual(event)
    /* No `id`, and nothing waiting on one. A module that ignores every event it
       is sent is a conforming module, so there is nothing here to correlate and
       nothing for a silent pane to hang. */
    expect(sent[0]!.message.id).toBeUndefined()
    conversation.close()
  })

  test('before the greeting it is dropped, which is what best-effort means', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'roadmap.notifications', null, async () => nothing, quiet())

    conversation.sendEvent(event)

    /* Unlike a context, there is no second chance: a context that arrives too
       early is carried in the greeting instead, and an event simply goes. That
       is exactly why a module needing history keeps its own. */
    expect(sent).toHaveLength(0)
    conversation.close()
  })

  test('a closed conversation posts nothing, so a frame taken off the canvas is not written to', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'roadmap.notifications', null, async () => nothing, quiet())
    conversation.greet(context)
    conversation.close()
    sent.length = 0

    conversation.sendEvent(event)

    expect(sent).toHaveLength(0)
  })
})

describe('the context says which kehikko is being looked at', () => {
  test('the open canvas travels in hello, so a module knows where it is standing', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'roadmap.notifications', null, async () => nothing, quiet())
    const here = toWireContext({ epic: null, project: null }, 'dark', [], { id: 7, name: 'workbench' })

    conversation.greet(here)

    expect((sent[0]!.message.context as { kehikko: unknown }).kehikko).toEqual({ id: 7, name: 'workbench' })
    conversation.close()
  })

  test('a host with no canvas open says null rather than leaving the field off', () => {
    /* Null is a state a module must be able to move into, and the protocol says
       so: it can still show everything it is sent, it simply cannot sort near
       from far. A missing field would be a module reading `undefined` and
       having no way to tell that from a host that is broken. */
    expect(toWireContext({ epic: null, project: null }, 'dark').kehikko).toBeNull()
  })

  test('an epic slug the schema refuses does not cost the module its bearings', () => {
    const roadmap = { id: 1, name: 'roadmap', path: '/Users/x/Projects/roadmap', epics: true }
    const here = toWireContext({ epic: 'NOT A SLUG '.repeat(40), project: roadmap }, 'light', ['gh#1'], {
      id: 2,
      name: 'reading',
    })
    /* The epic and the selection go, because the refs were picked out of an
       epic this context no longer names. Where the canvas IS — which kehikko,
       and which project — has nothing to do with whether a slug parses, and
       blanking either would turn one bad slug into every module losing the
       folder it works in. */
    expect(here.epic).toBeNull()
    expect(here.selection).toEqual([])
    expect(here.kehikko).toEqual({ id: 2, name: 'reading' })
    expect(here.project).toBe('roadmap')
    expect(here.projectPath).toBe('/Users/x/Projects/roadmap')
  })
})

describe('the context says which project the kehikko is in, and where it is', () => {
  test('a name to print and a path to open, filled in from one project', () => {
    /* Two nullable fields on the wire that could disagree — see `projectPath`
       in the protocol's `wire.ts`. The way a host stops them disagreeing is to
       have exactly one place that writes them, and this is that place. */
    const here = toWireContext(
      {
        epic: 'modes-are-modules',
        project: { id: 3, name: 'thesis_latex', path: '/Users/x/Claude/thesis_latex', epics: false },
      },
      'dark',
    )
    expect(here.project).toBe('thesis_latex')
    expect(here.projectPath).toBe('/Users/x/Claude/thesis_latex')
  })

  test('no project open is null in both, not an empty string in either', () => {
    /* "There is no project" is a state a module has to be able to move INTO —
       the same rule the epic is nullable for. An empty string is a project
       whose name is nothing, which is a different and untrue sentence. */
    const here = toWireContext({ epic: null, project: null }, 'light')
    expect(here.project).toBeNull()
    expect(here.projectPath).toBeNull()
  })

  test('switching project changes what every module is told, and nothing else', () => {
    const roadmap = { id: 1, name: 'roadmap', path: '/Users/x/Projects/roadmap', epics: true }
    const thesis = { id: 3, name: 'thesis_latex', path: '/Users/x/Claude/thesis_latex', epics: false }
    const kehikko = { id: 7, name: 'writing' }

    const before = toWireContext({ epic: 'modes-are-modules', project: roadmap }, 'dark', [], kehikko)
    const after = toWireContext({ epic: 'modes-are-modules', project: thesis }, 'dark', [], kehikko)

    expect(before.projectPath).not.toBe(after.projectPath)
    /* Everything else is the same object's worth of facts. A module is
       RE-POINTED, not reloaded — which is the choice the user made over VS
       Code's extension-host restart, because a restart destroys every module's
       document and a running terminal dies with it. */
    expect(after.epic).toBe(before.epic)
    expect(after.theme).toBe(before.theme)
    expect(after.kehikko).toEqual(before.kehikko)
  })
})
