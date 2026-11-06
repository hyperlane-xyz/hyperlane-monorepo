# Actual relayer process acceptance

`zig/integration/relayer_process.py` runs the native executable on disposable
Anvil and repository Mailbox, MerkleTreeHook, ValidatorAnnounce, IGP and ISM
contracts. Public key11 and an otherwise empty credential environment are used.
It is correctness/recovery evidence, not a throughput benchmark.

Latest accepted artifact: zig/bench/results/relayer-process-ccip-projection-crashfix.json.
This is an intermediate functional snapshot. It predates the production600-second
post-inclusion confirmation wait added during the final Source review. Its7,060ms
delivery observation and finalized accounting checks remain recorded evidence;
its fast operation retirement is not Source-equivalent. A fresh current-binary
process run must wait the actual production window before final acceptance.

The actual daemon passes all three ISM deliveries, finalized gas accounting,
same-DB restart, origin progress during a stalled destination receipt, and a
physical WAL crash before enqueue followed by exactly-once recovery.

Production Rust HyperlaneRocksDB/FullPayload readback confirms processed
markers, finalized destination payloads, positive IGP payments, and real
expenditure for each message:111,553 /125,222 /155,173 gas. These are fixture
observations, not paired performance measurements. Delivery completed in7,060ms
on this shared host; SIGTERM drains were16 /16 /22ms for the first, restarted,
and stalled runs.

The earlier relayer-process.json retains its failed zero-expenditure snapshot.
Early-finality and retirement failure logs remain. The process test waits for
actual operation retirement before inspecting the stopped database; on-chain
delivery alone does not establish finalized accounting.

The latest pinned executable passes:

- Null, message-ID multisig and Merkle-root multisig delivery through indexing,
  policy, metadata, durable payload sealing and Lander.
- Rust readback of processed messages, insertion IDs, IGP aggregates, actual
  expenditure and destination payloads.
- Same-DB restart with identical readback and no extra transaction nonce.
- A real stalled receipt while the origin indexes a fifth dispatch and insertion.
- Metrics GET/HEAD and source version/agent labels.
- A crash after durable origin seal and before destination enqueue: Rust sees
  the origin link while the destination payload is absent. Recovery adds one
  nonce; the next restart adds none.

The deterministic crash uses a fixture-only dylib, never linked into the agent.
An exact disposable DB directory and `.log` suffix gate its Mach-O interposition
of a real WAL write. After the seal write succeeds, the hook fsyncs that file and
writes a public proof marker, then SIGKILLs the unchanged executable before its
RocksDB caller can return to enqueue. An unrelated-path negative control and
positive real-write test run first. Executable, hook and source digests plus Rust
readback are retained. The interposition table follows Apple's public
[dyld interposing ABI](https://github.com/apple-oss-distributions/dyld/blob/main/include/mach-o/dyld-interposing.h).
This exercises process-crash recovery; it does not simulate hardware power loss.

An earlier WAL-poll attempt missed the narrow pre-enqueue window8 times. Those
SIGKILLs found both records present and are not counted as pre-enqueue proof.
Raw diagnostics remain in `/tmp/ziggy-relayer-process.log`; deterministic results
are in `/tmp/ziggy-relayer-process-2.log` and the checked result artifact.

### Final prepared harness guards (not whole-process evidence)

`wait_for_retirement` checks the actual confirmed counter on every poll against
an explicit older-operation upper bound plus tracked IDs eligible after their
own first proxy inclusion + 600 seconds. Tracked IDs must remain in the actual
`list_operations` response until their individual bound, so an older-operation
allowance cannot hide a fresh ID retiring early. Terminal acceptance requires
the exact expected confirmed total, no operations and a zero confirm queue;
first completion is captured before shutdown. Older bounds are recorded along
with the first actual counter, never inserted into metric data. Batch and crash
fresh databases still index prior nonces, but admit only their exact target IDs
through configured whitelists, so their older-operation allowance is zero.
WebSocket restart derives its older bound from unprocessed rows in the first
stopped Rust readback.

Singleton and maxBatch4 proofs require successful canonical receipts and exact
Mailbox `ProcessId` event ID/emitter/transaction/block identity. The batch must
contain the four distinct expected IDs, with original prebroadcast estimates,
per-ID floor allocation and bounded dust. Four duplicate calls cannot satisfy
four-message acceptance.

Pure regression command: `PYTHONDONTWRITEBYTECODE=1 python3 zig/bench/relayer_test.py`.
These are prepared guards. Fresh binaries and actual 600-second process cases
remain required. The batch whitelist excludes the intentionally stalled fifth
message from submission. Each crash attempt dispatches and admits one new target;
older pending fixture messages cannot select the crash target. Actual execution
must still prove a four-member transaction and the durable pre-enqueue boundary.
