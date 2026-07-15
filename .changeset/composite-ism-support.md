---
'@hyperlane-xyz/sealevel-sdk': minor
'@hyperlane-xyz/provider-sdk': minor
'@hyperlane-xyz/deploy-sdk': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': patch
---

TS SDK and CLI support was added for the Sealevel-only Composite ISM program (`hyperlane-sealevel-composite-ism`), a single program that stores an entire ISM tree — `TrustedRelayer`, `MultisigMessageId`, `Aggregation`, `Test`, `Pausable`, `AmountRouting`, `RateLimited`, `Routing`, and `FallbackRouting` nodes — in one PDA, in place of the many separately-deployed ISM contracts EVM uses. `hyperlane core`/`hyperlane warp` `deploy`/`apply`/`read`/`check` now work with a `compositeIsm` config the same as any other ISM type, config-file (YAML/JSON) input only.

`@hyperlane-xyz/sdk` gained `IsmType.COMPOSITE` and a recursive `CompositeIsmNodeConfigSchema`/`CompositeIsmConfigSchema` mirroring the Rust CLI's config-file representation one-to-one; sub-nodes are inline Borsh data, not separate deployments, so only `routing`/`fallbackRouting.domains` (chain-name keyed, config-file-only) get diffed into per-domain instructions. The `ModuleType` enum was also fixed to use explicit values and gained `OP_L2_TO_L1`, `POLYMER`, and `COMPOSITE` members — it was previously auto-numbered and had silently drifted out of sync with `IInterchainSecurityModule.sol`'s enum, a pre-existing bug found while adding `COMPOSITE`.

`@hyperlane-xyz/provider-sdk` gained the Artifact-API mirror of the composite ISM tree (domain-ID keyed), a `mergeIsmArtifacts` branch that treats `compositeIsm` as self-diffing (skips the generic Artifact recursion since sub-nodes aren't independently addressed), and recursive chain-name/domain-ID conversion in `ismConfigToArtifact`/`ismArtifactToDerivedConfig`.

`@hyperlane-xyz/sealevel-sdk` gained the bulk of the new code: a hand-rolled Borsh codec for `IsmNode`/`CompositeIsmStorage`/`DomainIsmStorage` verified byte-for-byte against the Rust program's own serialization, PDA derivation for the shared VAM storage seed and per-domain seed, instruction builders for all seven mutating instructions, `SvmCompositeIsmReader`/`Writer`, a `detectIsmType()` probe, and the compiled program bytes embedded via the existing `program:build`/`program:generate` pipeline. `SvmCompositeIsmWriter.create()`'s `Initialize` call now passes `skipPreflight: true`, matching `SvmTestIsmWriter`'s existing workaround for a solana-test-validator race where preflight simulation can reject a just-deployed program with "Unsupported program id". A new `composite-ism.e2e-test.ts` exercises create/read, root updates, pause/unpause, ownership transfer, and routing-domain diffing end-to-end against a real local validator.

`@hyperlane-xyz/deploy-sdk` registered `compositeIsm` as a supported, mutable ISM type and wired its writer's `update()` into the generic `IsmWriter`.
