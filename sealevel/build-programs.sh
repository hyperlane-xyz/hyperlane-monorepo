#!/usr/bin/env bash
# Builds every Go program under sealevel/programs for each goSVM profile and
# writes the ELFs under the Rust file names (hyperlane_sealevel_<name>.so) to
# sealevel/target/<profile>/deploy/, ready for SBF_OUT_DIR.
#
# Usage: sealevel/build-programs.sh [profile...]   (default: fogo-v0 solana-v3)
# Env:   GOSVM  goSVM CLI (default: gosvm on PATH)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rust_programs="$root/../rust/sealevel/programs"
gosvm="${GOSVM:-gosvm}"
profiles=("$@")
if [[ ${#profiles[@]} -eq 0 ]]; then
  profiles=(fogo-v0 solana-v3)
fi

# The Rust cdylib name for a program dir, from its mirror's Cargo.toml.
elf_name() {
  local rel="$1"
  if [[ "$rel" == spl-noop ]]; then
    echo spl_noop
    return
  fi
  local manifest="$rust_programs/$rel/Cargo.toml"
  if [[ ! -f "$manifest" ]]; then
    echo "no Rust program at $manifest for sealevel/programs/$rel" >&2
    exit 1
  fi
  sed -n 's/^name = "\(.*\)"/\1/p' "$manifest" | head -1 | tr - _
}

# Extra goSVM flags per program dir. -max-accounts 64 raises the incoming
# account limit from 32: cross-collateral's transfer_remote takes 33.
extra_flags() {
  case "$1" in
    hyperlane-sealevel-token-cross-collateral) echo "-max-accounts 64" ;;
  esac
}

cd "$root"
programs=()
while IFS= read -r file; do
  dir="$(dirname "$file")"
  programs+=("${dir#programs/}")
done < <(grep -rl --include='*.go' --exclude='*_test.go' '^func Process(c solana.Context) uint64' programs | sort)

if [[ ${#programs[@]} -eq 0 ]]; then
  echo "no programs found" >&2
  exit 1
fi

# Every shared library must fit goSVM's subset even before a program uses it.
"$gosvm" -target "${profiles[0]}" -emit-c -o "$root/target/subsetcheck.c" ./internal/subsetcheck

for profile in "${profiles[@]}"; do
  deploy="$root/target/$profile/deploy"
  build="$root/target/$profile/build"
  mkdir -p "$deploy" "$build"
  for rel in "${programs[@]}"; do
    name="$(elf_name "$rel")"
    # shellcheck disable=SC2046
    "$gosvm" -target "$profile" $(extra_flags "$rel") -o "$build/$name.so" "./programs/$rel"
    cp "$build/$name.so" "$deploy/$name.so"
    chmod 644 "$deploy/$name.so"
    echo "$profile: programs/$rel -> target/$profile/deploy/$name.so"
  done
done
