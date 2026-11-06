# Aleo adapter

Zig owns REST transport, public plaintext/layout codecs, Hyperlane program mappings,
message metadata source, finalization-key event reconciliation, checkpoint votes,
worker orchestration and persistence boundaries. No Rust Hyperlane agent crate is
used by this adapter. Native dependencies retain vetted SnarkVM cryptography and
VM/proving primitives pinned to production fork revision
`6c5b8762d8058287d1d2ca27c391aeb0eccdf9fa`. This is not a zero-dependency claim or a
completed multi-VM production service claim.

Source contracts:

- Networks0/1/2 map to mainnet/testnet/canary paths, preserving base paths/query and
  custom headers through the shared endpoint owner. Mapping brackets are percent
  encoded as the actual Rust URL builder requires. GET fallback has bounded bodies;
  only explicit optional transaction reads turn literal404 into absence. POST does
  not automatically repeat after an uncertain send.
- Hash words are two little-endian u128 values. Messages use exactly16 body words
  (256bytes); decoded bodies retain all padding. Process includes original message
  byte length and ID. Metadata pads to512bytes with1, matching recovery constraints.
  Oversized bodies/metadata reject instead of source's silent truncation.
- Mapping values are latest-only. Metadata-bearing reads preserve their actual
  observed height. Historical checkpoint reads explicitly fail rather than silently
  returning latest state. Aleo finality is immediate; source ignores reorg periods.
- Hook frontier/root agreement is checked. Empty trees cannot produce signable
  checkpoints. Multisig thresholds/counts, duplicate validators, fixed array widths,
  UTF8/C-string bounds and configured addresses are validated. Announce preserves
  the source's exact480-byte C-string input requirement.
- ISM routing/message-ID multisig modules use full32-byte Aleo module addresses;
  validator addresses remain Ethereum20 bytes. Source aggregation dry-run returns
  a placeholder; Zig requires a real verifier and otherwise fails closed.
- Indexing uses the actual network Block decoder, including consensus structure,
  in the isolated worker. Zig hashes source-compatible candidate mapping key IDs,
  checks accepted transaction finalization writes, fetches immutable event values,
  and retains canonical block/transaction/sequence identity. Rejected transactions
  and conflicting sequence owners cannot create indexed events. Output sorts by
  height/transaction/index. Candidate/event/page/memory limits are explicit.

`agents/scraper/aleo.zig` exposes a concrete typed-settings Factory/Source with real
per-stream count/tip reads, no historical-count claim and block reconciliation.
`aleo/validator.zig` exposes actual driver observations/checkpoint votes and fixed
endpoint denominator with normalized URL identity. Full durable Role scheduling,
announcement activation and database lifecycle belong to the shared agent runtime.
Receipt enrichment uses SDK transaction metadata: fee microcredits as gas, fee payer
as sender, first transition program as recipient, nonce0. It validates native ID,
reported inclusion and canonical header under one deadline.

Native libraries:

- `native-crypto`: public address/ID encoding, program address and source BHP1024
  mapping-key hash, no custom curve/hash implementation. Current lock229 packages.
- `native-vm`: generic VM/program/authorization/fee/proving/Block/transaction decode,
  no Hyperlane-specific policy, RPC, Tokio scheduler or credential discovery.
  Current lock398 packages. Initial local release build4m35s; macOS dylib47MiB.
  These are host build observations, not a benchmark against an equivalent service.
- Tiny C ABIs validate pointer/size/network boundaries, catch Rust panics and use
  fixed errors. Native key/seed copies use zeroization; parent/child frames wipe
  secret payloads. Authorization policy rejecting signer-draining credits/token
  transfers lives in Zig.

