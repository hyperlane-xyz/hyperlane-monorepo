# snarkVM worker lifecycle patch

The workspace pins `hyperlane-xyz/snarkVM` at `9bf48e7c97cd464d92198d429cf87b3bf5bded44`.
It is based on the existing `ProvableHQ/snarkVM` v4.8.1 commit,
`b7f0859592c75dd251430377240c7697a37ab899`. The fork changes only the VM
sequential worker lifecycle and its regression tests. All package versions,
cryptography, consensus rules, authorization, and proving code remain unchanged.
All three direct snarkVM dependencies use the same revision to preserve one set
of shared Rust types; the lockfile changes only their Git source identities.

The original worker held a cloned VM, including the channel sender on which it
waited. Dropping the last external VM neither closed the channel nor freed the
worker's Process. Checking `Arc::strong_count` inside each VM destructor also
cannot reliably identify the last owner when clones drop concurrently.

The patch gives external VM clones an `Arc` queue owner. The worker's VM does
not own that queue. The queue destructor closes the sender, drains pending work,
and joins the worker exactly once. Worker panics are logged during cleanup,
including cleanup during an existing unwind, so Drop does not propagate them. Thread identity is stored separately so
queued operations can still check their execution thread during shutdown.
Public VM methods, clone behavior, network isolation, and per-provider program
caches are preserved. Dropping the final VM now waits for queued sequential
operations, as the original destructor intended. Hyperlane uses these VMs for
authorization and proving, not ledger finalization, so its queue is normally idle.

The lazy per-network cells from #9671 remain: initialization runs on Tokio's
blocking pool, read-only providers create no VMs,
and provider clones share only their initialized execution network. This patch
also releases initialized VMs when their final provider is dropped.

## Validation

From `rust/main`:

```sh
cargo test -p hyperlane-aleo --test vm_lifecycle --locked -- --test-threads=1
cargo test -p hyperlane-aleo --lib --locked
cargo clippy -p hyperlane-aleo --lib --locked -- -D warnings
```

The integration suite checks repeated create/clone/drop cycles on Mainnet,
Testnet, and Canary, plus concurrent final-clone drops. It observes a weak
reference to the actual snarkVM Process, without sleeps or thread-count timing
assumptions. All four tests fail on the original pin. The provider unit test
also checks that initialized state survives one provider drop and is released
with the final clone. The fork includes regressions for draining queued operations during concurrent
final-clone drops, worker panic cleanup, and cleanup during an existing unwind.
A runtime test holds the sole blocking thread to prove that concurrent first
use yields to the async runtime and shares one initialized VM.

## Maintenance and rollout

The reviewed patch is mirrored in the Hyperlane organization under the
`hyperlane-v4.8.1-vm-lifecycle.1` tag and proposed upstream in
[snarkVM #3444](https://github.com/ProvableHQ/snarkVM/pull/3444).
Replace the three pins together
when an upstream revision contains the lifecycle fix, and retain the regression
tests. Review the exact fork diff before taking further upstream updates.

Local ownership tests establish release of each VM's Process and join of its
worker; they do not measure all allocator retention or prove production RSS
attribution. After CI and review, deploy an immutable image, then compare
per-container OS thread count and RSS under comparable Aleo traffic over multiple
days. Existing leaked VMs require a process restart. If growth remains, profile
remaining allocations before changing the resource request in #9666.
