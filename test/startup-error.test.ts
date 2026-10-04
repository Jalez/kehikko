import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/* The guard in `index.html` that turns a page which cannot start into a
   message rather than a black canvas. It is an inline script, so it is read
   out of the document and run against a page React never drew into. */
const html = readFileSync(join(import.meta.dir, '..', 'index.html'), 'utf8')
const guard = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]!)
  .find((script) => script.includes('could not start'))!

function page() {
  const win = new Window()
  win.document.body.innerHTML = '<div id="root"></div>'
  win.eval(guard)
  return win
}

test('an error before anything is drawn is written into the page', () => {
  const win = page()
  win.dispatchEvent(
    new win.ErrorEvent('error', { message: "The requested module does not provide an export named 'dispositionSchema'" }),
  )
  const text = win.document.getElementById('root')!.textContent!
  expect(text).toContain('Kehikot could not start.')
  expect(text).toContain('dispositionSchema')
  expect(text).toContain('bun install')
})

test('once something is drawn, a later error leaves the page alone', () => {
  const win = page()
  win.document.getElementById('root')!.innerHTML = '<main>the canvas</main>'
  win.dispatchEvent(new win.ErrorEvent('error', { message: 'later' }))
  expect(win.document.getElementById('root')!.textContent).toBe('the canvas')
})
