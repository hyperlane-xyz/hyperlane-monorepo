# Public fixture provenance

## Scope and source of truth

The canonical artifact set contains 44 public protocol/oracle inputs (3,249,015 uncompressed bytes):

- 31 new Zig SDK/reference JSON and JSONL fixtures.
- 13 exact standalone reference/regex `Cargo.lock` files. Their paths and recovery provenance are listed in [helper lock closure](zig-agent-rewrite/helper-locks.md).

Every gzip member is deterministic (`mtime=0`) and decompresses to the exact accepted bytes. `zig/bench/results/packed-oracle-artifacts.json` records paths, raw/gzip sizes, and 31-character SHA-256 chunks. `zig/tools/fixture-locks.json` additionally records each lock restore target and expected digest. Consumers read the compressed inputs or restore verified locks before locked builds. Local raw mirrors remain preserved under exact ignore paths; fresh checkouts use the canonical artifacts.

Production `rust/main/Cargo.lock` and `rust/sealevel/Cargo.lock`, original tracked Rust/Solidity/`vectors` fixtures, deployment configs, local keypairs, native binaries and pinned executables are outside this fixture set. Historical benchmark logs have a separate lossless manifest below.

## Regeneration and restore

`zig/bench/results/packed-historical-artifacts.json` separately covers 301 immutable historical log/JSON artifacts. Open those gzip members directly or run `python3 zig/tools/fixture_pack.py unpack <artifact.gz>` before using a default raw-path consumer. Recorded raw `.json` references inside packed JSON remain unchanged; resolve them to the canonical `.json.gz` member or restore the raw mirror first. Existing authoritative fixture/lock manifests are unchanged.

```sh
python3 zig/tools/fixture_pack.py pack <source.json>
python3 zig/tools/fixture_pack.py manifest <source1.json.gz source2.json.gz ...>
python3 zig/tools/fixture_pack.py restore-locks
```

Packing rejects symlinks, symlinked parents, non-regular files, paths outside the checkout, and decompression over 128 MiB. Manifest generation sorts by path and validates every round trip. Lock restoration accepts only the reviewed manifest, verifies exact byte count and SHA-256 before replacement, requires regular targets, and uses same-directory replacement. It is intended to run before every `cargo --locked` invocation.

## Consumer map

The following consumers reference the selected inputs and are the minimal migration surface:

| Inputs                                                | Consumer symbols                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `agents/destination/fixtures/reveal.jsonl`            | `zig/src/agents/destination/reveal_oracle_test.zig`, `zig/reference/reveal/generate.py`                    |
| `agents/scraper/fixtures/*.json`                      | `receipts_radix.zig`, `receipts_sealevel.zig`, `sealevel/log_meta.zig`, associated RPC fixtures            |
| `agents/validator/fixtures/http.jsonl`                | `agents/validator/http.zig`, `reference/validator-http/generate.py`                                        |
| `aleo/fixtures/*.jsonl`                               | `aleo/testing.zig`, `agents/scraper/aleo_cooperative_test.zig`                                             |
| `altvm/fixtures/*.json`                               | `altvm/compiler_oracle.zig`, `cosmos/announcement.zig`, `sealevel/announcement.zig`, destination/ISM tests |
| `cosmos/fixtures/sdk.json`                            | Cosmos SDK fixture consumers and `cosmos/README.md` generation command                                     |
| `db/fixtures/codecs.jsonl`                            | `db/golden_test.zig`                                                                                       |
| `evm/fixtures/*.jsonl`                                | `evm/announce.zig`, EVM transaction/signature tests                                                        |
| `lander/testing/reference/fixtures/lander_types.json` | `lander/testing/reference/src/main.rs`, `lander/tests.zig`                                                 |
| `net/fixtures/endpoints.jsonl`                        | `net/endpoint.zig`                                                                                         |
| `ops/testing/denylist.json`                           | `ops/runtime_denylist.zig`, `ops/tools/denylist_fixtures.py`, Rust runtime-denylist tests                  |
| `protocol/fixtures/ethers-recovery.json`              | `protocol/signature.zig`, `bench/signature.py`                                                             |
| `radix/fixtures/*.json`                               | `radix/announcement.zig`, `radix/sdk_fixtures.zig`, Radix reference commands                               |
| `settings/fixtures/*.jsonl`                           | `settings_tests.zig`, `reference/settings/generate.py`                                                     |
| `starknet/fixtures/sdk.jsonl`                         | `starknet/testing.zig`, `agents/scraper/starknet_testing.zig`                                              |
| `storage/fixtures/objects.jsonl`                      | `storage/objects.zig`                                                                                      |
| `tron/fixtures/*.jsonl`                               | `tron/testing.zig`, `tron/testing/regenerate.py`                                                           |
| Thirteen canonical lockfiles                          | Their corresponding `Cargo.toml` builds and verified restore paths in `helper-locks.md`                    |

## Consumer verification

Zig consumers decode through `testing/fixture.zig`; Rust fixture helpers restore or
decompress their accepted inputs before compilation. Existing parsed types, wire
bytes and assertions remain the differential contract. Five lock-closure tests
verify absent-raw-file restoration, complete helper coverage, exact production
dependency identities, tamper refusal and checkout-independent source paths.

Normal hooks remain required without bypass flags. Public hashes and signatures
are protocol data; chunked digests and lossless gzip preserve exact values while
avoiding false positives in the repository's broad private-key check.

The formatter excludes generated `zig/bench/results/**`, matching the existing
vector-data policy. Reformatting measured evidence would invalidate its byte
hashes. Source and authored documentation remain formatted; security checks and
all commit hooks still run. Artifact hashes must be rechecked after hooks.
