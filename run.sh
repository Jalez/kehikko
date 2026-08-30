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

# ---------------------------------------------------------------------------
# Where the roadmap's own data lives.
#
# `server/holdings.ts` answers `epics.list` out of `$KEHIKKO_ROADMAP_DIR/data/
# epics`, and answers it with an EMPTY LIST when the variable is unset — because
# a host that holds nothing is a real and ordinary state, not an error.
#
# That honesty has a failure mode, and it has now happened: the host was
# restarted by something that did not know this variable existed, `holdingsDir()`
# returned null, and Atlas drew "the host answered: it has no epics yet". Which
# was TRUE. Thirteen epics were sitting on disk the whole time, and every part of
# the system reported correctly — the module said what the host said, and the
# host said what its environment told it. Nothing was broken and nothing could be
# grepped for.
#
# So the default lives here, in the script that starts this host, rather than in
# whoever's shell happens to run it. An explicit `KEHIKKO_ROADMAP_DIR` still
# wins; this only fills in the silence.
#
# Note this is the OPPOSITE of the rule `kehikko-orchestrator/scope.ts` argues
# for, which refuses to default a directory at all — and the difference is what
# the directory is FOR. There, a guessed path is an agent editing the wrong
# repository: a write, and an irreversible one. Here it is a read of a roadmap's
# own epics, where a wrong guess shows the wrong list and a missing guess shows
# no list, and only one of those two announces itself.
if [ -z "${KEHIKKO_ROADMAP_DIR:-}" ] && [ -d "$HOME/Projects/roadmap/data/epics" ]; then
  KEHIKKO_ROADMAP_DIR="$HOME/Projects/roadmap"
fi
export KEHIKKO_ROADMAP_DIR

if [ -n "${KEHIKKO_ROADMAP_DIR:-}" ] && [ -d "$KEHIKKO_ROADMAP_DIR/data/epics" ]; then
  echo "kehikko: epics from $KEHIKKO_ROADMAP_DIR/data/epics" >&2
else
  # Said out loud, at start, in the terminal somebody is looking at — because
  # the alternative is finding out from a module drawing an empty map twenty
  # minutes later and blaming the module.
  echo "kehikko: KEHIKKO_ROADMAP_DIR names no data/epics directory, so epics.list will answer empty and Atlas will draw nothing." >&2
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
