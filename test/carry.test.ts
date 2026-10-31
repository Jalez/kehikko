import { describe, expect, test } from 'bun:test'
import { LIMITS, footerItemsSchema, headerItemsSchema } from 'kehikot-module-protocol'

import { CARRIES, carry, type CarryIo } from '../src/host/carry.ts'
import { footerPressing } from '../src/host/footer.ts'

/*
 * Acts the host carries out for a run (protocol 2.40.0): the copy or the open is started in the
 * person's click, here, and only then is the press sent, saying what was carried. https only;
 * text only; capped by the schema and asked again here.
 */

function io(written = true) {
  const did: { copied: unknown[]; opened: string[] } = { copied: [], opened: [] }
  const fake: CarryIo = {
    copy: (copy) => {
      did.copied.push(copy)
      return Promise.resolve(written)
    },
    open: (url) => {
      did.opened.push(url)
      return true
    },
  }
  return { did, fake }
}

describe('what the host carries', () => {
  test('the greeting says copy and open', () => {
    expect(CARRIES).toEqual(['copy', 'open'])
  })

  test('a copy is written with both types, started before the promise is awaited', async () => {
    const { did, fake } = io()
    const [run] = footerItemsSchema.parse([{ kind: 'run', id: 'copy', label: 'Copy', copy: { plain: 'a\nb', html: '<a href="https://x.test">a</a>' } }])
    const carried = carry(run!, fake)
    /* Synchronously, inside the click. */
    expect(did.copied).toEqual([{ plain: 'a\nb', html: '<a href="https://x.test">a</a>' }])
    expect(await carried).toBe('copy')
  })

  test('a clipboard that refuses carries nothing', async () => {
    const { fake } = io(false)
    expect(await carry({ kind: 'run', copy: { plain: 'x' } }, fake)).toBeNull()
  })

  test('an open is https only: anything else is not handed to the shell', async () => {
    const { did, fake } = io()
    expect(await carry({ kind: 'run', open: 'https://github.com/x/y/pull/1' }, fake)).toBe('open')
    for (const url of ['http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@example.com/']) {
      expect(await carry({ kind: 'run', open: url }, fake)).toBeNull()
    }
    expect(did.opened).toEqual(['https://github.com/x/y/pull/1'])
  })

  test('a copy over the caps is not written, even if it reached here unparsed', async () => {
    const { did, fake } = io()
    expect(await carry({ kind: 'run', copy: { plain: 'x'.repeat(LIMITS.RUN_COPY_PLAIN + 1) } }, fake)).toBeNull()
    expect(await carry({ kind: 'run', copy: { plain: 'x', html: 'y'.repeat(LIMITS.RUN_COPY_HTML + 1) } }, fake)).toBeNull()
    expect(did.copied).toEqual([])
  })

  test('a run that asks nothing, and any other kind, carries nothing and touches nothing', async () => {
    const { did, fake } = io()
    const items = headerItemsSchema.parse([
      { kind: 'run', id: 'r', label: 'R' },
      { kind: 'toggle', id: 't', label: 'T', checked: false },
    ])
    for (const item of items) expect(await carry(item, fake)).toBeNull()
    expect(did).toEqual({ copied: [], opened: [] })
  })
})

describe('the press follows, saying what was carried', () => {
  test('footerPressing hands the module the press with carried and place', async () => {
    const sent: unknown[] = []
    const items = footerItemsSchema.parse([{ kind: 'run', id: 'copy', label: 'Copy', copy: { plain: 'a' } }])
    const { fake } = io()
    const carried = await carry(items[0]!, fake)
    await footerPressing(items, { item: 'copy', ...(carried ? { carried } : {}) }, 'References', (press) => {
      sent.push(press)
      return Promise.resolve({ ok: true, why: '' })
    })
    expect(sent).toEqual([{ item: 'copy', carried: 'copy', place: 'footer' }])
  })
})
