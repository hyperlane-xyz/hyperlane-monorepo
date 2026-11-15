# d51 build and functional acceptance

Both corrected role builds and all 20 fresh functional gates passed for
d51ca8d668b26a3fdd248b4dfa99609bdcd6e493. Root recorded actual build session
96479 and gate session 12989 joining with exit 0. Separate readback validators
checked the accepted results and current artifact bytes.

| Check                                             |             ReleaseSafe |             ReleaseFast |
| ------------------------------------------------- | ----------------------: | ----------------------: |
| Validator, relayer, scraper and Aleo worker build |              4 products |              4 products |
| Default tests                                     |              757 passed |              757 passed |
| Native database tests                             | 1,146 passed, 1 skipped | 1,146 passed, 1 skipped |
| PostgreSQL native tests                           |              446 passed |              446 passed |
| Production migrations / SQL functional cases      |                 21 / 11 |                 21 / 11 |
| RPC producer tests                                |              416 passed |              416 passed |
| Operator / regex tests                            |               56 passed |               56 passed |
| WebSocket tests                                   |               22 passed |               22 passed |
| Socket ownership tests                            |                4 passed |                4 passed |
| Validator / relayer / scraper help                |              3 exited 0 |              3 exited 0 |

Counts belong to overlapping roots and must not be summed as unique coverage.
The sole native skip in each mode was
evm_prepare_delegated_tests.test.opt-in loopback prepares actual repo Solidity
without delivery or nonce mutation. All 28 required Cosmos compatibility,
pending-transaction, signed-broadcast and configured Cosmos/Sealevel cases passed
by name in both native roots. Both PostgreSQL runs passed the actual scraper
process fixture and proved their data directory was a kernel tmpfs capped at
2,147,483,648 bytes.

The build closure contains 605 selected files; the functional closure contains
748 physical inputs. Both maps, 89 preserved products, eight new mode-specific
roles/workers, five reused Rust DSOs, seven native archives and supporting tools
were checked against the accepted pins. The selected counts describe byte
closures, not unique compiled modules. The build readback also checked all
605 selected source bytes against the committed Git blobs.

[Build manifest](../../zig/bench/results/combined-production-correctness-d51/manifest.json)
and [verification](../../zig/bench/results/combined-production-correctness-d51/archive-verification.json)
seal the two original results/logs, recipe, source maps, preserved-product
descriptors, actual Root launch/join and independent readback.

[Functional manifest](../../zig/bench/results/combined-production-functional-d51/manifest.json)
and [verification](../../zig/bench/results/combined-production-functional-d51/archive-verification.json)
seal the single fresh 20-gate attempt, raw logs, PostgreSQL results and kernel
proofs, mode-worker maps, actual Root launch/join and curated acceptance reader.
Earlier gate results receive no credit here. The focused configured-pool source
results remain in their [separate archive](../../zig/bench/results/configured-pool-final-20261107/manifest.json).

A read-only capture through the exact running Fast PostgreSQL fixture observed
18,943,766,528 guest filesystem bytes available at 2026-11-07 02:55:09 UTC.
Inspect/df/inspect all exited 0 with ownership and limits checked before and
after. A later read-only inspect confirmed that exact container was absent;
no cleanup was needed. This dated observation is not a capacity reservation.
The optional archive subgroup excludes full live Docker inspect/environment
output and explicitly redacts two ownership-token fields, retaining the private
original sizes and hashes.

Both build/gate attempts were clean. A later native-case prelaunch guard saw a
transient external Zig process and failed before a fresh successful preflight;
that separate Root-reported event is not a build or functional-gate failure.
These shared-host correctness results make no quiet-host or performance claim.

All selected payloads use deterministic gzip and were rechecked against their
originals; the two sanitized capacity JSONs are explicitly identified. Raw
mirrors are individually ignored. Binaries, caches, databases, private case
configurations, keys and transaction bodies remain local. Actual native-family
node cases, elapsed-600-second lifecycle proofs and benchmarks require separate
acceptance.
