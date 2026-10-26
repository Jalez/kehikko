# Shared by `dev/bee-setup.sh` and `dev/bee-browser-tests.sh`: where bee is and
# what is pinned. Sourced, not run.
#
# bee is our own Windows machine with an Ubuntu in WSL. Everything this repo
# puts there lives under `~/kehikko-ci/` of the WSL user: its own bun, its own
# Playwright browsers, its own bun cache and one directory per run. Nothing else
# in that home is read or written — the same user runs another project's
# GitHub Actions runner, its `~/.bun` and its `~/.cache/ms-playwright`.

BEE_SSH="${BEE_SSH:-bee}"
BEE_DISTRO="${BEE_DISTRO:-Ubuntu-24.04}"

# The bun this repo is developed and released with.
BUN_VERSION="1.4.0"

# The Playwright the drives import (`playwright-core` in package.json); its
# browsers are the ones installed.
playwright_version() {
  sed -n 's/.*"playwright-core": *"\([0-9][0-9.]*\)".*/\1/p' "$1/package.json"
}

# Run the script on stdin in bee's Ubuntu, streaming its output back. The exit
# status is the script's.
on_bee() {
  ssh -o BatchMode=yes -o ServerAliveInterval=30 "$BEE_SSH" "wsl -d $BEE_DISTRO -- bash -s"
}

# The lines every script on bee starts with: its own corner of the home, and
# the pinned bun and browsers on the path.
bee_preamble() {
  cat <<'EOF'
set -euo pipefail
CI="$HOME/kehikko-ci"
mkdir -p "$CI/tmp" "$CI/runs"
export BUN_INSTALL="$CI/bun"
export BUN_INSTALL_CACHE_DIR="$CI/bun-cache"
export PLAYWRIGHT_BROWSERS_PATH="$CI/ms-playwright"
# Where scratch hosts claim their ports (`dev/scratch-host.mjs`): one place for every run at once.
export KEHIKOT_SCRATCH_PORTS="$CI/ports"
export PATH="$BUN_INSTALL/bin:$PATH"
# WSLg hands every session a display (DISPLAY, WAYLAND_DISPLAY) backed by the
# Windows GPU. A headless Chromium that sees it stops painting for seconds to
# over a minute at a time — no animation frame, so no screenshot and no
# "stable" element — and every drive times out somewhere different. Headless
# browsers need no display; without one they paint at 60 frames a second.
unset DISPLAY WAYLAND_DISPLAY
# The host's protocol package is a `git+ssh` dependency; bee has no GitHub key,
# and the repositories are public, so git reads them over https. Only for the
# processes started here (no `~/.gitconfig` is written).
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf' GIT_CONFIG_VALUE_0='git@github.com:'
export GIT_CONFIG_KEY_1='url.https://github.com/.insteadOf' GIT_CONFIG_VALUE_1='ssh://git@github.com/'
EOF
}
