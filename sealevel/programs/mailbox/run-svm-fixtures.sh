#!/usr/bin/env bash
# Builds the Go mailbox and the fixture helper programs, regenerates
# target/mailbox-svm.json and runs it on both goSVM profiles. With RUST_MAILBOX_ELF
# set (an SBPFv0 hyperlane_sealevel_mailbox.so), runs the same fixtures
# against the Rust program on the fogo-v0 runner too.
#
# Env: GOSVM  goSVM CLI with the Hyperlane syscalls (default: gosvm)
#      LLVM   platform-tools v1.57 llvm directory (default: gosvm's cache)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sealevel="$(cd "$here/../.." && pwd)"
gosvm="${GOSVM:-gosvm}"
llvm="${LLVM:-$HOME/Library/Caches/gosvm/toolchains/v1.57/darwin-arm64/llvm}"
out="$sealevel/target"

for profile in fogo-v0 solana-v3; do
  mkdir -p "$out/$profile/testprograms" "$out/$profile/deploy"
  for p in ism recipient; do
    (cd "$sealevel/internal/testprograms/$p" && "$gosvm" -target "$profile" -llvm "$llvm" -o "$out/$profile/testprograms/$p.so" .)
  done
  (cd "$here" && "$gosvm" -target "$profile" -llvm "$llvm" -o "$out/$profile/deploy/hyperlane_sealevel_mailbox.so" .)
done
(cd "$sealevel" && FIXTURE_DIR="$out" go run ./tools/mailbox-fixtures > "$out/mailbox-svm.json")

for profile in fogo-v0 solana-v3; do
  "$gosvm" svm-test -target "$profile" -elf "$out/$profile/deploy/hyperlane_sealevel_mailbox.so" \
    -fixtures "$out/mailbox-svm.json" -report "$out/$profile/mailbox-svm-results.json"
done
if [[ -n "${RUST_MAILBOX_ELF:-}" ]]; then
  "$gosvm" svm-test -target fogo-v0 -elf "$RUST_MAILBOX_ELF" \
    -fixtures "$out/mailbox-svm.json" -report "$out/fogo-v0/mailbox-svm-results-rust.json"
fi
