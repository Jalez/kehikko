import { describe, expect, test } from 'bun:test'
import { MESSAGE, PROTOCOL, dropSchema, type FileDrag, type PagePoint } from 'kehikot-module-protocol'

import { Conversation, type Answer } from '@/host/conversation.ts'
import { toWireContext } from '@/host/context.ts'
import { handOnDrop, type DropFrame } from '@/host/drops.ts'
import { Presses } from '@/host/presses.ts'

/**
 * A file dragged out of one module's page and let go over another's (protocol 2.94.0): WebKit tells
 * the other page nothing, so the host hands the drop on to the frame under the point.
 */

const file: FileDrag = { project: '/work/p', path: 'src/a.ts', kind: 'file' }

function frames() {
  const dropped: { id: string; file: FileDrag; at: PagePoint }[] = []
  const make = (id: string, left: number, opensFiles: boolean): DropFrame => ({
    id,
    element: { id },
    box: () => ({ left, top: 40, width: 400, height: 300 }),
    opensFiles,
    drop: (one, at) => void dropped.push({ id, file: one, at }),
  })
  const list = [make('tree', 0, false), make('editor', 500, true), make('viewer', 1000, false)]
  /* What is under a point: the frame whose box holds it. */
  const under = (x: number, y: number) => {
    const hit = list.find((one) => {
      const box = one.box()!
      return x >= box.left && x <= box.left + box.width && y >= box.top && y <= box.top + box.height
    })
    return hit ? hit.element : null
  }
  return { list, under, dropped }
}

describe('a drop handed on', () => {
  test('to the frame under the point, in its own coordinates, when its module opens files', () => {
    const { list, under, dropped } = frames()
    /* Let go at x 620 in the tree's page: 620 on the page, 120 into the editor's frame. */
    expect(handOnDrop('tree', { phase: 'end', file, at: { x: 620, y: 60 }, dropped: false }, list, under)).toBe('editor')
    expect(dropped).toEqual([{ id: 'editor', file, at: { x: 120, y: 60 } }])
  })

  test('not when something took it already, at the start, without a point, or back on its own frame', () => {
    const { list, under, dropped } = frames()
    expect(handOnDrop('tree', { phase: 'end', file, at: { x: 620, y: 60 }, dropped: true }, list, under)).toBeNull()
    expect(handOnDrop('tree', { phase: 'start', file, dropped: false }, list, under)).toBeNull()
    expect(handOnDrop('tree', { phase: 'end', file, dropped: false }, list, under)).toBeNull()
    expect(handOnDrop('tree', { phase: 'end', file, at: { x: 100, y: 60 }, dropped: false }, list, under)).toBeNull()
    expect(dropped).toEqual([])
  })

  test('not to a module that does not open files, nor where no frame is', () => {
    const { list, under, dropped } = frames()
    expect(handOnDrop('tree', { phase: 'end', file, at: { x: 1100, y: 60 }, dropped: false }, list, under)).toBeNull()
    expect(handOnDrop('tree', { phase: 'end', file, at: { x: 450, y: 60 }, dropped: false }, list, under)).toBeNull()
    expect(handOnDrop('gone', { phase: 'end', file, at: { x: 620, y: 60 }, dropped: false }, list, under)).toBeNull()
    expect(dropped).toEqual([])
  })

  test('the register lists the frames that can take one', () => {
    const presses = new Presses()
    const base = { clear() {}, refresh() {}, walk: async () => ({ found: false, why: '' }), item: async () => ({ ok: true, why: '' }), focus() {} }
    presses.join('a', { ...base, dropFrame: { element: 1, box: () => null, opensFiles: true, drop() {} } })
    presses.join('b', base as never)
    expect(presses.dropFrames().map((one) => one.id)).toEqual(['a'])
  })
})

describe('the wire (kehikot.drag in, kehikot.drop out)', () => {
  function frame() {
    const sent: Record<string, unknown>[] = []
    const contentWindow = { postMessage: (message: unknown) => void sent.push(message as Record<string, unknown>) } as unknown as Window
    const drags: unknown[] = []
    const watcher = {
      ready() {}, silent() {}, fault() {}, height() {}, filters() {}, clearable() {}, refreshable() {}, header() {},
      drag: (drag: unknown) => void drags.push(drag),
    }
    const nothing: Answer = { ok: true, data: null }
    const conversation = new Conversation({ contentWindow }, 'kehikot.example', null, async () => nothing, watcher, { name: 'Example' })
    const say = (data: unknown) => conversation.receive({ source: contentWindow, origin: 'null', data })
    return { conversation, sent, say, drags }
  }
  const context = toWireContext({ epic: null, project: null }, 'dark')

  test('a drag the page tells of reaches the watcher as parsed; a forged path does not', () => {
    const { conversation, say, drags } = frame()
    conversation.greet(context)
    say({ type: MESSAGE.READY, id: 'kehikot.example', protocol: PROTOCOL })
    say({ type: MESSAGE.DRAG, phase: 'end', file, at: { x: 1, y: 2 }, dropped: false })
    say({ type: MESSAGE.DRAG, phase: 'end', file: { project: '/work/p', path: '../../etc/passwd' }, at: { x: 1, y: 2 } })
    expect(drags).toEqual([{ phase: 'end', file, at: { x: 1, y: 2 }, dropped: false }])
    conversation.close()
  })

  test('a drop is posted only to a page that answered its greeting, and parses', () => {
    const { conversation, say, sent } = frame()
    conversation.sendDrop(file, { x: 3, y: 4 })
    expect(sent.filter((one) => one.type === MESSAGE.DROP)).toEqual([])
    conversation.greet(context)
    say({ type: MESSAGE.READY, id: 'kehikot.example', protocol: PROTOCOL })
    conversation.sendDrop(file, { x: 3, y: 4 })
    const drops = sent.filter((one) => one.type === MESSAGE.DROP)
    expect(drops).toEqual([{ type: MESSAGE.DROP, protocol: PROTOCOL, file, at: { x: 3, y: 4 } }])
    expect(dropSchema.safeParse(drops[0]).success).toBe(true)
    conversation.close()
  })
})
