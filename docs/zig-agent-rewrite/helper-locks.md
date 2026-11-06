# Standalone Rust helper lock closure

All 19 standalone helper projects now have reviewable exact lock sources: 13
canonical `Cargo.lock.gz` artifacts plus eight existing custom chunked pins, with
two identical canonical/custom duplicates. One vendored Aleo path dependency uses
its owning VM project lock rather than a separate workspace lock. No agent
runtime logic was moved into these reference helpers.

Restore canonical locks before any manual locked helper build:

```sh
python3 zig/tools/fixture_pack.py restore-locks
python3 -m unittest discover -s zig/tools -p test_fixture_locks.py -v
```

The restorer verifies size and SHA256 chunks and rejects symlink targets. Generated
raw `Cargo.lock` mirrors remain ignored; the canonical compressed artifacts and
`zig/tools/fixture-locks.json` are the fresh-checkout source of truth. Compression
is deterministic and lossless. No lock is seeded from a mutable package index on
first build, and no fresh-build path may remove `--locked` to reconcile it.

| Projects                                                                                         | Restorer / canonical source                                                                                            |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `zig/reference` plus `db-codecs`, `evm`, `rocks`, `tron`, `reveal`, `settings`, `validator-http` | `fixture_pack.py restore-locks`                                                                                        |
| `zig/src/altvm/reference`, `zig/src/radix/reference`                                             | same canonical restorer                                                                                                |
| `zig/src/lander/testing/reference`                                                               | same canonical restorer; recovered graph provenance below                                                              |
| `zig/src/ops/regex-native`, `zig/src/ops/testing/reference`                                      | canonical restorer; identical custom pins remain verified                                                              |
| `zig/native/rocks`                                                                               | `python3 zig/tools/native_deps.py --restore-only`                                                                      |
| Starknet crypto and reference                                                                    | `python3 zig/src/starknet/testing/locked.py --restore-only`                                                            |
| Aleo crypto and VM                                                                               | `python3 zig/src/aleo/testing/locked.py --restore-only`                                                                |
| Endpoint URL reference                                                                           | `python3 zig/src/net/testing/endpoint-reference/restore.py` restores its verified custom pin before its explicit build |

SDK custom lock bytes/restorers were not changed. Aleo's existing preparation
also reconstructs its narrow storage-resource path dependency from a checksum-
pinned crate archive; a missing archive may require the separately documented
source-download preparation. Lock-only validation does not execute that network
preparation. Production Rust/Sealevel path dependencies require the same complete
checkout, and git dependency revisions remain fixed by the restored lock.

The kernel and packed-prover runners now restore canonical locks before locked
builds, without a fresh-lock unlocked fallback. The EVM generator has the same
restore-first/always-locked correction; Tron regeneration restores first too. Other direct Cargo examples require the
canonical restore step above. Runtime/active integration scripts were unchanged.

## Audit findings and proof

Five existing ignored local graphs had no canonical artifact: reference root,
Rocks, DB-codecs, EVM and Tron. Their original lock bytes were packed exactly,
without any dependency resolution or update. Rocks is therefore reproducible
before its next explicit locked rebuild, rather than relying on the author's
ignored 353,935-byte file.

Lander had no prior raw or packed lock. A bounded task-owned search found none.
The first approved offline `generate-lockfile` trial selected 169 external
identities outside production and was rejected/quarantined. A compatible
reference seed still left 94; production-seeded metadata reduced that to two:
registry `primitive-types 0.12.1` and `rlp 0.5.2`. The standalone helper lacked
production's git patches. Adding those same patches and preserving the exact
ethers revision produced **328 packages, 325 external identities, zero external
version/source/checksum differences from production**. This is a newly recovered
helper graph, not a historical-original-lock claim. Its exact recipe/digests are
in `zig/src/lander/testing/reference/lock-provenance.json`.

Five Python checks pass without Cargo compilation or network: clean restoration
with all 13 raw locks absent; coverage of every standalone manifest and immutable
git/registry pins; zero-drift Lander identities; tampered-artifact refusal; and
checkout-derived production source paths / isolated golden output. Locked offline
Cargo metadata also passes. The separately approved locked/offline functional
build passed all three Lander binaries. Its regenerated 2,090-byte type JSON
matched the preserved canonical bytes exactly; six production escalator vectors,
three ethers estimator vectors, JSON round-trips, all twelve EIP-2930 fields and
four multicall wire/result/error cases passed. Source and canonical raw/gzip
hashes remained unchanged. Evidence: `zig/bench/results/lander-golden-recovery/result.json`.
This was functional verification, not a timing benchmark.

Lander's std-only `build.rs` derives paths from `CARGO_MANIFEST_DIR`, emits four
small `#[path]` module declarations into `OUT_DIR`, and tracks the four exact
production files. Production source bytes and inner attributes remain unchanged;
no source-body extraction or symlinks are used. Its existing private scaffolding
is retained. `ZIGGY_LANDER_FIXTURE_OUTPUT` directs type-fixture generation to an
isolated candidate instead of overwriting the canonical gzip or ignored mirror.

## Reproducing the isolated golden comparison

The completed verification is recorded above. For a future rerun, coordinate a
compile slot and preserve expectations first;
never regenerate/pack a new canonical golden before comparison. The following
uses an isolated compiler target and output directory, no history overwrites:

```sh
python3 zig/tools/fixture_pack.py restore-locks
repo=$(pwd)
lander_check=$(mktemp -d /tmp/ziggy-lander-golden.XXXXXX)
mkdir -p "$lander_check/before" "$lander_check/candidate"
cp zig/src/lander/testing/reference/fixtures/lander_types.json.gz "$lander_check/before/lander_types.json.gz"
python3 - "$lander_check" <<'PY'
import gzip, pathlib, sys
base = pathlib.Path(sys.argv[1])
(base / 'before/lander_types.json').write_bytes(gzip.decompress((base / 'before/lander_types.json.gz').read_bytes()))
PY
(
  cd rust/main
  CARGO_NET_OFFLINE=true cargo +1.98.0 build --locked --offline --release \
    --manifest-path "$repo/zig/src/lander/testing/reference/Cargo.toml" \
    --target-dir "$lander_check/target" --bins -j 2
)
ZIGGY_LANDER_FIXTURE_OUTPUT="$lander_check/candidate/lander_types.json" \
  "$lander_check/target/release/lander-escalator-oracle" > "$lander_check/candidate/escalator.stdout"
"$lander_check/target/release/multicall" > "$lander_check/candidate/multicall.stdout"
"$lander_check/target/release/eip2930" > "$lander_check/candidate/eip2930.json"
cmp "$lander_check/before/lander_types.json" "$lander_check/candidate/lander_types.json"
printf 'Preserved golden check: %s\n' "$lander_check"
```

The type JSON comparison must be exact bytes. Escalator/estimator assertions run
inside the main helper; the other output files remain separate independent
reference candidates for their existing Zig tests. No canonical fixture update
is implied by compilation success. The old canonical uncompressed hash is stored
as chunks in `lock-provenance.json`; no production Rust file was modified.
