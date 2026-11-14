#!/usr/bin/env bash
# Builds the native scraper proxy with the pinned Zig 0.15.2 compiler.
# Modes: exe ReleaseFast, test steps Debug by default; -Drelease=true makes
# both ReleaseFast; -Doptimize=<mode> sets both.
set -euo pipefail
cd "$(dirname "$0")"
zig_compiler="${ZIG:-}"
if [[ -z "$zig_compiler" ]]; then
  for candidate in \
    "$HOME/.cache/tollkeeper-zig/zig-$(uname -m | sed 's/arm64/aarch64/')-$(uname -s | tr '[:upper:]' '[:lower:]' | sed 's/darwin/macos/')-0.15.2/zig" \
    "$(command -v zig || true)"; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then zig_compiler="$candidate"; break; fi
  done
fi
if [[ -z "$zig_compiler" || "$("$zig_compiler" version)" != '0.15.2' ]]; then
  echo 'Zig 0.15.2 required; set ZIG to the compiler path.' >&2
  exit 1
fi
pg_lib_dir="$(pg_config --libdir 2>/dev/null || true)"
pg_include_dir="$(pg_config --includedir 2>/dev/null || true)"
if [[ "$(uname -s)" == Darwin ]]; then
  # Zig 0.15.2 cannot parse the current macOS SDK libSystem exports; the bundled
  # stubs work when the SDK lookup is disabled for this invocation only.
  export DEVELOPER_DIR=/nonexistent
  [[ -z "$pg_lib_dir" ]] && pg_lib_dir="$(brew --prefix libpq)/lib"
  [[ -z "$pg_include_dir" ]] && pg_include_dir="$(brew --prefix libpq)/include"
  host_arch="$(uname -m | sed 's/arm64/aarch64/')"
  exec "$zig_compiler" build "-Dtarget=$host_arch-macos.15.0" "-Dpg-lib-dir=$pg_lib_dir" "-Dpg-include-dir=$pg_include_dir" "$@"
fi
exec "$zig_compiler" build -Dcpu=baseline "-Dpg-lib-dir=$pg_lib_dir" "-Dpg-include-dir=$pg_include_dir" "$@"
