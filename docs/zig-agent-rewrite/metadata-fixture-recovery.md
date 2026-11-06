# Metadata fixture recovery

The broad PostgreSQL run exposed a test listener that exited when a canceled
connection closed before sending HTTP headers. A socket-level regression
reproduced `FixtureUnexpectedEof` before the correction. The listener now skips
only an empty connection; a second socket regression still requires truncated
headers to fail. No production metadata code changed.

A repeated Linux run then exposed an invalid physical request-count assumption.
The remote checkpoint request finishes at threshold two and cancels outstanding
peers, including requests that have not sent headers. Twenty-six eligible peers
therefore do not guarantee twenty-six received GETs. Independent source review
confirmed this contract.

The test now requires the exact checkpoint and two valid, distinct signatures in
configured order, between two and twenty-six physical checkpoint reads, at most
one read per peer, and no checkpoint read for the failed-guard peer. After the
complete latest-index phase, cached replay must return identical checkpoint and
signatures without another checkpoint read. Exact guard, latest-value and full
27-validator observation assertions remain.

| System      | ReleaseSafe | ReleaseFast |
| ----------- | ----------: | ----------: |
| macOS arm64 |       10/10 |       10/10 |
| Linux arm64 |       14/14 |       14/14 |

These are ten substantive module tests; Linux also registers four import roots.
All runs had zero skips or failures and retained the same test-source hash.
The fresh PostgreSQL aggregate subsequently passed 437/437.

The [manifest](../../zig/bench/results/metadata-fixture-preheader/manifest.json)
records 25 verified gzip payloads, including both original failures, four-mode
commands/logs, independent review and source snapshots. Reversing only the
test-module changes exactly reproduced the earlier broad-run source hash; the
intermediate 437-test PostgreSQL snapshot also has its exact source preserved.
These are functional checks, not benchmark measurements.
