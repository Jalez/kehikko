import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * A proxied answer that the API stopped in the middle ends for the page too.
 *
 * Vite's proxy does not pass that on. When the API process goes away while a
 * response is still streaming — `/host/watch`, which streams for as long as
 * the page is open — the proxy keeps its half to the page open, and the page
 * goes on holding a stream nothing will ever write to again. `EventSource`
 * reconnects only when it sees its connection end, so it never reconnected:
 * after the API restarted, the page never said again which kehikko it had
 * open, and the host's MCP door answered that no page had said so until
 * somebody reloaded. The compiled host serves the page itself, with no proxy,
 * and its streams already end when it does.
 *
 * `complete` is false only for an answer that ended before all of it arrived,
 * so an ordinary answer is left to finish the ordinary way.
 */
export function endWithUpstream(
  upstream: { complete: boolean; on(event: 'close', listener: () => void): unknown },
  _request: unknown,
  response: { writableEnded: boolean; destroy(): void },
): void {
  upstream.on('close', () => {
    if (!upstream.complete && !response.writableEnded) response.destroy()
  })
}

/**
 * The build, and the one interesting line in it.
 *
 * `server.proxy` sends everything under `/host/` to the small server beside
 * this one. Vite serves the page and the API is its own process — see `run.sh`
 * for why there is no build and no `dist` any more — and the proxy is what
 * keeps that arrangement invisible to the page: it fetches `/host/modules` from
 * its own origin and never learns there are two ports.
 *
 * `HOST_PORT` is set by `run.sh` and must be the API's port. It used to agree
 * with `PORT` only by coincidence, both defaulting to 4180, which meant a
 * second host started on another port proxied its calls to the FIRST host's
 * server — reading a registry and a set of canvases belonging to a process it
 * had nothing to do with, with nothing failing anywhere.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      /*
       * There used to be a second alias here, pointing `kehikot-module-protocol`
       * at that package's source in the same repository. It is gone, and its
       * absence is the point: the protocol is now a repository of its own and an
       * ordinary dependency, resolved the way every other dependency is.
       *
       * It existed because the package's `exports` pointed at a `dist/` that was
       * gitignored and never built, so every consumer had to reach past the
       * package's own entry point to find anything at all. That is fixed at the
       * source — see PACKAGING.md in the protocol repository — and reaching past
       * it would now mean this host and its contract could disagree about which
       * copy is real.
       */
    },
  },
  server: {
    /* The page is fetched by itself and by nothing else, so this server says
       nothing about who else may read it. Vite's default would add
       `Access-Control-Allow-Origin` for any loopback origin — to the page and
       to every `/host/*` answer it proxies. The compiled host never sends one. */
    cors: false,
    proxy: {
      '/host': {
        target: `http://127.0.0.1:${process.env.HOST_PORT ?? 4180}`,
        changeOrigin: false,
        configure: (proxy) => proxy.on('proxyRes', endWithUpstream),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
