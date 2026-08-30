import { describe, expect, test } from 'bun:test'
import { MESSAGE, PROTOCOL } from 'roadmap-module-protocol'

import { BURST, EventBus, PER_SECOND } from '../src/host/events.ts'

/**
 * Delivery, and the four things it must never do: forge a sender, echo to the
 * sender, carry a payload it has not checked, and let one module have the
 * canvas to itself.
 *
 * Every test here builds its own bus, because a bus holds a token bucket per
 * module and a shared one would make these tests depend on their own order.
 */

const KEHIKKO = { id: 3, name: 'workbench' }
const NOTE = { epic: 'modes-are-modules', message: 'the tests passed' }

/** A framed module that writes down what it was handed. */
function listener(consumes: string[]) {
  const heard: Record<string, unknown>[] = []
  return { consumes, heard, send: (event: unknown) => void heard.push(event as Record<string, unknown>) }
}

describe('who hears an event', () => {
  test('a module that consumes the format hears it, with the host\'s own fields on it', () => {
    const bus = new EventBus()
    const shower = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', shower)

    const out = bus.emit('roadmap.checklist', 'roadmap.notifications@1', NOTE, KEHIKKO)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.delivered).toBe(1)
    expect(shower.heard).toHaveLength(1)
    const event = shower.heard[0]!
    expect(event.type).toBe(MESSAGE.EVENT)
    expect(event.protocol).toBe(PROTOCOL)
    expect(event.extension).toBe('roadmap.notifications@1')
    expect(event.from).toBe('roadmap.checklist')
    expect(event.kehikko).toEqual(KEHIKKO)
    expect(typeof event.at).toBe('string')
  })

  test('a module that does not consume the format hears nothing at all', () => {
    const bus = new EventBus()
    const shower = listener(['roadmap.notifications@1'])
    const bystander = listener([])
    const otherFormat = listener(['roadmap.calls@1'])
    bus.join('roadmap.notifications', shower)
    bus.join('roadmap.journeys', bystander)
    bus.join('roadmap.mapmaker', otherFormat)

    const out = bus.emit('roadmap.checklist', 'roadmap.notifications@1', NOTE, KEHIKKO)

    expect(out.ok && out.delivered).toBe(1)
    expect(bystander.heard).toHaveLength(0)
    /* A module that consumes a DIFFERENT format is the case worth having its
       own assertion: "declared an extension" and "declared this extension" are
       one character apart in an `includes` and the difference is a panel
       showing somebody else's traffic. */
    expect(otherFormat.heard).toHaveLength(0)
  })

  test('the sender does not hear its own event, even when it consumes what it emits', () => {
    const bus = new EventBus()
    /* Legitimate and not a mistake: a module may both post notifications and
       show them. Echoing it back would make every such module carry an "is this
       me" check, and the first one to get it wrong draws its own lines twice. */
    const both = listener(['roadmap.notifications@1'])
    const other = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', both)
    bus.join('roadmap.checklist', other)

    const out = bus.emit('roadmap.notifications', 'roadmap.notifications@1', NOTE, KEHIKKO)

    expect(out.ok && out.delivered).toBe(1)
    expect(both.heard).toHaveLength(0)
    expect(other.heard).toHaveLength(1)
  })

  test('emitting into an empty room succeeds and says nobody heard', () => {
    const bus = new EventBus()
    const out = bus.emit('roadmap.checklist', 'roadmap.notifications@1', NOTE, KEHIKKO)
    /* Not a refusal. The event was fine and the host carried it; nothing on
       this canvas consumes the format. Refusing here would send an author
       looking for a bug in a payload that has none. */
    expect(out.ok).toBe(true)
    expect(out.ok && out.delivered).toBe(0)
  })

  test('a module that has left hears nothing more', () => {
    const bus = new EventBus()
    const shower = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', shower)
    bus.leave('roadmap.notifications')
    bus.emit('roadmap.checklist', 'roadmap.notifications@1', NOTE, KEHIKKO)
    expect(shower.heard).toHaveLength(0)
  })

  test('one receiver that throws does not stop the others', () => {
    const bus = new EventBus()
    const gone = {
      consumes: ['roadmap.notifications@1'],
      send: () => {
        throw new Error('this frame navigated away')
      },
    }
    const alive = listener(['roadmap.notifications@1'])
    bus.join('roadmap.dead', gone)
    bus.join('roadmap.notifications', alive)

    const out = bus.emit('roadmap.checklist', 'roadmap.notifications@1', NOTE, KEHIKKO)

    expect(alive.heard).toHaveLength(1)
    /* Counted honestly: one heard it. A sender told "2" about a frame that is
       not there would be a sender that cannot tell delivery from the appearance
       of it. */
    expect(out.ok && out.delivered).toBe(1)
  })
})

