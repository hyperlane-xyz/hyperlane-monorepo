#!/usr/bin/env bash
# Print GitHub-output cache keys for the Depot benchmark build.
# Each key hashes only the sources that feed its products, so a Zig-only edit
# keeps the Rust and native-prerequisite caches valid.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-1.98.0}"
RUST_FLAGS="${BENCH_RUSTFLAGS:-}"
ZIG_CPU="${ZIG_CPU:-}"

tree_hash() {
  # Content hash of regular files under the given paths, skipping build output.
  find "$@" -type f \
    -not -path '*/target/*' -not -path '*/target-ci/*' -not -path '*/.zig-cache/*' \
    -not -path '*/zig-out/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' \
    -not -path '*/.cache/*' -not -path '*/.toolchain/*' \
    -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-24
}

# rust/main/config holds agent chain configs, not compiled source; exclude it.
rust_src="$(tree_hash rust/main rust/sealevel -not -path 'rust/main/config/*')"
native_src="$(tree_hash zig/native zig/src/net/native-url zig/tools/native_deps.py zig/tools/fixture_pack.py zig/tools/build_cpu.py)"
tools_src="$(tree_hash zig/reference/Cargo.toml zig/reference/Cargo.lock.gz zig/reference/src zig/reference/evm/Cargo.toml zig/reference/evm/Cargo.lock.gz zig/reference/evm/src rust/main/hyperlane-core)"
zig_src="$(tree_hash zig/src zig/build.zig zig/tools/zig.py zig/tools/bootstrap.py)"
flags="$(printf '%s|%s|%s|%s' "$RUST_TOOLCHAIN" "$RUST_FLAGS" "${BENCH_CFLAGS:-}" "$ZIG_CPU" | sha256sum | cut -c1-12)"

echo "rust=rust-bins-v1-${flags}-${rust_src}"
echo "rust_target=rust-target-v1-${flags}"
echo "native=native-v1-${flags}-${native_src}"
echo "tools=tools-v1-${flags}-${tools_src}"
echo "zig=zig-bins-v1-${flags}-${native_src}-${zig_src}"
echo "zig_cache=zig-cache-v1-${flags}"
