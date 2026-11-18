/*
 * A scratch host's only way out: every `https://` request a process makes goes to the local server
 * named by `KEHIKOT_SHIM_HTTPS` (a drive's fake GitHub), as `<server>/<host>/<path>`. Loaded with
 * `BUN_OPTIONS=--preload=<this file>`, so nothing a scratch host fetches reaches the internet.
 */
const base = process.env.KEHIKOT_SHIM_HTTPS
if (base) {
  const real = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith('https://')) return real(input, init)
    return real(`${base}/${url.slice('https://'.length)}`, init)
  }) as typeof fetch
}
