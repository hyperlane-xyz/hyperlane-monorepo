# Zig agent rewrite

This is an experimental implementation beside the Rust agents. **It is not a
complete replacement.** The [plan](../docs/zig-agent-rewrite/plan.md),
[scope](../docs/zig-agent-rewrite/scope.md), and
[measured results](../docs/zig-agent-rewrite/results.md) define the remaining work.

Implemented and exercised: protocol bytes/hashes/Merkle proofs; checkpoint signing
and object storage; durable operation recovery; relayer gas/quorum/recursive
metadata logic; EVM RPC and transaction encodings; Sealevel accounts/instructions,
legacy/v0/ALT compilation; cloud request/auth primitives; real RocksDB interop;
bounded deterministic simulation and I/O jobs. Native services and additional
chain adapters are still being integrated. Operator/config/storage parity remains
a completion gate.

## Build and test

Zig 0.15.2 is pinned. The bootstrap reads the official versioned release metadata
and verifies its published size and SHA-256 before extraction.

```sh
export ZIG="$(python3 zig/tools/bootstrap.py)"
python3 zig/tools/zig.py build test -Doptimize=ReleaseSafe --summary all
python3 zig/tools/zig.py build -Doptimize=ReleaseSafe
zig/zig-out/bin/hyperlane-zig simulate 1234 1000
```

On this macOS 27 host, the default SDK's `.tbd` files omit arm64 targets. Zig
0.15.2 therefore needs the installed SDK 15.4. Select it for this invocation:

```sh
export HYPERLANE_ZIG_SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
```

The wrapper supplies a temporary `xcrun` SDK-lookup shim for the compiler's build
runner. It does not alter system SDKs, compiler files, or shell configuration.

Default tests do not use production keys, cloud accounts, databases, or RPC URLs.
Native transport/database integrations are explicit and use disposable fixtures.

## Local EVM integration

Requires `anvil`, `cast`, Node/pnpm and network access for pinned Solidity compiler
and OpenZeppelin sources. The runner verifies the pinned dependency integrity,
compiles repository Solidity, starts its own loopback Anvil, deploys contracts,
then terminates the process and removes its temporary state.

```sh
python3 zig/tools/zig.py build integration-driver -Doptimize=ReleaseSafe
python3 zig/integration/evm.py
```

Cases: message-ID multisig, Merkle-root multisig, routing → aggregation, crash
after durable transaction reservation, identical-byte rebroadcast, idempotent
replay. This is local correctness evidence, not whole-agent throughput parity.

## Benchmarks

The Rust oracle depends on the actual production `hyperlane-core` sources.
It does not reimplement the Rust algorithms. Run each mode independently while
the host is otherwise idle:

```sh
python3 zig/bench/run.py --zig "$ZIG" --optimize ReleaseSafe --clean-build --samples 9 --output zig/bench/results/new-safe
python3 zig/bench/run.py --zig "$ZIG" --optimize ReleaseFast --clean-build --samples 9 --output zig/bench/results/new-fast
```

For the SDK workaround also pass `--sysroot "$HYPERLANE_ZIG_SDKROOT" --library-dir
/usr/lib` to the benchmark runner. Use `--only-differential` to omit timing loops.
See [methodology](../docs/zig-agent-rewrite/benchmarks.md) for environment, cache,
allocator, safety-mode, provenance, and comparison limits.

The recorded ReleaseSafe kernels are slower than Rust. ReleaseFast has mostly
small improvements and a large-body owned-roundtrip regression. Whole-agent
speedup, build-time reduction, LOC reduction, and dependency reduction have not
been demonstrated on equivalent feature sets.

## Read-only capture

`hyperlane-zig shadow config.json` captures a bounded finalized EVM range with
canonical header/log checks. Its configuration explicitly supplies RPC URL,
chain ID, domain, mailbox, optional hook, and block range. The native libcurl
transport provides total/connect deadlines and cancellation; supply
`curl_library` if the platform default library path differs. The report omits the
RPC URL and credentials. No signing, checkpoint publication or transaction
submission path is reachable from this command.

The existing Ethereum capture is a short historical trace, not sustained mainnet
tracking. Its message encoding/ID and insertion correlation were independently
checked against production Rust.
