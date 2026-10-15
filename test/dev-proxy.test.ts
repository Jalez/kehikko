import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import { endWithUpstream } from '../vite.config.ts'

/**
 * The dev page's proxy passes on an API that went away mid-answer.
 *
 * Without it, Vite's proxy held the page's half of `/host/watch` open after
 * the API process was stopped, the page's `EventSource` never saw its stream
 * end, never reconnected, and a restarted API never heard again which kehikko
 * the page had open. See `endWithUpstream` in `vite.config.ts`.
 */
class Upstream extends EventEmitter {
  complete = false
}
class Answer {
  writableEnded = false
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

describe('a proxied answer and the API behind it', () => {
  test('an answer the API stopped in the middle is ended for the page too', () => {
    const upstream = new Upstream()
    const answer = new Answer()
    endWithUpstream(upstream, null, answer)
    upstream.emit('close')
    expect(answer.destroyed).toBe(true)
  })

  test('an answer that arrived whole is left to finish the ordinary way', () => {
    const upstream = new Upstream()
    const answer = new Answer()
    endWithUpstream(upstream, null, answer)
    upstream.complete = true
    upstream.emit('close')
    expect(answer.destroyed).toBe(false)
  })

  test('an answer already ended is not touched', () => {
    const upstream = new Upstream()
    const answer = new Answer()
    endWithUpstream(upstream, null, answer)
    answer.writableEnded = true
    upstream.emit('close')
    expect(answer.destroyed).toBe(false)
  })
})
