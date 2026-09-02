import { describe, expect, test } from 'bun:test'

import { Wakes, type News } from '../server/wake.ts'

/**
 * The one stream a page listens on, and the two things it may carry.
 *
 * Both of these exist for the same reason and it is worth stating once: the
 * moment worth catching is a person SITTING STILL and WATCHING while something
 * changes underneath them. Nothing they do fires an event, so nothing the page
 * ties to attention can help, and the alternative — asking on a timer — is the
 * request-per-tick this host refuses everywhere else. So the half that can
 * notice says so, over a socket that is already open.
 *
 * What is tested here is the cargo and the fan-out, because those are what the
 * page parses and what a browser closing has to be survivable by. Who decides
 * to send a `registry` is `watch` in `server.ts`; when, is `WATCH_EVERY_MS`.
 */
describe('what travels on the wake stream', () => {
  const heard = (): { news: News[]; wakes: Wakes } => {
    const wakes = new Wakes()
    const news: News[] = []
    wakes.listen((one) => news.push(one))
    return { news, wakes }
  }

  test('a changed kehikko is an id and nothing else', () => {
    const { news, wakes } = heard()
    wakes.woke(7)
    expect(news).toEqual([{ kehikko: 7 }])
  })

  test('a changed registry is not even an id', () => {
    /* Deliberately carries no module, no condition and no line. The page has a
       perfectly good way to read all three, and a stream that shipped them
       would be a second, older one — see the essay in `wake.ts`. */
    const { news, wakes } = heard()
    wakes.registryChanged()
    expect(news).toEqual([{ registry: true }])
  })

  test('the two are distinguishable without asking what kind a message is', () => {
    /* The page reads whichever key it understands and ignores the rest, so a
       message must never carry both — that is what would let one wake be
       processed twice. */
    const { news, wakes } = heard()
    wakes.woke(3)
    wakes.registryChanged()
    wakes.epicsChanged(5)
    expect(news.map((one) => Object.keys(one))).toEqual([['kehikko'], ['registry'], ['epics']])
  })

  test('a project whose epics changed is the project’s id and nothing else', () => {
    /* Not the epic, not its title, not the file: the page has `/host/epics`
       for those. The id is carried — unlike `registry` — because two windows
       can stand in two projects and only the one this is about should read. */
    const { news, wakes } = heard()
    wakes.epicsChanged(5)
    expect(news).toEqual([{ epics: 5 }])
  })

  test('one closed stream does not swallow the news for a live one', () => {
    /* A write into a socket a browser has already dropped throws, and there is
       always another tab. This is the same guarantee `woke` had; the point of
       the test is that routing both kinds through one `#tell` did not lose it. */
    const wakes = new Wakes()
    const alive: News[] = []
    wakes.listen(() => {
      throw new Error('this stream is gone')
    })
    wakes.listen((one) => alive.push(one))
    wakes.registryChanged()
    wakes.woke(2)
    expect(alive).toEqual([{ registry: true }, { kehikko: 2 }])
  })

  test('a listener that has stopped hears nothing more', () => {
    const wakes = new Wakes()
    const news: News[] = []
    const stop = wakes.listen((one) => news.push(one))
    wakes.registryChanged()
    stop()
    wakes.registryChanged()
    expect(news).toHaveLength(1)
    expect(wakes.watching).toBe(0)
  })
})
