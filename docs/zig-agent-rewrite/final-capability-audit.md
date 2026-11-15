# Final capability audit

The independent read-only audit found one confirmed production parity defect in runtime `8872c5e470f1a096f8cd32a3661d0d69c0a3aa0b` with fixtures `f7bdda8cf66a179a85e72c115c0f64cbea676fbb`: optional Sealevel CCS signer failure prevents ordinary destination initialization. All eight protocols have concrete runtime paths. Their validation layers differ, and the complete per-protocol native-node executable matrix is not established by the existing unit, SDK and controlled-transport tests.

The [full review](../../zig/bench/results/final-capability-audit-20261106/audit/review.md.gz) records callers, evidence, unsupported Rust boundaries and remaining acceptance work. This report preserves that historical snapshot while a separately owned correction proceeds. It does not describe later mutable source as the audited code.

## Confirmed defect

Rust `hyperlane-base/src/settings/chains.rs:447–464` warns and continues constructing the Sealevel mailbox when the optional CCS signer is absent or fails initialization. Without both reveal configuration and signer, `hyperlane-sealevel/src/mailbox.rs:739–741` declines duplicate-commit recovery and `:770–772` does not start a reveal child. Ordinary mailbox processing continues.

Zig `agents/relayer_task.zig:299–305` enables reveals when opening the native Factory. `agents/destination/factory.zig:161–166` then fails the whole destination on missing or failed CCS signer initialization. The remote variant can fail earlier: the credential Manager marks configured CCS signers as required and leases before Factory construction. Catching the final signer-construction error alone cannot isolate optional authentication failure.

Setting `enable_reveals=false` alone also does not preserve Rust behavior: recognized UR commits encounter `RevealQueueDisabled` in preparation or delivery callbacks. Closure requires role-equivalent missing/failed CCS tests, ordinary and UR-commit progress without new optional authentication/signatures, a valid-CCS positive case, mandatory payer failure isolation and preservation of already-owned child work. Existing direct reveal-runner fixtures supply a CCS signer and do not cover this constructor boundary.

The archive contains the relevant files read directly from Git at `f7bdda8c`, including Factory, Lane, credentials, reveal ownership and Rust comparison paths. Their bytes match the audit read set. No later source edit replaces these inputs.

## Capability and evidence layers

| Protocol      | Implemented runtime paths                                                                                       | Existing evidence identified                                                                          | Unclosed qualification                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Ethereum      | Concrete validator, EVM preparation/Lander, source indexing and scraper receipts                                | Actual Solidity/Anvil processes, PostgreSQL and Rust Rocks readback; strict process-stage diagnostics | Final complete exact-binary proofs and paired runs remain unaccepted |
| Sealevel      | Provider, versioned transactions, ALTs, fees/Jito, composite ISMs, generic validator, scraper, durable UR child | Solana SDK/Rust vectors, actual HTTP and Rocks recovery, composite and CCS fixtures                   | Optional CCS defect; no inspected full local-Solana three-role E2E   |
| Cosmos Wasm   | Tendermint/gRPC, Wasm query/execute, DIRECT signing, generic validator and scraper                              | SDK vectors and controlled native HTTP/2, receipt and storage tests                                   | Local wasmd daemon acceptance not established                        |
| Cosmos Native | Distinct native protobuf/query/mailbox/tree operations over shared transport                                    | Native codec/query, transaction-ID and signed-storage tests                                           | Local native-module daemon acceptance not established                |
| Starknet      | Account V3, scalar/group submission, shared nonce journal, generic validator and scraper                        | Actual Stark SDK; real Rocks atomic crash/reopen, control, fee and full-width nonce tests             | Controlled RPC does not establish devnet execution                   |
| Radix         | Core/Gateway, SBOR/manifests/signatures, generic validator, source and receipts                                 | Independent SDK intent and controlled wire/finality/storage tests                                     | Local Radix full-role E2E not established                            |
| Aleo          | Native crypto/VM, REST mapping/block events, authorization and local/delegated proving                          | Actual SDK proofs, worker sandbox/resource tests and controlled REST/prover fixtures                  | Real proving is distinct from complete live-node agent acceptance    |
| Tron          | Wallet/solidity, protobuf/raw transaction identity, KMS, generic validator and scraper                          | Actual native HTTP/Rocks recovery; generic Role bridged to Anvil                                      | The bridge explicitly does not validate Tron consensus or execution  |