describe('what the host vouches for', () => {
  test('a format the host cannot check is refused rather than carried', () => {
    const bus = new EventBus()
    const shower = listener(['somebody.else@7'])
    bus.join('roadmap.notifications', shower)

    const out = bus.emit('roadmap.checklist', 'somebody.else@7', { anything: true }, KEHIKKO)

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('does not know')
    /* The receiver declared it and still gets nothing, which is the point: an
       event delivered unvalidated is one every consumer has to distrust, and a
       consumer's willingness is not a substitute for the host's check. */
    expect(shower.heard).toHaveLength(0)
  })

  test('a payload that does not fit its format names the field and is not delivered', () => {
    const bus = new EventBus()
    const shower = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', shower)

    const out = bus.emit('roadmap.checklist', 'roadmap.notifications@1', { message: '' }, KEHIKKO)

    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('format')
    expect(shower.heard).toHaveLength(0)
  })

  test('the payload delivered is the parsed one, so a receiver reads the format\'s defaults', () => {
    const bus = new EventBus()
    const shower = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', shower)

    bus.emit('roadmap.checklist', 'roadmap.notifications@1', NOTE, KEHIKKO)

    const payload = shower.heard[0]!.payload as { level: string; refs: string[] }
    /* The sender sent neither. A receiver that had to know which fields the
       format defaults and which the sender omitted would be a receiver
       implementing the schema a second time. */
    expect(payload.level).toBe('info')
    expect(payload.refs).toEqual([])
  })

  test('`from` is the host\'s word: a payload claiming to be somebody else changes nothing', () => {
    const bus = new EventBus()
    const shower = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', shower)

    bus.emit(
      'roadmap.checklist',
      'roadmap.notifications@1',
      /* `from` is not a field of this format and could not be set even if it
         were — `emit` takes the sender as an argument the frame cannot reach.
         The assertion is that nothing in the payload leaks into the envelope. */
      { ...NOTE, from: 'roadmap.tests', module: 'roadmap.tests' },
      KEHIKKO,
    )

    expect(shower.heard[0]!.from).toBe('roadmap.checklist')
  })

  test('a null kehikko is carried as null rather than dropped', () => {
    const bus = new EventBus()
    const shower = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', shower)
    bus.emit('roadmap.checklist', 'roadmap.notifications@1', NOTE, null)
    /* A receiver has to be able to tell "this happened nowhere I can name" from
       "this field was not sent", because the first is a filter it cannot honour
       and the second is a host that is broken. */
    expect(shower.heard[0]!.kehikko).toBeNull()
  })
})

describe('the bound, and what it says about what it drops', () => {
  test('a burst goes through and the one after it does not', () => {
    let clock = 0
    const bus = new EventBus(() => clock)
    const shower = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', shower)

    for (let i = 0; i < BURST; i += 1) {
      expect(bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO).ok).toBe(true)
    }
    const over = bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)

    expect(over.ok).toBe(false)
    expect(shower.heard).toHaveLength(BURST)
  })

  test('what is dropped is said, not dropped silently, and the count is in the sentence', () => {
    let clock = 0
    const bus = new EventBus(() => clock)
    bus.join('roadmap.notifications', listener(['roadmap.notifications@1']))
    for (let i = 0; i < BURST; i += 1) bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)

    bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)
    bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)
    const third = bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)

    expect(third.ok).toBe(false)
    if (third.ok) return
    /* "This is the third you have lost" is what tells an author they are in a
       loop. "Rate limited" tells them to add a retry, which makes it worse. */
    expect(third.error).toContain('NOT delivered')
    expect(third.error).toContain('2 before it')
    expect(third.error).toContain(String(PER_SECOND))
  })

  test('nothing is queued: what was refused does not arrive later', () => {
    let clock = 0
    const bus = new EventBus(() => clock)
    const shower = listener(['roadmap.notifications@1'])
    bus.join('roadmap.notifications', shower)

    for (let i = 0; i < BURST + 10; i += 1) bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)
    /* A minute later, with the bucket long since full again. */
    clock += 60_000
    bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)

    /* The burst, plus the one emitted after the wait. The ten that were refused
       are gone, and that is the design: an event held back until the storm
       passed would arrive describing the past. */
    expect(shower.heard).toHaveLength(BURST + 1)
  })

  test('the bucket refills, so a module that slows down is heard again', () => {
    let clock = 0
    const bus = new EventBus(() => clock)
    bus.join('roadmap.notifications', listener(['roadmap.notifications@1']))
    for (let i = 0; i < BURST; i += 1) bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)
    expect(bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO).ok).toBe(false)

    clock += 1000

    /* One second buys exactly PER_SECOND of them. */
    for (let i = 0; i < PER_SECOND; i += 1) {
      expect(bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO).ok).toBe(true)
    }
    expect(bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO).ok).toBe(false)
  })

  test('one module in a loop does not spend another module\'s allowance', () => {
    let clock = 0
    const bus = new EventBus(() => clock)
    bus.join('roadmap.notifications', listener(['roadmap.notifications@1']))
    for (let i = 0; i < BURST + 5; i += 1) bus.emit('roadmap.loud', 'roadmap.notifications@1', NOTE, KEHIKKO)

    /* The bucket is per sender. A shared one would mean the noisiest pane on
       the canvas deciding whether anybody else is heard, which is the same
       failure the limit exists to prevent, one level up. */
    expect(bus.emit('roadmap.quiet', 'roadmap.notifications@1', NOTE, KEHIKKO).ok).toBe(true)
  })
})

describe('who consumes what, as the host can see it', () => {
  test('consumersOf names the modules that would hear a format', () => {
    const bus = new EventBus()
    bus.join('roadmap.notifications', listener(['roadmap.notifications@1']))
    bus.join('roadmap.activity', listener(['roadmap.notifications@1', 'roadmap.calls@1']))
    bus.join('roadmap.journeys', listener([]))

    expect(bus.consumersOf('roadmap.notifications@1').sort()).toEqual([
      'roadmap.activity',
      'roadmap.notifications',
    ])
    expect(bus.consumersOf('roadmap.calls@1')).toEqual(['roadmap.activity'])
    expect(bus.consumersOf('nobody@1')).toEqual([])
  })
})
