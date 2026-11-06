# Allocation and snapshot lifetime review

Intermediate review, 2026-11-05. This is not final-head acceptance.

The original bug allocated the complete matcher handle array, installed handles
one at a time, and called a destructor over the whole array on failure. The
uninitialized suffix could be interpreted as live native handles.

The review followed the variant-analysis skill: exact allocation match, expand
handle type, then inspect the destructor and callers. Broad `errdefer/free`
searches produced mostly arena-backed or primitive-array noise, so those were
not used as a CI blocker.

| Candidate                                                 | Verdict                                                         | Severity / confidence | State                                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `ops/matching.zig` optional native handle array           | Whole-array cleanup before all elements initialized             | Medium / high         | Fixed: initialize null handles before fallible work; allocation-failure sweep |
| `lander/types.zig` access-list tuples                     | Error cleanup traverses uninitialized tuple suffix/current keys | Medium / high         | Reported to implementation owner; final fix and regression required           |
| `lander/service.zig` receipt progress map                 | Inserted undefined map entry before allocating its array        | Medium / high         | Reported to implementation owner; final fix and regression required           |
| `agents/scraper/starknet.zig`, `aleo.zig` endpoint owners | Cleanup covers only `initialized` prefix                        | Informational / high  | Safe; explicit counter precedes every later fallible operation                |
| `evm/transaction.zig` transaction fixture decoder         | Fixture allocations belong to one caller-owned arena            | Informational / high  | Safe for current fixture-only callers; not production request parsing         |

Related confirmed issues found while inspecting the same ownership paths:

- Runtime denylist parse leaked already-built matcher arenas if a later rule
  failed validation. Cleanup now destroys the initialized list; OOM and malformed
  later-rule cases cover it.
- Runtime denylist install leaked parsed rules if allocating the generation
  failed. Install now consumes and cleans input on every outcome.
- Matcher and denylist retirement allocated while collecting old generations,
  turning cleanup OOM into process termination. Collection now removes and frees
  one drained generation at a time without allocating. A failed replacement
  leaves the active generation intact.
- A returned denial reason borrowed an arena after releasing its snapshot. The
  convenience API now returns an owned copy; a test retains that copy across
  expiry and generation replacement.

Additional source-parity fixes in this pass: Tron base58check validation for
address and match rules; canonical object-key ordering; active-only fingerprints;
nullable optional fields; nanosecond expiry; expired-rule pruning after failed
polls; checked pre-epoch date arithmetic and time separators. These are covered
by focused tests and 206 generated cases from the unchanged production Rust parser (147 accepted), including exact canonical fingerprints.

CI regression guard: run `zig/src/ops_tests.zig` with the pinned regex ABI loaded,
including `checkAllAllocationFailures` for matcher construction, parsed rules,
retained generations and failed replacements. The final native suite must also
exercise malformed access-list suffixes and receipt-map OOM before accepting the
lander implementation. A textual allocation search is a review aid, not proof
that an allocation is unsafe.

Additional integration checks (in progress): native /metrics GET and HEAD passed on the real scraper process; immediate same-port restart exposed a missing HTTP listener reuse option. The HTTP worker owns the fix and must retain write-half-close semantics. Origin-to-Lander payload links now seal exact replay input and the Rust UUID relation atomically before enqueue; native RocksDB reopen/replay and conflict/authority tests passed. These component checks do not establish completion of the relayer daemon.

Independent native-integration review found two additional P1 issues, fixed by the parent: fatal `halt_all` classification previously cancelled workers without causing the daemon loop to terminate; `Supervisor.failureReason()` now preserves the original fatal error and the process drains/exits. A two-callback native worker regression proves healthy work is cancelled and its late output discarded. Payload-link recovery now checks canonical nonce identity both while loading and again under the origin store lock through durable destination enqueue; stale loaded links and replaced UUID relations reject. A durable generation watermark survives terminal-link removal, preventing UUID reuse for a later retry. The added regressions pass against real RocksDB. Denylist retry sleeps now use monotonic elapsed time rather than UTC wall time.

The related canonical-store scan found a stale delivered marker on nonce replacement: `upsertMessage` changed the canonical message but retained the old nonce's processed flag. Replacement now deletes that flag in the same native batch; a real RocksDB regression marks the old message delivered, replaces it, and proves the new ID remains eligible. This protects against treating delivery of an orphaned ID as delivery of its replacement.

HTTP restart follow-up found a further API trap: Zig 0.15.2 Address.listen(reuse_address=true) also enables SO_REUSEPORT, permitting concurrent active listeners. The parent now creates the native nonblocking listener with SO_REUSEADDR alone. All23 native HTTP tests passed, covering immediate reuse after GET/HEAD, live-listener exclusivity, proper complete-request write-half-close, reset-based cancellation, late output, and bounds/OOM behavior.

Source metadata catches now preserve reorg refusals, cancellation and pending-I/O control flow across optional aggregation children, verification, serial checkpoint reads and latest-index reads. Focused failures exercise each boundary so another healthy branch cannot mask a known reorg. Unpriced verification preserves source order; it does not fabricate a gas price.
