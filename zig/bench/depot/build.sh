#!/usr/bin/env bash
# Build Rust and Zig agents plus correctness helpers for the Depot paired bench.
#
# Products land in .zb/out (uploaded as one artifact):
#   rust/{relayer,validator,scraper,init-db}
#   zig-safe/{relayer,validator,scraper}  zig-fast/{relayer,validator,scraper}
#   lib/libziggy_url.so  tools/{ziggy-rust-reference,ziggy-evm-oracle}
# Each stage is skipped when its cache restored the finished products
# (RUST_HIT / NATIVE_HIT / TOOLS_HIT / ZIG_HIT = "true").
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
REPO="$PWD"
ZB="$REPO/.zb"
JOBS="${BUILD_JOBS:-$(nproc)}"
RUST_TOOLCHAIN="${RUST_TOOLCHAIN:-1.98.0}"
ZIG_CPU="${ZIG_CPU:-x86_64_v3+pclmul}"
NATIVE_PROFILE="${NATIVE_PROFILE:-x86_64_v3_pclmul_native_abi}"
GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD)}"
mkdir -p "$ZB"/{rust-bin,native,tools,zig-bin,out}

stamp() { printf '\n=== %s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
timed() { local t0=$SECONDS; "$@"; echo "[timing] $1 ... $((SECONDS - t0))s" >&2; }

stamp "restore packed Cargo locks"
python3 zig/tools/fixture_pack.py restore-locks

# ---------------------------------------------------------------- Rust agents
if [[ "${RUST_HIT:-}" != "true" ]]; then
  stamp "build Rust agents (toolchain $RUST_TOOLCHAIN, RUSTFLAGS=$BENCH_RUSTFLAGS)"
  (
    cd rust/main
    export RUSTFLAGS="$BENCH_RUSTFLAGS" CARGO_INCREMENTAL=0 CARGO_TERM_COLOR=never
    export CFLAGS="${BENCH_CFLAGS:-}" CXXFLAGS="${BENCH_CFLAGS:-}"
    timed cargo "+$RUST_TOOLCHAIN" build --locked --release -j "$JOBS" \
      -p relayer -p validator -p scraper --features relayer/aleo,validator/aleo,scraper/aleo
    timed cargo "+$RUST_TOOLCHAIN" build --locked --release -j "$JOBS" -p migration --bin init-db
  )
  for b in relayer validator scraper init-db; do
    install -m 0755 "rust/main/target/release/$b" "$ZB/rust-bin/$b"
  done
else
  stamp "Rust agents restored from cache"
fi

# ------------------------------------------------- native prerequisites (Zig)
if [[ "${NATIVE_HIT:-}" != "true" ]]; then
  stamp "build native URL helper"
  timed python3 zig/src/net/native-url/locked.py --toolchain "$RUST_TOOLCHAIN"
  install -m 0755 zig/src/net/native-url/target/release/libziggy_url.so "$ZB/native/libziggy_url.so"
  stamp "build RocksDB archives"
  python3 zig/tools/native_deps.py --restore-only
  cargo "+$RUST_TOOLCHAIN" fetch --locked --manifest-path zig/native/rocks/Cargo.toml
  rm -rf "$ZB/native/deps"
  timed python3 zig/tools/native_deps.py --cpu-profile "$NATIVE_PROFILE" --git-sha "$GIT_SHA" --offline \
    --jobs "$JOBS" --target-dir zig/native/rocks/target-ci --output "$ZB/native/deps" --format json \
    > "$ZB/native/bootstrap.json"
else
  stamp "native prerequisites restored from cache"
fi

# ---------------------------------------------------- correctness helpers
if [[ "${TOOLS_HIT:-}" != "true" ]]; then
  stamp "build validator correctness helpers"
  timed cargo "+$RUST_TOOLCHAIN" build --locked --release -j "$JOBS" --manifest-path zig/reference/Cargo.toml \
    --bin ziggy-rust-reference --target-dir "$ZB/tools-target"
  timed cargo "+$RUST_TOOLCHAIN" build --locked --release -j "$JOBS" --manifest-path zig/reference/evm/Cargo.toml \
    --target-dir "$ZB/tools-target"
  install -m 0755 "$ZB/tools-target/release/ziggy-rust-reference" "$ZB/tools/ziggy-rust-reference"
  install -m 0755 "$ZB/tools-target/release/ziggy-evm-oracle" "$ZB/tools/ziggy-evm-oracle"
  rm -rf "$ZB/tools-target"
else
  stamp "correctness helpers restored from cache"
fi

# ----------------------------------------------------------------- Zig agents
if [[ "${ZIG_HIT:-}" != "true" ]]; then
  ZIG="$(python3 zig/tools/bootstrap.py)"
  export ZIG
  LIBS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["native_db_libs"])' "$ZB/native/deps/manifest.json")"
  LIBPQ="$(readlink -f "$(pkg-config --variable=libdir libpq)/libpq.so.5")"
  GNU_UNWIND="$(readlink -f "$(c++ -print-file-name=libgcc_s.so.1)")"
  LIBS="$LIBS,$GNU_UNWIND"
  for mode in ReleaseSafe ReleaseFast; do
    case "$mode" in ReleaseSafe) dir=zig-safe ;; ReleaseFast) dir=zig-fast ;; esac
    stamp "build Zig agents $mode"
    (
      cd zig
      timed python3 tools/zig.py build -Dtarget=native "-Dcpu=$ZIG_CPU" -j"$JOBS" relayer validator scraper \
        "-Doptimize=$mode" "-Dgit-sha=$GIT_SHA" "-Dnative-db-libs=$LIBS" "-Dlibpq-library=$LIBPQ" \
        --prefix "$ZB/zig-prefix-$dir" --summary new
    )
    mkdir -p "$ZB/zig-bin/$dir"
    for b in relayer validator scraper; do
      install -m 0755 "$ZB/zig-prefix-$dir/bin/$b" "$ZB/zig-bin/$dir/$b"
    done
  done
