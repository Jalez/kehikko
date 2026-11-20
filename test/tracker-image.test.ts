import { describe, expect, test } from 'bun:test'
import { LIMITS } from 'kehikot-module-protocol'

import { answer } from '../server/answers.ts'
import { fetchTrackerImage as traced, gitlabUpload, githubAttachment, imageHostsOf, shownAddress, signedAttachment, sniffImage, type CliBytes, type ImageFetch } from '../server/trackers/images.ts'
import { Trackers } from '../server/trackers/reading.ts'
import { GITHUB, GITLAB, PNG_START } from './fixtures/tracker-images.ts'

/** The answer alone, as the module gets it. */
const fetchTrackerImage = async (...a: Parameters<typeof traced>) => (await traced(...a)).image
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
const gitlab = { tracker: 'gitlab', host: 'gitlab.example.org', repo: 'o/r', number: 4 } as const
const github = { tracker: 'github', host: 'github.com', repo: 'o/r', number: 1 } as const

describe('tracker.image', () => {
  test('fetches a picture on the item\'s own host with the person\'s token, and answers its bytes', async () => {
    const f = io(() => ok(PNG))
    const got = await fetchTrackerImage(gitlab, 'https://gitlab.example.org/o/r/uploads/abc/shot.png', f)
    expect(got).toEqual({ outcome: 'image', mime: 'image/png', base64: Buffer.from(PNG).toString('base64') })
    expect(f.seen[0]!.headers.authorization).toBe('Bearer sekret')
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
    const got = await (await import('../server/answers.ts')).answerCall('kehikot.workitem', 'tracker.image', params, { knownModule: () => true, keep: () => {}, root: '/p', mark: () => ({ ok: false, why: '' }) as never, trackers: door as never })
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

/* What the live trackers answer (`fixtures/tracker-images.ts`), one cause each of pictures not showing. */
describe('real tracker shapes', () => {
  const realPng = () => {
    const out = new Uint8Array(new ArrayBuffer(64))
    out.set(PNG_START)
    return out
  }
  const glRow = { tracker: 'gitlab', host: GITLAB.host, repo: GITLAB.repo, number: 4387 } as const
  const ghRow = { tracker: 'github', host: GITHUB.host, repo: GITHUB.repo, number: GITHUB.number } as const

  test('a GitHub attachment redirects to GitHub\'s own bucket, which is an upload host and gets no token', async () => {
    for (const address of [GITHUB.attachment, GITHUB.repoAsset]) {
      const f = io((url) =>
        url.startsWith('https://github.com/') ? new Response(null, { status: 302, headers: { location: GITHUB.attachmentAnswer.location } }) : ok(realPng(), 'image/png'),
      )
      const got = await traced(ghRow, address, f)
      expect(got.image.outcome).toBe('image')
      expect(f.seen.map((s) => new URL(s.url).hostname)).toEqual(['github.com', 'github-production-user-asset-6210df.s3.amazonaws.com'])
      expect(f.seen[1]!.headers.authorization).toBeUndefined()
    }
    expect(imageHostsOf(ghRow)).not.toContain('s3.amazonaws.com')
  })

  test('a private repository\'s attachment is read from the signed address in the item\'s rendered text', async () => {
    const f = io((url) => (url.startsWith('https://github.com/') ? new Response('Not Found', { status: 404 }) : ok(realPng())))
    const asked: unknown[] = []
    f.githubHtml = async (host, repo, number) => {
      asked.push([host, repo, number])
      return ['<p>no picture here</p>', GITHUB.bodyHtml]
    }
    const got = await traced(ghRow, GITHUB.attachment, f)
    expect(got.image.outcome).toBe('image')
    expect(asked).toEqual([['github.com', 'oven-sh/bun', 48938]])
    const signed = f.seen[1]!
    expect(signed.url).toContain('private-user-images.githubusercontent.com/61796351/706362396-82a87b90')
    expect(signed.url).toContain('jwt=eyJ0eXAi.x.y&v=1')
    expect(signed.headers.authorization).toBeUndefined()
    expect(githubAttachment(ghRow, new URL('https://github.com/o/r/issues/1'))).toBeNull()
    expect(signedAttachment([GITHUB.bodyHtml], '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  test('a GitHub attachment that is too big is not looked for again', async () => {
    const big = new Uint8Array(new ArrayBuffer(LIMITS.TRACKER_IMAGE_BYTES + 1))
    const f = io(() => ok(big))
    let asked = 0
    f.githubHtml = async () => {
      asked++
      return []
    }
    expect((await traced(ghRow, GITHUB.attachment, f)).image).toEqual({ outcome: 'declined', why: 'size' })
    expect(asked).toBe(0)
  })

  test('a GitLab upload in every written form is read through the API, never the web route', async () => {
    const cases: Array<[string, string]> = [
      [GITLAB.atRoot, GITLAB.api],
      [GITLAB.inProject, GITLAB.api],
      [GITLAB.byId, GITLAB.apiById],
      ['https://gitlab.com/-/group/9970/uploads/0123456789abcdef0123456789abcdef/a.png', 'groups/9970/uploads/0123456789abcdef0123456789abcdef/a.png'],
      ['https://gitlab.com/a/b/c/uploads/0123456789abcdef0123456789abcdef/x%20y.png', 'projects/a%2Fb%2Fc/uploads/0123456789abcdef0123456789abcdef/x%20y.png'],
    ]
    for (const [address, api] of cases) {
      const f = io(() => {
        throw new Error('the web route was asked')
      })
      const paths: string[] = []
      f.gitlabApi = async (host, path) => {
        paths.push(`${host} ${path}`)
        return { bytes: realPng() }
      }
      const got = await traced(glRow, address, f)
      expect(got.image.outcome).toBe('image')
      expect(paths).toEqual([`gitlab.com ${api}`])
      expect(f.seen).toEqual([])
    }
    expect(gitlabUpload(glRow, new URL('https://gitlab.com/gitlab-org/cli/-/raw/main/a.png'))).toBeNull()
    expect(gitlabUpload(glRow, new URL('https://elsewhere.example/uploads/0123456789abcdef0123456789abcdef/a.png'))).toBeNull()
  })

  test('an older GitLab without the uploads route gets the web address, a public project\'s answer', async () => {
    const f = io(() => ok(realPng(), 'image/png'))
    f.gitlabApi = async (): Promise<CliBytes> => ({ failed: GITLAB.glabNotFound.err, notFound: true })
    const got = await traced(glRow, GITLAB.atRoot, f)
    expect(got.image.outcome).toBe('image')
    expect(f.seen.map((s) => s.url)).toEqual([GITLAB.inProject])
  })

  test('the API refusing, or too much, is said with why', async () => {
    const f = io(() => ok(realPng()))
    f.gitlabApi = async (): Promise<CliBytes> => ({ failed: 'glab: 401 Unauthorized (HTTP 401)' })
    const refused = await traced(glRow, GITLAB.byId, f)
    expect(refused.image).toEqual({ outcome: 'declined', why: 'unreadable' })
    expect(refused.said).toContain('401 Unauthorized')
    f.gitlabApi = async (): Promise<CliBytes> => ({ tooBig: true })
    expect((await traced(glRow, GITLAB.byId, f)).image).toEqual({ outcome: 'declined', why: 'size' })
    expect(f.seen).toEqual([])
  })

  test('the sign-in page a web route answers is declined as not a picture, and said so', async () => {
    const f = io((url) =>
      url === GITLAB.atRoot
        ? new Response(null, { status: 302, headers: { location: GITLAB.atRootAnswer.location } })
        : new Response('<html><body>You are being redirected', { headers: { 'content-type': 'text/html' } }),
    )
    const got = await traced({ ...glRow }, 'https://gitlab.com/-/raw/a.png', f)
    expect(got.image.outcome).toBe('declined')
    const page = await traced({ ...glRow }, GITLAB.atRoot, { ...f, gitlabApi: undefined })
    expect(page.image).toEqual({ outcome: 'declined', why: 'type' })
    expect(page.said).toContain('<html>')
  })

  test('the reasons say no query: a signature never reaches the log', () => {
    expect(shownAddress(GITHUB.attachmentAnswer.location)).toBe('https://github-production-user-asset-6210df.s3.amazonaws.com/61796351/706362396-82a87b90-18b3-493d-be0e-b84b3eb83d55.png')
  })

  test('real image starts: a PNG, an Exif JPEG, an AVIF sequence', () => {
    expect(sniffImage(PNG_START)).toBe('image/png')
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 0, 0x45, 0x78, 0x69, 0x66]))).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('\0\0\0\x20ftypavis'))).toBe('image/avif')
  })
})