Shared capabilities have concrete callers: local/AWS/GCP signing and ambient credentials; file/S3/GCS checkpoint objects; Rocks/WAL and PostgreSQL storage; bounded supervisors and metadata owners; admin/public interfaces; recursive metadata; UR queues and recovery. The full review separates mocks, independent vectors, native SDKs, actual sockets/databases and local-chain process runs. No live cloud credentials or production state were used. Aggregate suite counts overlap and are not summed as unique coverage.

The old architecture review described an early in-memory kernel. Its absent durable history, mixed-height quorum, publication, ethers-compatible recovery, Rocks, PG and cloud paths cannot be carried forward as current missing implementations without reading their replacements. Conversely, the existence of concrete methods is not full behavioral acceptance.

Rust-unsupported aggregation variants, non-Ethereum/Tron CCIP paths and unsupported metadata module types remain explicit refusals. Rust Lander placeholders do not remove working classic mailbox paths, including Starknet batching. A preliminary Radix/Aleo index-mode concern was not promoted to a finding: the actual Rust parser defaults to block mode, and its sequence-aware counters alone do not prove working forced sequence-range behavior. No new indexing feature is justified by that preliminary scan.

## V6 was intentionally interrupted

Root sent SIGINT to the precise active launcher PID `35142` after confirming the independent CCS defect. The [coordination receipt](../../zig/bench/results/final-capability-audit-20261106/interruption/root-coordination-receipt.json.gz) explicitly attributes this retrospective record to Root; it is separate from raw process telemetry. The shell session `70001` joined with status `130`.

The [raw proof](../../zig/bench/results/final-capability-audit-20261106/interruption/raw-proof.json.gz) remains `passed=false`, with `KeyboardInterrupt` and no completed stage. The [launcher completion](../../zig/bench/results/final-capability-audit-20261106/interruption/completion.json.gz) records exit `1`, the same error and unchanged source/artifacts. All 764 distinct pinned inputs match; its 767 input records include the three role/worker descriptors repeated at the launch boundary.

This grants **zero completed proof or 600-second-hold credit**. It is not evidence of a confirmation-policy failure or a crashed role. The old V6 plan, paired preparation, approved attestation and command metadata are preserved and ineligible for final acceptance after the newly confirmed production mismatch. No actual paired benchmark ran.

The stopped fixture remains local. The archive copies public configurations, launch audit/stdout, partial result and plain role/Rocks `LOG` text. Binary DB files, WAL, locks and other durable state were neither copied nor deleted.

## Historical SDK image and archive

The [f7 Linux image archive](../../zig/bench/results/container-fixtures-20261106-f7bdda8c/README.md) records successful feature checks for image prefix `087a73ce8850`: actual Aleo 75/75, Starknet 44/44, regex 9/9, HTTP/2 43/43, baked-worker framing and role/PG lifecycle checks. It explicitly marks the image historical after the CCS defect reopened production acceptance. Those successful features remain evidence; they are not approval of the missing degradation behavior or a future corrected image.

The [audit manifest](../../zig/bench/results/final-capability-audit-20261106/manifest.json) binds 42 deterministic lossless gzip files, including the exact review/result, 22 historical Git files, preparation descriptors, interruption diagnostics and SDK references. The [verification](../../zig/bench/results/final-capability-audit-20261106/verification.json) records 403,922 compressed bytes, decoded/packed hash and length checks, original-input preservation and matching historical Git bytes.

Next acceptance needs the scoped production correction and independent review, a newly frozen runtime with matching builds/images, the promised per-protocol evidence closure and six complete strict process proofs before paired timing. This audit makes no rewrite-complete, deployment, mainnet-tracking or performance claim.
