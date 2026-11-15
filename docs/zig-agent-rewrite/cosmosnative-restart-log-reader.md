# Cosmos-native restart log-reader failure

The fourth Cosmos-native Safe case completed its initial eight-message
600-second checks and stopped-store proofs, then stalled inside the Rust test
harness during same-database restart. The full case failed. Root stopped it at
03:20:38 UTC and recorded actual session 34412 joining with exit 1.

| Stage                        | Actual evidence                                           | Acceptance boundary                                      |
| ---------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Initial native delivery      | 8 messages, 8 accepted native transactions                | Native receipt, delivery, SDK/wire and fee checks passed |
| Per-ID confirmation hold     | 600.514680–600.764935 seconds                             | All 8 remained observed through the initial hold         |
| Initial publication/indexing | Accepted live-stage checkpoint, metadata and SQL proofs   | Initial stage only                                       |
| Before-restart stop          | 4 clean parent waits: 2 validators, relayer, scraper      | Actual parent waits; no forced kills                     |
| Stopped-store readback       | 2 canonical Rust namespaces and 8 native operation proofs | Before-restart stage passed                              |
| Restart                      | One replacement validator identity recorded at the stall  | Restart did not complete                                 |
| Full case                    | Failed after controlled stop                              | No after-restart, final-case or performance acceptance   |

Production roles were built from d51ca8d668b26a3fdd248b4dfa99609bdcd6e493.
The accepted initial and before-restart records are retained byte-exactly in the
[archive](../../zig/bench/results/cosmosnative-d51-v4-restart-failure/manifest.json).
Their public native-operation evidence contains signed-byte lengths and digests,
not signed transaction wire.

The initial phase made 22 broadcast attempts: 8 were accepted and 14 received
CometBFT code 32 account-sequence mismatch errors. The public response summaries
and stage records show these rejections recovered during the initial run.
All 22 observed attempts preceded the first message retirement. They are not
after-restart resubmissions: the relayer had already been cleanly stopped, and no
replacement relayer identity was recorded.

The harness called restart_role_handles, replaced its first handle, then joined
the old stdout/stderr watcher threads. In the compiled v13 program.rs,
prefix_log continued sleeping at EOF while the global RUN_LOG_WATCHERS flag
remained true. That flag was intended to change at final teardown. The old role
was already reaped, but its log watcher could not finish, so the helper did not
reach the remaining role restarts.

The archive includes the immutable 1,429-input v13 source map and the matching
pre-fix program.rs bytes, plus the unchanged external_agents.rs bytes verified
against that map. It does not substitute the subsequent EOF-fix source for the
code that ran. The repair and rerun belong to a separate harness epoch.

At the observed stall there were five actual owned role identities: the four
initial roles and one replacement validator. The final raw launch stream had
six pre-spawn descriptors; a descriptor alone does not prove a child started.
The public archive projection excludes its environment and arguments.

The supervisor recorded all direct children joined, unchanged accepted inputs,
no forced cleanup, no remaining owned descendants/listeners and an absent owned
container. Cleanup signals sent to nonchildren grant no parent-wait credit.
These cleanup facts preserve the failed attempt; they do not turn it into a
successful restart.

[Archive verification](../../zig/bench/results/cosmosnative-d51-v4-restart-failure/archive-verification.json)
records deterministic gzip roundtrips and unchanged originals. One supervisor
JSON explicitly redacts its container environment and ownership token while
retaining the private original's size and hash. Public stage proofs, read-only
watch summaries, actual join/stop receipts and before-source bytes are preserved.
Private configurations, signer/keyring data, raw signed RPC traces, databases,
WALs and executables remain local.
