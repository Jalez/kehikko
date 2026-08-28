import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
       * There used to be a second alias here, pointing `roadmap-module-protocol`
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
    proxy: {
      '/host': {
        target: `http://127.0.0.1:${process.env.HOST_PORT ?? 4180}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