else
  stamp "Zig agents restored from cache"
fi

# ------------------------------------------------------------------ assemble
stamp "assemble artifact"
rm -rf "$ZB/out" && mkdir -p "$ZB/out"/{rust,zig-safe,zig-fast,lib,tools}
cp -a "$ZB/rust-bin/." "$ZB/out/rust/"
cp -a "$ZB/zig-bin/zig-safe/." "$ZB/out/zig-safe/"
cp -a "$ZB/zig-bin/zig-fast/." "$ZB/out/zig-fast/"
cp -a "$ZB/native/libziggy_url.so" "$ZB/out/lib/"
cp -a "$ZB/tools/." "$ZB/out/tools/"
python3 - "$ZB/out" "$GIT_SHA" <<'PY'
import hashlib, json, os, pathlib, subprocess, sys
out = pathlib.Path(sys.argv[1])
files = {}
for p in sorted(out.rglob('*')):
    if p.is_file() and p.name != 'build-manifest.json':
        files[str(p.relative_to(out))] = {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
def cmd(*a):
    try: return subprocess.run(a, capture_output=True, text=True, timeout=30).stdout.strip()
    except OSError: return None
manifest = {
    'git_sha': sys.argv[2],
    # Depot applies unpushed local changes as a working-tree patch on top of git_sha.
    'worktree_diff_sha256': cmd('sh', '-c', 'git diff HEAD | sha256sum | cut -d" " -f1'),
    'worktree_diff_stat': cmd('sh', '-c', 'git diff HEAD --shortstat'),
    'rustflags': os.environ.get('BENCH_RUSTFLAGS'),
    'rust_cflags': os.environ.get('BENCH_CFLAGS'),
    'rust_toolchain': os.environ.get('RUST_TOOLCHAIN', '1.98.0'),
    'zig_cpu': os.environ.get('ZIG_CPU', 'x86_64_v3+pclmul'),
    'rust_features': 'relayer/aleo,validator/aleo,scraper/aleo',
    'cache_hits': {k: os.environ.get(k) for k in ['RUST_HIT', 'NATIVE_HIT', 'TOOLS_HIT', 'ZIG_HIT']},
    'build_host': {'uname': cmd('uname', '-a'), 'cpu': cmd('sh', '-c', "lscpu | grep 'Model name'")},
    'files': files,
}
(out / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest, indent=2))
PY
du -sh "$ZB/out"/*
