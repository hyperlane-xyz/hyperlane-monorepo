#!/usr/bin/env bash
# Inside a Depot sandbox: build Zig agents for a pushed worktree, reusing the
# Rust agents, native prerequisites and helpers already built in $REPO/.zb.
#   source /tmp/sandbox-env.sh; bash $REPO/zig/bench/depot/sandbox_build.sh ~/zb/<name>
# Result: <worktree>/.zb/out (rust/ zig-safe/ zig-fast/ lib/ tools/), ready for
#   cd <worktree> && python3 zig/bench/depot/bench.py --workload scraper-safe --pairs 2 --bins .zb/out --output /tmp/<name>-scraper
# Bench harness files are taken from $REPO (current harness), so they need not exist at the pushed rev.
set -euo pipefail
WT="$(cd "$1" && pwd)"
: "${REPO:?source /tmp/sandbox-env.sh first}"
test -x "$REPO/.zb/rust-bin/relayer" || { echo "run: cd \$REPO && bash zig/bench/depot/build.sh (once)"; exit 1; }
mkdir -p "$WT/.zb"
for d in rust-bin native tools; do rm -rf "$WT/.zb/$d"; cp -a "$REPO/.zb/$d" "$WT/.zb/$d"; done
mkdir -p "$WT/zig/bench/depot"
cp -a "$REPO/zig/bench/depot/." "$WT/zig/bench/depot/"
for f in zig/bench/validator.py zig/bench/scraper.py zig/bench/relayer.py zig/integration/evm.py zig/integration/relayer_process.py zig/integration/validator.py; do
  cp -a "$REPO/$f" "$WT/$f"
done
rm -rf "$WT/.zb/zig-bin"
cd "$WT" && RUST_HIT=true NATIVE_HIT=true TOOLS_HIT=true ZIG_HIT= bash zig/bench/depot/build.sh
