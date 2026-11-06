# Configured scraper metrics identity

Component verification, 2026-11-06. Raw evidence, reproduction commands and source
hashes are in `zig/bench/results/public-identity/manifest.json`. Runtime integration
and final rewrite acceptance are separate gates.

Rust `hyperlane-base/src/settings/chains.rs` builds a configured signer while
preparing provider metrics to obtain its public address, including for scrapers.
The Zig scraper previously had no transaction signer owner and omitted this
wallet. `agents/public_identity.zig` now resolves the configured public identity
once on the existing supervised health worker. Constructors perform no file,
credential, command or network I/O. Scrapers without configured signers do no
resolution. Validators have no metrics wallet. Relayers continue publishing the
actual initialized lane signer and perform no additional key lookup.

| Protocol              | Existing primitive used                                                   | Public fixture check                                                               |
| --------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Ethereum              | DigestSigner public address, lowercase hex                                | Known 0x11 seed address                                                            |
| Tron                  | Ethereum public address plus Base58Check                                  | Known 0x11 seed address                                                            |
| Sealevel              | Ed25519 public key plus Base58                                            | Rust SDK zero-seed payer bytes                                                     |
| Cosmos / CosmosNative | Compressed secp256k1 public key, configured address type, Bech32          | Rust SDK fixture; configured prefix enforced                                       |
| Radix                 | Ed25519 public key, virtual account node, network Bech32m                 | SDK fixture; actual reader network enforced                                        |
| Starknet              | Configured account address, checked as a Felt                             | Exact configured address; key checked separately                                   |
| Aleo                  | Existing bounded isolated SnarkVM key-address worker, native address text | Actual SDK key derivation for public 0x11 seed, exact expected text, native decode |

Local resolution creates no cloud transport or transaction factory. Temporary
Ed25519 secret bytes are cleared. Aleo performs one bounded initialization worker
invocation, then caches only public bytes. The existing worker initializes its
SDK VM before key-address derivation; this is not a minimal key-only VM ABI. The
resolver sends no authorization, proof, program-addition or parameter-loading
command and constructs no destination factory or prover. The worker and
responses are retired before publication. No claim is made that SDK VM
initialization itself loads no built-in parameters.

AWS/GCP signer resolution uses existing public-key SDK methods and a
signer-scoped credential Manager. One lazy auth-only curl client and bounded
HTTP owner is allowed for configured remote signers. It creates no Pool or
background thread, and never changes the read-only chain replay transport.
Temporary DigestSigner, manager, credential state and auth transport are destroyed
after publication, failure, cancellation or deadline. Pending I/O preserves the
same attempt and aggregate deadline; the next pass supplies the current cancel
pointer. Both HTTP operations and ADC executable commands receive the remaining
attempt budget. Credential discovery is scoped to this signer, excluding
unrelated storage or other-chain identities. GCP RSA loading preserves an
explicit library path, then the provided environment override, then the existing
platform default; local keys never open it solely for metrics.

The common health monitor snapshots its wallet after successful provider begin,
once per cycle across pending I/O. This includes a newly resolved scraper wallet
in the first balance query without changing the two immediate startup passes or
subsequent Source cadence. Node lifecycle/integration is owned by the health-set
implementation and must retain teardown-after-join and first-wallet coverage.

| Verification                                          |                                                        Result | Evidence                       |
| ----------------------------------------------------- | ------------------------------------------------------------: | ------------------------------ |
| Complete configured-identity fixture suite            | 18 passed, 0 skipped (11 substantive cases plus import roots) | `identity-final.log.gz`        |
| Common monitor cadence, snapshots and native provider |                                                      7 passed | `health-snapshot-order.log.gz` |

The identity suite includes local identities for all eight protocols, AWS/GCP
public-key-only mocked transports, credential/public-key pending I/O, actual
signer-scoped Manager, cancellation cleanup and restart, aggregate deadline,
allocation-failure sweep, actual own-curl signed AWS GetPublicKey against a local
fixture server, and an injected ADC executable runner that checks timeout and
cancel propagation before HTTP. Tests read no production credentials, launch no
configured user commands and make no production requests. The AWS loopback uses
public dummy credentials. No test calls a remote signing operation.

These are correctness checks under concurrent development, not timing evidence.
Final before/after benchmarks require the shared source freeze and reproducible
whole-process harness.