describe('the log', () => {
  test('every decline is said in host.log with its reason, and nothing with a query', async () => {
    const lines: string[] = []
    const row = { ref: '!4387', tracker: 'gitlab', host: GITLAB.host, repo: GITLAB.repo, number: 4387 }
    class Held extends Trackers {
      override rowsHeld() {
        return [row] as never
      }
    }
    const trackers = new Held({
      run: async () => ({ code: 1, out: '', err: '' }),
      log: (line) => lines.push(line),
      images: {
        token: async () => null,
        fetch: async () => new Response('no', { status: 403 }),
        gitlabApi: async () => ({ failed: 'glab: 403 Forbidden (HTTP 403)' }),
      },
    })
    expect(await trackers.image('/nowhere', '!4387', `${GITLAB.byId}?sig=secret`)).toEqual({ outcome: 'declined', why: 'unreadable' })
    expect(await trackers.image('/nowhere', '!4387', 'https://evil.example.com/p.png?who=me')).toEqual({ outcome: 'declined', why: 'host' })
    expect(await new Trackers({ run: async () => ({ code: 1, out: '', err: '' }), log: (l) => lines.push(l) }).image('/nowhere', 'gh#1', 'https://github.com/a.png')).toEqual({ outcome: 'declined', why: 'host' })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('declined (unreadable) for !4387')
    expect(lines[0]).toContain('403 Forbidden')
    expect(lines[1]).toContain('evil.example.com/p.png is not on gitlab.com')
    expect(lines[2]).toContain('does not hold gh#1')
    expect(lines.join('\n')).not.toContain('secret')
    expect(lines.join('\n')).not.toContain('who=me')
  })
})

describe('bytes from a CLI', () => {
  test('stdout is kept as bytes, and stopped past the limit', async () => {
    const { spawnBytes } = await import('../server/feedback.ts')
    const ran = await spawnBytes(['/bin/sh', '-c', 'printf "\\211PNG\\r\\n\\032\\n"'], 100)
    expect(ran.code).toBe(0)
    expect(sniffImage(ran.bytes)).toBe('image/png')
    const big = await spawnBytes(['/bin/sh', '-c', 'head -c 5000 /dev/zero'], 100)
    expect(big.tooBig).toBe(true)
    expect(big.bytes.byteLength).toBe(0)
  })
})
