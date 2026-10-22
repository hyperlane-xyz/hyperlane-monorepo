#!/usr/bin/env bash
# Conformance + CU harness: run the Sealevel functional test suites against
# arbitrary program ELFs (e.g. Rust builds vs goSVM ports) and record per-test,
# per-invocation compute units.
#
# Usage:
#   conformance.sh [options] <elf-dir> [suite...]   run suites (default: all)
#   conformance.sh build-rust <out-dir>              build the Rust ELFs into <out-dir>
#   conformance.sh list                              list suites
#
# Options:
#   -o <file>   output JSON (default: ./conformance-<timestamp>.json)
#   -m <file>   also write a markdown summary
#   -l <dir>    keep raw suite logs here (default: <output>.logs/)
#   -j <n>      run n suites in parallel (default: 1; each suite is always serial)
#
# Mechanism: solana-program-test (3.0.x) sets prefer_bpf when SBF_OUT_DIR or
# BPF_OUT_DIR is set; then add_program("<name>", id, Some(processor)) loads
# "<SBF_OUT_DIR>/<name>.so" and ignores the native processor (panics if the
# file is missing). The ELF is installed under the non-upgradeable bpf_loader.
# The harness points SBF_OUT_DIR at a staging dir with symlinks to <elf-dir>
# plus test-name aliases and a noop ELF, so <elf-dir> itself stays untouched.
# Accepted ELFs: SBPF v0..v3 (all features are active in program-test).
#
# Compare two runs with: programs/conformance/cu-diff.py <a.json> <b.json>

set -euo pipefail

PROGRAMS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEALEVEL_DIR="$(dirname "$PROGRAMS_DIR")"
HELPERS="$PROGRAMS_DIR/conformance"

# suite name | cargo test target selection
SUITES=(
  "mailbox|-p hyperlane-sealevel-mailbox-test --lib"
  "igp|-p hyperlane-sealevel-igp-test --lib"
  "validator-announce|-p hyperlane-sealevel-validator-announce --test functional"
  "multisig-ism-message-id|-p hyperlane-sealevel-multisig-ism-message-id --test functional"
  "token|-p hyperlane-sealevel-token --test functional"
  "token-collateral|-p hyperlane-sealevel-token-collateral --test functional"
  "token-native|-p hyperlane-sealevel-token-native --test functional"
  "token-cross-collateral|-p hyperlane-sealevel-token-cross-collateral --test functional"
  "fee|-p hyperlane-sealevel-fee --test functional"
)
for f in "$PROGRAMS_DIR"/ism/composite-ism/tests/functional_*.rs; do
  t="$(basename "$f" .rs)"
  SUITES+=("composite-ism/${t#functional_}|-p hyperlane-sealevel-composite-ism --test $t")
done

# Program crates whose ELFs the suites load (paths relative to programs/).
RUST_PROGRAMS=(
  mailbox hyperlane-sealevel-igp validator-announce
  ism/multisig-ism-message-id ism/composite-ism ism/test-ism test-send-receiver
  hyperlane-sealevel-token hyperlane-sealevel-token-collateral
  hyperlane-sealevel-token-native hyperlane-sealevel-token-cross-collateral
  hyperlane-sealevel-fee
)

# Test-registered program name -> ELF it should resolve to, when they differ.
ALIASES=(
  "hyperlane_sealevel_ism_multisig_ism.so:hyperlane_sealevel_multisig_ism_message_id.so"
)

RUST_LOG_FILTER="solana_runtime::message_processor::stable_log=debug,solana_program_test=info"

log() { echo "#### $*" >&2; }
die() { echo "error: $*" >&2; exit 1; }

suite_args() {
  local want="$1" s
  for s in "${SUITES[@]}"; do
    [[ "${s%%|*}" == "$want" ]] && { echo "${s#*|}"; return 0; }
  done
  return 1
}

find_noop_elf() {
  # Minimal SBPFv0 program that deserializes its input and returns success.
  # Ships inside the solana-bpf-loader-program crate source (already a dependency).
  local f
  for f in "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/solana-bpf-loader-program-3.*/test_elfs/out/noop_aligned.so; do
    [[ -f "$f" ]] && { echo "$f"; return 0; }
  done
  return 1
}

