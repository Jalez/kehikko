#!/usr/bin/env sh
#
# Start the host: its small server, and Vite serving the page beside it.
#
# No arguments. `PORT` from the environment, or 4180. `exec` so the process that
# ends up serving is the process whoever started this is holding — a script that
# forked and returned would leave them with a pid that stops nothing.
#
# ## Why there is no build here any more, and no `dist`
#
# There used to be. The page was built once into `dist/` and the small server
# served it off disk, with a guard that skipped the build when `dist` already
# existed. That is the shape of a deployment, and this program is not deployed:
# it runs on the machine of the person editing it.
#
# What the deployment shape actually bought us was a stale page. `dist` existed,
# so the build was skipped, so the server answered 200 with the previous
# bundle — every symptom of a working system and none of the changes. It cost an
# hour twice before anybody suspected the build rather than the code.
#
# So Vite serves the page, as Vite is for: no build step, no artifact in the
# tree, an edit visible on save. `vite.config.ts` already proxies `/host` to the
# small server, so the page talks to one origin either way and nothing about the
# arrangement changes when it is not being edited.
set -eu
cd "$(dirname "$0")"

PORT="${PORT:-4180}"
export PORT

# The port Vite proxies `/host` to, which is this API's.
#
# It is exported separately because `vite.config.ts` reads this name, and until
# it was exported the two agreed only by coincidence: the config fell back to
# 4180, `PORT` defaulted to 4180, and everything worked until somebody ran a
# second host on another port — at which point that page proxied its calls to
# the FIRST host's server and read a registry and a set of canvases belonging to
# a process it had nothing to do with. Nothing failed; the answers were just
# somebody else's.
HOST_PORT="$PORT"
export HOST_PORT

if [ ! -d node_modules ]; then
  echo "installing…" >&2
  bun install >&2
fi

# The API first, in the background, because Vite's proxy has nowhere to send
# `/host` until it is up. Stopping this script stops both: the trap fires on the
# way out however we leave, so a Ctrl-C does not leave an orphan holding 4180 —
# which is its own afternoon of "address already in use" for anybody who has met
# it once.
bun run server/server.ts &
API=$!
trap 'kill $API 2>/dev/null || true' EXIT INT TERM

exec bunx vite --host 127.0.0.1 --port "$((PORT + 1))" --strictPort
