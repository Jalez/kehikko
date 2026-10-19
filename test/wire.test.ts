import { describe, expect, test } from 'bun:test'
import { MAX_HEIGHT, MESSAGE, MIN_HEIGHT, PROTOCOL, pressSchema } from 'kehikot-module-protocol'
import { PRESS_BACKSTOP_MS } from 'kehikot-module-protocol/client'

import { Conversation, PRESSED_TIMEOUT_MS, type Answer } from '@/host/conversation.ts'
import { kehikkoOnWire, toWireContext } from '@/host/context.ts'

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
  filters: () => {},
  clearable: () => {},
  refreshable: () => {},
  header: () => {},
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
      { epic: 'modes-are-modules', project: { id: 1, name: 'webapp', path: '/Users/x/Projects/webapp', epics: true, git: true, shared: false } },
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

  test('a message with the kehikot. prefix and the wrong shape is a fault, not silence', () => {
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

  test('anything without the kehikot. prefix is not ours and is left alone', () => {
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

/*
 * The protocol's rule (docs/header.md, "A message type the other side does not
 * know"): a type this host's protocol does not NAME was added by a later
 * version and is dropped without a word; a type it names, in a shape it cannot
 * read, is a fault worth a line. Told apart by `HOST_MESSAGES` and
 * `MODULE_MESSAGES`.
 */
describe('a message type the host does not know is not a fault', () => {
  function listening() {
    const { frame, contentWindow, sent } = frameAndWindow()
    const faults: string[] = []
    const headers: unknown[] = []
    const conversation = new Conversation(frame, 'kehikot.paper', null, async () => nothing, {
      ...quiet(),
      fault: (line) => faults.push(line),
      header: (items) => headers.push(items),
    }, { name: 'Paper' })
    conversation.greet(context)
    sent.length = 0
    const say = (data: unknown) => conversation.receive({ source: contentWindow, origin: 'null', data })
    return { conversation, faults, headers, sent, say }
  }

  test('a kehikot. type from a later protocol is taken and dropped, with nothing said', () => {
    const { conversation, faults, sent, say } = listening()
    /* Taken: it came from this frame, so no other conversation is asked. */
    expect(say({ type: 'kehikot.somethingnew', anything: { at: 'all' } })).toBe(true)
    expect(say({ type: 'kehikot.' })).toBe(true)
    expect(faults).toEqual([])
    expect(sent).toEqual([])
    conversation.close()
  })

  test('a type the host knows, in a shape it cannot read, is still a fault', () => {
    const { conversation, faults, headers, say } = listening()
    /* Two items under one id: the header's own schema refuses it. */
    say({
      type: MESSAGE.HEADER,
      items: [
        { kind: 'toggle', id: 'wrap', label: 'Wrap long lines', checked: false },
        { kind: 'run', id: 'wrap', label: 'Compile' },
      ],
    })
    expect(faults).toEqual(['Paper sent a kehikot.header the host could not read.'])
    expect(headers).toEqual([])
    conversation.close()
  })

  test('a message only a host says, sent by a module, is a fault: the type is known and the sender is confused', () => {
    const { conversation, faults, say } = listening()
    say({ type: MESSAGE.CLEAR, protocol: PROTOCOL })
    expect(faults).toEqual(['Paper sent a kehikot.clear the host could not read.'])
    conversation.close()
  })
})

describe('a module declares its header, and the host holds it', () => {
  const items = [
    { kind: 'switch', id: 'pane', label: 'Pane', value: 'source', options: [{ id: 'source', label: 'Source' }, { id: 'pdf', label: 'PDF' }] },
    { kind: 'run', id: 'compile', label: 'Compile', shortcut: '⌘B' },
  ]

  function listening() {
    const { frame, contentWindow, sent } = frameAndWindow()
    const faults: string[] = []
    const headers: { kind: string; id: string }[][] = []
    const conversation = new Conversation(frame, 'kehikot.paper', null, async () => nothing, {
      ...quiet(),
      fault: (line) => faults.push(line),
      header: (declared) => headers.push(declared),
    })
    conversation.greet(context)
    sent.length = 0
    const say = (data: unknown) => conversation.receive({ source: contentWindow, origin: 'null', data })
    return { conversation, faults, headers, sent, say }
  }

  test('the items reach the canvas whole, parsed, and nothing goes back', () => {
    const { conversation, faults, headers, sent, say } = listening()
    say({ type: MESSAGE.HEADER, items })
    expect(faults).toEqual([])
    expect(headers).toHaveLength(1)
    expect(headers[0]!.map((item) => [item.kind, item.id])).toEqual([['switch', 'pane'], ['run', 'compile']])
    /* The schema's defaults are filled in: a run that said nothing is idle. */
    expect(headers[0]![1]).toMatchObject({ state: 'idle', agents: false })
    /* A declaration is not answered. */
    expect(sent).toEqual([])
    conversation.close()
  })

  test('an empty header is a declaration — the module taking its menus away — and not a silence', () => {
    const { conversation, headers, say } = listening()
    say({ type: MESSAGE.HEADER, items: [] })
    expect(headers).toEqual([[]])
    conversation.close()
  })

  test('a pressed with no press behind it is read and let go', () => {
    const { conversation, faults, headers, sent, say } = listening()
    expect(say({ type: MESSAGE.PRESSED, id: 'p1', ok: true })).toBe(true)
    expect(faults).toEqual([])
    expect(headers).toEqual([])
    expect(sent).toEqual([])
    conversation.close()
  })
  /* The module has answered the greeting, as one that declared a header has. */
  function ready(pressedTimeoutMs?: number) {
    const { frame, contentWindow, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'kehikot.paper', null, async () => nothing, quiet(), {
      name: 'Paper',
      pressedTimeoutMs,
    })
    conversation.greet(context)
    const say = (data: unknown) => conversation.receive({ source: contentWindow, origin: 'null', data })
    say({ type: MESSAGE.READY, id: 'kehikot.paper', protocol: PROTOCOL })
    sent.length = 0
    return { conversation, sent, say }
  }

  test('a press is one kehikot.press with an id, and its pressed settles it', async () => {
    const { conversation, sent, say } = ready()
    const asked = conversation.press('pane', 'pdf')
    expect(sent).toHaveLength(1)
    const press = sent[0]!.message as { type: string; protocol: number; id: string; item: string; value?: unknown }
    expect(press).toMatchObject({ type: MESSAGE.PRESS, protocol: PROTOCOL, item: 'pane', value: 'pdf' })
    expect(pressSchema.safeParse(press).success).toBe(true)
    say({ type: MESSAGE.PRESSED, id: press.id, ok: true })
    expect(await asked).toEqual({ ok: true, why: '' })
    conversation.close()
  })

  test('a toggle carries the state wanted, a run carries nothing, and each has its own id', async () => {
    const { conversation, sent, say } = ready()
    const one = conversation.press('wrap', false)
    const two = conversation.press('compile')
    const [first, second] = sent.map((s) => s.message as { id: string; value?: unknown })
    expect(first!.value).toBe(false)
    expect('value' in second!).toBe(false)
    expect(first!.id).not.toBe(second!.id)
    /* Answered out of order, each lands on its own press. */
    say({ type: MESSAGE.PRESSED, id: second!.id, ok: false, why: 'This paper has no main file to compile.' })
    say({ type: MESSAGE.PRESSED, id: first!.id, ok: true })
    expect(await two).toEqual({ ok: false, why: 'This paper has no main file to compile.' })
    expect(await one).toEqual({ ok: true, why: '' })
    conversation.close()
  })

  test('no pressed in time is "not taken", said in a sentence — and a late one settles nothing', async () => {
    const { conversation, sent, say } = ready(10)
    const came = await conversation.press('compile')
    expect(came).toEqual({ ok: false, why: 'Paper did not answer the press, so it was not taken.' })
    expect(say({ type: MESSAGE.PRESSED, id: (sent[0]!.message as { id: string }).id, ok: true })).toBe(true)
    conversation.close()
  })

  test('the host waits longer than the module’s own client does before it answers for itself', () => {
    expect(PRESSED_TIMEOUT_MS).toBeGreaterThan(PRESS_BACKSTOP_MS)
  })

  test('a page that has not answered the greeting is not pressed, and a closed one settles what was out', async () => {
    const { conversation, sent } = listening()
    expect(await conversation.press('compile')).toEqual({
      ok: false,
      why: 'kehikot.paper has not answered the host yet, so nothing was pressed.',
    })
    expect(sent).toEqual([])
    conversation.close()

    const standing = ready()
    const out = standing.conversation.press('compile')
    standing.conversation.close()
    expect(await out).toEqual({ ok: false, why: 'Paper was taken off the canvas before it answered.' })
    expect(await standing.conversation.press('compile')).toEqual({
      ok: false,
      why: 'Paper was taken off the canvas, so nothing was pressed.',
    })
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
    extension: 'kehikot.notifications@1',
    payload: { epic: 'modes-are-modules', message: 'the tests passed', level: 'info', refs: [] },
    from: 'kehikot.checklist',
    at: '2026-08-28T09:00:00.000Z',
    kehikko: { id: 1, name: 'workbench' },
  }

  test('after the greeting it is posted, whole, with no correlation id on it', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'kehikot.notifications', null, async () => nothing, quiet())
    conversation.greet(context)
    sent.length = 0

    conversation.sendEvent(event)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.message).toEqual(event)
    /* No `id`, and nothing waiting on one. A module that ignores every event it
       is sent is a conforming module, so there is nothing here to correlate and
       nothing for a silent container to hang. */
    expect(sent[0]!.message.id).toBeUndefined()
    conversation.close()
  })

  test('before the greeting it is dropped, which is what best-effort means', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'kehikot.notifications', null, async () => nothing, quiet())

    conversation.sendEvent(event)

    /* Unlike a context, there is no second chance: a context that arrives too
       early is carried in the greeting instead, and an event simply goes. That
       is exactly why a module needing history keeps its own. */
    expect(sent).toHaveLength(0)
    conversation.close()
  })

  test('a closed conversation posts nothing, so a frame taken off the canvas is not written to', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'kehikot.notifications', null, async () => nothing, quiet())
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
    const conversation = new Conversation(frame, 'kehikot.notifications', null, async () => nothing, quiet())
    const here = toWireContext({ epic: null, project: null }, 'dark', [], { id: 7, name: 'workbench' })

    conversation.greet(here)

    expect((sent[0]!.message.context as { kehikko: unknown }).kehikko).toEqual({ id: 7, name: 'workbench' })
    conversation.close()
  })

  test('the kehikko’s key travels beside its row number, in hello and in every context after', () => {
    const { frame, sent } = frameAndWindow()
    const conversation = new Conversation(frame, 'kehikot.claude', null, async () => nothing, quiet())
    const here = toWireContext({ epic: null, project: null }, 'dark', [], { id: 28, name: 'writing', key: '4072c9e5' })

    conversation.greet(here)
    conversation.sendContext(here)

    expect((sent[0]!.message.context as { kehikko: unknown }).kehikko).toEqual({ id: 28, name: 'writing', key: '4072c9e5' })
    expect(sent[1]!.message.kehikko).toEqual({ id: 28, name: 'writing', key: '4072c9e5' })
    conversation.close()
  })

  test('a key a person wrote by hand is a key', () => {
    expect(kehikkoOnWire({ id: 1, name: 'Writing', key: 'writing' })).toEqual({ id: 1, name: 'Writing', key: 'writing' })
    expect(kehikkoOnWire({ id: 1, name: 'Writing', key: '12345678' })?.key).toBe('12345678')
  })

  test('a key the protocol would not read is left off, and costs the context nothing else', () => {
    const webapp = { id: 1, name: 'webapp', path: '/Users/x/Projects/webapp', epics: true, git: true, shared: false }
    for (const key of ['Writing', 'a', '-writing', 'writing-', 'a'.repeat(33), '']) {
      const here = toWireContext({ epic: 'modes-are-modules', project: webapp }, 'dark', ['gh#1'], { id: 2, name: 'reading', key })
      expect(here.kehikko).toEqual({ id: 2, name: 'reading' })
      /* Absent, not undefined: the protocol's own reading of a kehikko without one. */
      expect(Object.hasOwn(here.kehikko!, 'key')).toBe(false)
      expect(here.epic).toBe('modes-are-modules')
      expect(here.projectPath).toBe('/Users/x/Projects/webapp')
      expect(here.selection).toEqual(['gh#1'])
    }
  })

  test('a host that has no key for a kehikko says the two fields it always said', () => {
    expect(toWireContext({ epic: null, project: null }, 'dark', [], { id: 7, name: 'workbench' }).kehikko).toEqual({ id: 7, name: 'workbench' })
    expect(kehikkoOnWire(null)).toBeNull()
  })

  test('a host with no canvas open says null rather than leaving the field off', () => {
    /* Null is a state a module must be able to move into, and the protocol says
       so: it can still show everything it is sent, it simply cannot sort near
       from far. A missing field would be a module reading `undefined` and
       having no way to tell that from a host that is broken. */
    expect(toWireContext({ epic: null, project: null }, 'dark').kehikko).toBeNull()
  })

  test('an epic slug the schema refuses does not cost the module its bearings', () => {
    const webapp = { id: 1, name: 'webapp', path: '/Users/x/Projects/webapp', epics: true, git: true, shared: false }
    const here = toWireContext({ epic: 'NOT A SLUG '.repeat(40), project: webapp }, 'light', ['gh#1'], {
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
    expect(here.project).toBe('webapp')
    expect(here.projectPath).toBe('/Users/x/Projects/webapp')
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
        project: { id: 3, name: 'thesis_latex', path: '/Users/x/Claude/thesis_latex', epics: false, git: true, shared: false },
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
    const webapp = { id: 1, name: 'webapp', path: '/Users/x/Projects/webapp', epics: true, git: true, shared: false }
    const thesis = { id: 3, name: 'thesis_latex', path: '/Users/x/Claude/thesis_latex', epics: false, git: true, shared: false }
    const kehikko = { id: 7, name: 'writing' }

    const before = toWireContext({ epic: 'modes-are-modules', project: webapp }, 'dark', [], kehikko)
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

describe('a module can hand the host a control it cannot draw itself', () => {
  test('an offer reaches the canvas, unread', () => {
    const { frame, contentWindow, sent } = frameAndWindow()
    const offers: unknown[] = []
    const conversation = new Conversation(frame, 'example.notifications', null, async () => nothing, {
      ...quiet(),
      filters: (groups) => offers.push(groups),
    })
    conversation.greet(context)
    sent.length = 0

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: {
        type: MESSAGE.FILTERS,
        groups: [
          {
            id: 'scope',
            label: 'which kehikko',
            fallback: 'all',
            options: [
              { id: 'all', label: 'everything' },
              { id: 'here', label: 'this kehikko' },
            ],
          },
        ],
      },
    })

    expect(offers).toHaveLength(1)
    /* Nothing goes back. It is fire and forget, like `resize`: what returns is
       a `kehikot.context` when somebody presses something, and only then. */
    expect(sent).toHaveLength(0)
  })

  /*
   * An empty offer is a module WITHDRAWING the control, not a module saying
   * nothing. A merge could never take a group away, so a module that stopped
   * offering something would leave a control behind that a person could press
   * and nothing would answer.
   */
  test('an empty offer is a message and not a silence', () => {
    const { frame, contentWindow } = frameAndWindow()
    const offers: unknown[] = []
    const conversation = new Conversation(frame, 'example.notifications', null, async () => nothing, {
      ...quiet(),
      filters: (groups) => offers.push(groups),
    })
    conversation.greet(context)

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: { type: MESSAGE.FILTERS, groups: [] },
    })
    expect(offers).toEqual([[]])
  })

  /*
   * A group whose fallback names nothing would turn the recovery path — "that
   * option is gone, go back to the resting one" — into a second broken state.
   * The schema refuses it, and the host reports a fault rather than drawing it.
   */
  test('an offer the schema will not take is a fault, not a control', () => {
    const { frame, contentWindow } = frameAndWindow()
    const offers: unknown[] = []
    const faults: string[] = []
    const conversation = new Conversation(frame, 'example.notifications', null, async () => nothing, {
      ...quiet(),
      fault: (line) => faults.push(line),
      filters: (groups) => offers.push(groups),
    })
    conversation.greet(context)

    conversation.receive({
      source: contentWindow,
      origin: 'null',
      data: {
        type: MESSAGE.FILTERS,
        groups: [{ id: 'scope', label: 'scope', fallback: 'nowhere', options: [{ id: 'all', label: 'all' }] }],
      },
    })
    expect(offers).toEqual([])
    expect(faults).toHaveLength(1)
  })
})
