# Configured Cosmos transaction absence

The third actual Cosmos-native Safe case reached eight `ReadyToSubmit`
operations and zero broadcasts. The direct Tendermint client understood the
node's exact transaction-not-found response, but the configured managed RPC pool
retried and discarded it before that client could inspect it. The component fix
preserves the typed absence through the configured blocking and cooperative
read paths.

| Evidence                              | Result                                                                    | Scope                                                      |
| ------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Original configured-pool reproduction | 4 passed, 1 failed with `AllRpcProvidersFailed`                           | Actual local native transport and configured Resources     |
| Frozen ReleaseSafe component          | 18 passed, 0 skipped                                                      | 7 substantive controls, 11 import roots                    |
| Frozen ReleaseFast component          | 18 passed, 0 skipped                                                      | Same controls and copied source snapshot                   |
| Third Cosmos-native case, ac86        | Failed; Root intentionally stopped session 53787                          | 8 ready operations, 0 broadcasts; no 600-second acceptance |
| Failed-case cleanup                   | Direct children joined; owned descendants, listeners and container absent | Actual supervisor result; no invented nonchild wait credit |

The classifier exception is limited to Tendermint `tx` requests whose canonical
base64 32-byte request hash matches the complete hexadecimal hash in the exact
CometBFT error: code `-32603`, message `Internal error`, and
`tx (<64 hex characters>) not found`. The typed client uses the same predicate.
Wrong hashes, malformed request encodings, rate limits, foreign protocols,
transport failures and HTTP errors remain failures. Strict transaction reads
still fail on absence. Quorum behavior remains separately checked.

The seven substantive controls cover configured Resources, repeated business
errors and provider health, single/quorum behavior, malformed or foreign errors,
request binding, transport failures, and a shared cooperative read fork. Both
runs recorded equal source maps and 91 preserved pins. These are component
results against the copied Cosmos snapshot; the subsequently assigned Sealevel
pool correction requires combined validation before a new source commit.

[Component manifest](../../zig/bench/results/configured-cosmos-absence/manifest.json)
and [verification](../../zig/bench/results/configured-cosmos-absence/archive-verification.json)
seal the failing reproduction, intermediate diagnostics, exact five-file final
source snapshot, commands, runner scripts, both final logs and Root's independent
readback. Earlier failed runs remain diagnostic; only `replay-matrix-v2` supplies
the final 18/18 results.

[Failed-case manifest](../../zig/bench/results/cosmosnative-ac86-v3-failure/manifest.json)
and [verification](../../zig/bench/results/cosmosnative-ac86-v3-failure/archive-verification.json)
retain the exact public transaction/error observations, admin and metrics
snapshots, logs, immutable ac86 source, stop record and cleanup evidence. The
terminal pool error in the real case is source-inferred from the captured four
attempts; the relayer did not expose an internal error log. The configured
component separately reproduces `AllRpcProvidersFailed` directly.

Root reported the actual prior session join with exit 1. No separate saved
Root join receipt exists, so the archive does not claim a newly observed OS wait.
The supervisor's own child joins and final absence checks are preserved.

All gzip payloads use deterministic compression and were decompressed and
rehashed against their originals. One failed-case supervisor JSON is explicitly
sanitized: the container environment and ownership token are redacted, with the
private original's size and SHA recorded. Other payloads preserve original
bytes. Private configurations, keys, raw signed transaction traces, databases,
WALs and executables remain local. These archives grant no native-family,
600-second lifecycle or performance acceptance.
