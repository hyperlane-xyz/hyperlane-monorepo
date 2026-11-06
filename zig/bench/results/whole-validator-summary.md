# Actual EVM validator snapshots

All samples and regressions retained. These snapshots were not coordinated team-idle and telemetry/durability differ. Timing changes across snapshots also include host-load differences.

| Snapshot | Rust catchup ms | Zig catchup ms | Rust freshness ms | Zig freshness ms | Rust CPU s | Zig CPU s | Rust RSS MB | Zig RSS MB | Rust RPC | Zig RPC |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| whole-validator-initial | 3469 | 2866 | 1974 | 527 | 0.2615 | 1.0107 | 36.52 | 38.86 | 96 | 461 |
| whole-validator-cached-releasesafe | 4300 | 2379 | 2004 | 428 | 0.2130 | 0.5419 | 36.14 | 38.55 | 98 | 303 |
| whole-validator-cached-releasefast | 4020 | 2331 | 2003 | 347 | 0.2486 | 0.3236 | 36.72 | 21.43 | 94 | 301 |
| whole-validator-smoke2 | 3308 | 2230 | 1994 | 49 | 0.1834 | 0.1407 | 35.78 | 38.03 | 58 | 125 |
| whole-validator-profile-initial | 5379 | 6172 | 1789 | 193 | 0.2305 | 1.1858 | 36.73 | 38.90 | 76 | 835 |

The initial and cached snapshots each have five process pairs. Smoke2 has one pair (4 backlog + 2 feedback-paced events); profile-initial has one pair (128 backlog + 4 independent one-second arrivals) and a separate five-second profiler capture. Smoke2 and profile-initial are diagnostic/nonacceptance evidence. RSS is decimal MB; displayed values are medians.

[All reported summary metrics, failed oracle attempt and raw artifact links](../../../docs/zig-agent-rewrite/results.md#historical-validator-diagnostics-and-failed-smoke). The failed `whole-validator-smoke` has no completed sample and no comparative metric row. None of these shared-host historical snapshots establishes final-source or all-feature-equivalent performance.