All runtime VM CPU calls run in `hyperlane-aleo-vm-worker`. One session/process/job,
framed stdin/stdout, no keys in argv/logs/files, no inherited credential environment.
One monotonic absolute deadline covers all commands. Parent pipe I/O is nonblocking;
input/output/memory/cancellation failures issue SIGKILL and reap before returning or
reusing capacity. Linux additionally applies RLIMIT_AS; Darwin uses resident-memory
sampling every<=10ms because RLIMIT_RSS is not a hard bound (sampling can overshoot).
Kernel network sandbox uses Darwin libsandbox or Linux seccomp (x86_64/aarch64).
The proof worker cannot make REST/prover/parameter network requests or exec children.
Direct in-process `vm.zig` is a low-level primitive interface, not the production
bounded execution path.

SnarkVM defaults transitively enable parameter filesystem access. The build helper
reconstructs checksum-pinned upstream `aleo-std-storage1.0.3` with one non-crypto
resource-path override: dedicated `HYPERLANE_ALEO_PARAMETER_DIR`, no ambient home.
Original source/license remain in generated ignored dependency. `Session` receives
an explicit parameter bundle root and injects only that path. Missing parameters
fail under network isolation. No native download is an execution fallback.

```sh
python3 zig/src/aleo/testing/locked.py --toolchain 1.98.0
python3 zig/src/aleo/testing/parameters.py --home /explicit/public-parameter-root --network mainnet --max-degree 18 --fetch
python3 zig/tools/zig.py build aleo-vm-worker -Doptimize=ReleaseSafe
```

`locked.py` restores/verifies exact hook-safe chunked Cargo locks, reconstructs the
pinned storage crate/path patch, and builds both libraries with locked resolution.
`--crypto-only` builds public primitives only; it does not support VM submission.
`parameters.py` fetches official pinned public assets only when explicitly requested,
checks size/SHA256 before installing, and can verify without fetching. Tiny local
proof fixture needs9 unique mainnet files/79,506,114bytes at degree18. Larger/custom
programs may need more standard parameters; include bundle size/build cost in whole
system comparisons. No parameter files/private keys are committed.

Explicit native test environment:

- `HYPERLANE_ALEO_CRYPTO_LIBRARY`: `libziggy_aleo_crypto.dylib`/`.so`
- `HYPERLANE_ALEO_VM_LIBRARY`: `libziggy_aleo_vm.dylib`/`.so`
- `HYPERLANE_ALEO_VM_WORKER`: built worker executable
- `HYPERLANE_ALEO_PARAMETER_HOME`: explicit bundle root for local proof test

Actual tests cover pinned SDK native address/BHP primitives, public protocol layout
boundaries, source mailbox/hook/Block fixtures, source transaction identity/index,
checked authorization/fee/binary prover wire, actual isolated local proof bound to
its exact execution/fee, OS network denial, and worker deadline/partial-frame/
output/input/cancellation/memory faults. Public fixture key0x11 only, no production
credential read, chain request, broadcast or deployment. The source library's
`edition0` execution rejection caught a fixture error; proof fixture uses edition1.

`agents/destination/aleo.zig` now orchestrates concrete process/announcement inputs,
public intent durability, checked authorization/fee estimation, isolated restartable
proving, exact signed transaction persistence, broadcast and native reconciliation.
Persisted authorization snapshots retain source program editions/imports and SDK
execution/fee requests; they contain derived transition view keys and must be
stored as sensitive data. Raw private keys travel only through worker pipes.

`prover.zig` implements the source delegated service protocol with injected native
HTTP/time: Authorization response-header JWT cache15min,401 invalidation, bounded
endpoint cookie sessions, GET pubkey and fresh stdlib libsodium-compatible X25519
sealed boxes for each attempt, POST prove/authorization with source binary false
broadcast bit. Connect-before-send/500/502/503 may retry within30s;504, timeout,
malformed response and unauthorized broadcast are terminal. Delegated mode never
falls back to local proving. Cookie syntax is bounded unquoted RFC6265 values and
IMF-fixdate expiry; unsupported legacy cookie syntax fails explicitly. HTTP redirects
and credential logging remain disabled. Actual native test restores one persisted
execution across independent workers, produces a real local proof, sends encrypted
binary authorization to a fixture prover and validates the returned execution/fee
before mocked submission. Only one private-key callback occurs across that recovery.
