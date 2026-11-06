# Radix adapter

Production sources: `rust/main/chains/hyperlane-radix`, Radix SDK `0ff82f3ba44cd848d178b5b3ec780ea43ea03bba`, Core/Gateway clients `2d284dad4ef48cab302cfa0435c548b54923b7e1`.

Implemented in Zig:

- Bounded Manifest/Scrypto SBOR traversal and typed Hyperlane argument/output codecs. Bech32m network addresses and Blake2b public-key account derivation.
- The exact production V2 agent transaction model: one root intent; no child subintents, blobs, transaction message or extra signers; Ed25519 notary is signatory. Epoch window +2, discriminator and tip bind the intent. Manifest lock-fee/process calls, preview, signed-intent and notarized bytes; per-field/domain-separated hashes; explicit notary injection. Signing revalidates all prepared bytes and hash metadata.
- Core `/status/network-status`, `/transaction/call-preview`; Gateway status, compiled preview-v2, committed-details, status, explicit submit and ascending stream pages. Historical state binding, configured network checks, bounded responses, exact endpoint prefixes/query strings/custom headers. Native HTTP supports private configured Core endpoints through explicit shared libcurl transport.
- Typed mailbox/ISM/routing/multisig/Merkle-tree/announcement reads. Programmatic-SBOR dispatch, delivery, insertion and gas events validate emitter and field schemas. Gas converts Decimal attos to whole units; payment retains attos.
- Read-only process preparation resolves at most five visible component dependencies through preview, then locks the source's total four fee categories multiplied by 1.5. An unsuccessful or nonconvergent preview fails. Transaction expiry requires reconciliation; it never proves nondelivery.

Fixtures and evidence:

- 14 SDK transaction cases, payload sizes 0..1024 crossing length/hash-block boundaries. Exact args/instructions/intent/preview/signed-intent/notarization bytes and four hash layers. Every truncated notarized fixture rejects.
- SDK-derived Core/Gateway request bodies exercised over real localhost HTTP; SDK-derived typed Scrypto responses checked for Merkle/quorum/announcement schemas.
- 16 SDK crypto cases: independent Blake2b, Ed25519 signatures/public keys and secp256k1 signatures/account derivation. `fixtures/crypto-differential.json` records 32 Zig signatures accepted by actual production Radix SDK and 64 altered digests/signatures rejected. No runtime Rust library is used.

Regenerate fixtures:

```sh
python3 zig/tools/fixture_pack.py restore-locks
cargo +1.98.0 run --manifest-path zig/src/radix/reference/Cargo.toml --locked --offline --quiet > zig/src/radix/fixtures/sdk.json
cargo +1.98.0 clippy --manifest-path zig/src/radix/reference/Cargo.toml --locked --offline -- -D warnings
zig test zig/src/root.zig -lc --test-filter radix
zig build-exe zig/src/radix/crypto_cli.zig -lc -femit-bin=/tmp/ziggy-radix-crypto
python3 zig/src/radix/reference/crypto_differential.py --zig-executable /tmp/ziggy-radix-crypto --report zig/src/radix/fixtures/crypto-differential.json
```

Use the pinned Zig wrapper/SDK flags documented in `zig/README.md` on macOS. `crypto_cli.zig` is test-only.

Remaining integration: durable stream pagination/cursors/reorg reconciliation, multi-chain agent scheduler, receipt enrichment and production endpoint qualification. No production endpoint/key/broadcast was accessed. This adapter alone is not a full Radix agent cutover. Generic V2 subintent transactions, encrypted messages and manifest text parsing are outside the production agent model implemented here and are not exposed as supported constructors. Secp256k1 crypto is independently checked; the production signer path here remains Ed25519 as in Rust.
