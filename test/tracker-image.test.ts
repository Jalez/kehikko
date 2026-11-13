import { describe, expect, test } from 'bun:test'
import { LIMITS } from 'kehikot-module-protocol'

import { answer } from '../server/answers.ts'
import { fetchTrackerImage, imageHostsOf, sniffImage, type ImageFetch } from '../server/trackers/images.ts'
import { gitlabApprovals } from '../server/trackers/itemDetail.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const SVG = Uint8Array.from(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))

type Seen = { url: string; headers: Record<string, string> }
function io(respond: (url: string) => Response, token: string | null = 'sekret'): ImageFetch & { seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    token: async () => token,
    fetch: async (url, init) => {
      seen.push({ url, headers: init.headers })
      return respond(url)
    },
  }
}
const ok = (body: Uint8Array<ArrayBuffer>, type = 'image/png') => new Response(body, { headers: { 'content-type': type } })
const gitlab = { tracker: 'gitlab', host: 'gitlab.example.org' } as const
const github = { tracker: 'github', host: 'github.com' } as const

describe('tracker.image', () => {
  test('fetches a picture on the item\'s own host with the person\'s token, and answers its bytes', async () => {
    const f = io(() => ok(PNG))
    const got = await fetchTrackerImage(gitlab, 'https://gitlab.example.org/o/r/uploads/abc/shot.png', f)
    expect(got).toEqual({ outcome: 'image', mime: 'image/png', base64: Buffer.from(PNG).toString('base64') })
    expect(f.seen[0]!.headers['private-token']).toBe('sekret')
  })

  test('declines an address on any other host without a request, and never an http one', async () => {
    const f = io(() => ok(PNG))
    for (const url of ['https://evil.example.com/pixel.png', 'http://gitlab.example.org/a.png', 'https://127.0.0.1/a.png', 'https://user:pw@gitlab.example.org/a.png', 'https://gitlab.example.org:8443/a.png', 'nonsense']) {
      expect(await fetchTrackerImage(gitlab, url, f)).toEqual({ outcome: 'declined', why: 'host' })
    }
    expect(f.seen).toEqual([])
  })

  test('github.com upload hosts are allowed, and get no token', async () => {
    expect(imageHostsOf(github)).toContain('private-user-images.githubusercontent.com')
    expect(imageHostsOf(gitlab)).toEqual(['gitlab.example.org'])
    const f = io(() => ok(PNG))
    await fetchTrackerImage(github, 'https://private-user-images.githubusercontent.com/1/a.png?jwt=x', f)
    expect(f.seen[0]!.headers.authorization).toBeUndefined()
    await fetchTrackerImage(github, 'https://github.com/user-attachments/assets/1', f)
    expect(f.seen[1]!.headers.authorization).toBe('Bearer sekret')
  })

  test('a redirect is checked again, and the token does not follow it to another host', async () => {
    const f = io((url) =>
      url.startsWith('https://github.com/')
        ? new Response(null, { status: 302, headers: { location: 'https://private-user-images.githubusercontent.com/1/a.png' } })
        : ok(PNG),
    )
    expect((await fetchTrackerImage(github, 'https://github.com/user-attachments/assets/1', f)).outcome).toBe('image')
    expect(f.seen[1]!.headers.authorization).toBeUndefined()
    const away = io(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x.png' } }))
    expect(await fetchTrackerImage(github, 'https://github.com/user-attachments/assets/1', away)).toEqual({ outcome: 'declined', why: 'host' })
    expect(away.seen).toHaveLength(1)
  })

  test('only png, jpeg, gif, webp and avif, judged by the bytes: an SVG is declined whatever it says it is', async () => {
    expect(await fetchTrackerImage(gitlab, 'https://gitlab.example.org/a.png', io(() => ok(SVG, 'image/png')))).toEqual({ outcome: 'declined', why: 'type' })
    expect(await fetchTrackerImage(gitlab, 'https://gitlab.example.org/a.svg', io(() => ok(SVG, 'image/svg+xml')))).toEqual({ outcome: 'declined', why: 'type' })
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('GIF89a..'))).toBe('image/gif')
    expect(sniffImage(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('image/webp')
  })

  test('more than the size cap is declined, by header or by counting what arrives', async () => {
    const big = new Uint8Array(new ArrayBuffer(LIMITS.TRACKER_IMAGE_BYTES + 1))
    big.set(PNG)
    const said = io(() => new Response(big, { headers: { 'content-type': 'image/png', 'content-length': String(big.length) } }))
    expect(await fetchTrackerImage(gitlab, 'https://gitlab.example.org/a.png', said)).toEqual({ outcome: 'declined', why: 'size' })
    const lied = io(() => ok(big))
    expect(await fetchTrackerImage(gitlab, 'https://gitlab.example.org/a.png', lied)).toEqual({ outcome: 'declined', why: 'size' })
  })

  test('a refusal by the tracker or a network failure is unreadable', async () => {
    expect(await fetchTrackerImage(gitlab, 'https://gitlab.example.org/a.png', io(() => new Response('no', { status: 404 })))).toEqual({ outcome: 'declined', why: 'unreadable' })
    const broken: ImageFetch = { token: async () => null, fetch: async () => { throw new Error('offline') } }
    expect(await fetchTrackerImage(gitlab, 'https://gitlab.example.org/a.png', broken)).toEqual({ outcome: 'declined', why: 'unreadable' })
  })
})

describe('the door', () => {
  test('answers tracker.image through the reading, held to trackers:read', async () => {
    const asked: unknown[] = []
    const door = {
      get: () => ({ refused: 'x' }),
      refresh: async () => ({ outcome: 'declined' as const, at: null, why: '' }),
      live: () => null,
      image: async (root: string, ref: string, url: string) => {
        asked.push([root, ref, url])
        return { outcome: 'declined' as const, why: 'host' as const }
      },
    }
    const params = { ref: 'gl#4', url: 'https://gitlab.example.org/a.png' }
    const got = await (await import('../server/answers.ts')).answerCall('kehikot.workitem', 'tracker.image', params, () => true, () => {}, '/p', () => ({ ok: false, why: '' }) as never, door as never)
    expect(JSON.stringify(got)).toContain('declined')
    expect(asked).toEqual([['/p', 'gl#4', 'https://gitlab.example.org/a.png']])
    expect(typeof answer).toBe('function')
  })
})

describe('approvals', () => {
  test('a GitLab approval rule becomes "given of required"; no rule says nothing', () => {
    expect(gitlabApprovals({ approvals_required: 2, approvals_left: 1 })).toEqual({ approvals: { given: 1, required: 2 } })
    expect(gitlabApprovals({ approvals_required: 0, approvals_left: 0 })).toEqual({})
    expect(gitlabApprovals({})).toEqual({})
  })
})