build_rust() {
  local out="${1:?usage: conformance.sh build-rust <out-dir>}"
  # shellcheck source=/dev/null
  source "$PROGRAMS_DIR/toolchain.env"
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
  local p
  for p in "${RUST_PROGRAMS[@]}"; do
    log "build-sbf $p"
    cargo build-sbf --manifest-path "$PROGRAMS_DIR/$p/cdylib/Cargo.toml" \
      --tools-version "$SBF_TOOLS_VERSION" --sbf-out-dir "$out" -- --locked
  done
  ls -l "$out"/*.so
}

stage_elfs() {
  local elf_dir="$1" stage="$2" f a from to
  for f in "$elf_dir"/*.so; do
    [[ -e "$f" ]] && ln -sf "$f" "$stage/$(basename "$f")"
  done
  for a in "${ALIASES[@]}"; do
    from="${a%%:*}"; to="${a#*:}"
    if [[ ! -e "$stage/$from" && -e "$stage/$to" ]]; then
      ln -sf "$elf_dir/$to" "$stage/$from"
    fi
  done
  if [[ ! -e "$stage/spl_noop.so" ]]; then
    local noop
    noop="$(find_noop_elf)" || die "no spl_noop.so in $elf_dir and noop_aligned.so not found in cargo registry"
    ln -sf "$noop" "$stage/spl_noop.so"
  fi
}

run_suite() {
  # Internal: run_suite <suite> <stage> <logdir>
  local suite="$1" stage="$2" logdir="$3" args logfile rc
  args="$(suite_args "$suite")"
  logfile="$logdir/${suite//\//__}.log"
  log "running $suite"
  set +e
  # shellcheck disable=SC2086
  (cd "$SEALEVEL_DIR" && env -u BPF_OUT_DIR SBF_OUT_DIR="$stage" RUST_LOG="$RUST_LOG_FILTER" \
    RUSTC_BOOTSTRAP=1 cargo test --locked $args -- \
    --test-threads=1 -Z unstable-options --format json --report-time) >"$logfile" 2>&1
  rc=$?
  set -e
  echo "$suite $rc" >>"$logdir/exit-codes"
  log "done $suite (exit $rc)"
}

main() {
  case "${1:-}" in
    build-rust) shift; build_rust "$@"; return ;;
    list) local s; for s in "${SUITES[@]}"; do echo "${s%%|*}"; done; return ;;
    __run-suite) shift; run_suite "$@"; return ;;
  esac

  local out="" md="" logdir="" jobs=1 opt
  while getopts "o:m:l:j:h" opt; do
    case "$opt" in
      o) out="$OPTARG" ;;
      m) md="$OPTARG" ;;
      l) logdir="$OPTARG" ;;
      j) jobs="$OPTARG" ;;
      *) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 2 ;;
    esac
  done
  shift $((OPTIND - 1))
  local elf_dir="${1:?usage: conformance.sh [options] <elf-dir> [suite...]}"
  shift
  [[ -d "$elf_dir" ]] || die "not a directory: $elf_dir"
  elf_dir="$(cd "$elf_dir" && pwd)"

  local suites=() s
  if [[ $# -gt 0 ]]; then
    for s in "$@"; do suite_args "$s" >/dev/null || die "unknown suite: $s (see: conformance.sh list)"; suites+=("$s"); done
  else
    for s in "${SUITES[@]}"; do suites+=("${s%%|*}"); done
  fi

  out="${out:-$PWD/conformance-$(date +%Y%m%dT%H%M%S).json}"
  logdir="${logdir:-$out.logs}"
  mkdir -p "$logdir"
  logdir="$(cd "$logdir" && pwd)"
  rm -f "$logdir/exit-codes"

  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/conformance-elfs.XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  local stage="$STAGE"
  stage_elfs "$elf_dir" "$stage"
  log "staged ELFs in $stage:"; ls -l "$stage" >&2

  # Build every selected test binary up front so suite logs only contain test output.
  local pkgs=() a
  for s in "${suites[@]}"; do
    read -r -a a <<<"$(suite_args "$s")"
    [[ " ${pkgs[*]} " == *" -p ${a[1]} "* ]] || pkgs+=(-p "${a[1]}")
  done
  log "building test binaries"
  (cd "$SEALEVEL_DIR" && cargo test --locked --no-run --lib --tests "${pkgs[@]}")

  printf '%s\n' "${suites[@]}" |
    xargs -P "$jobs" -I{} "${BASH_SOURCE[0]}" __run-suite {} "$stage" "$logdir"

  local specs=()
  for s in "${suites[@]}"; do specs+=("$s=$logdir/${s//\//__}.log"); done
  local md_args=()
  [[ -n "$md" ]] && md_args=(--md "$md")
  set +e
  python3 "$HELPERS/parse_logs.py" --elf-dir "$elf_dir" --staging-dir "$stage" \
    --exit-codes "$logdir/exit-codes" --out "$out" "${md_args[@]}" "${specs[@]}"
  local rc=$?
  set -e
  log "wrote $out (logs: $logdir)"
  return $rc
}

main "$@"
