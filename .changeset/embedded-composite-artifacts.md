---
'@hyperlane-xyz/provider-sdk': major
'@hyperlane-xyz/deploy-sdk': major
'@hyperlane-xyz/sealevel-sdk': major
'@hyperlane-xyz/radix-sdk': minor
'@hyperlane-xyz/cosmos-sdk': minor
'@hyperlane-xyz/aleo-sdk': minor
'@hyperlane-xyz/starknet-sdk': minor
'@hyperlane-xyz/cli': minor
---

A fourth artifact state `EMBEDDED` was added to the provider-sdk artifact model to represent pre-deploy children whose lifecycle is owned by a composite parent rather than their own writer. Composite-artifact configs gained a `composition: 'embedded' | 'orchestrated'` discriminant via the new `WithComposition<>` helper, and `ArtifactReader` / `ArtifactWriter` were split into per-composition interfaces (`OrchestratedArtifactReader`/`Writer` and `EmbeddedArtifactReader`/`Writer`) that narrow on the `composition` literal carried by each implementation. The deploy-sdk orchestrators (`IsmReader`, `IsmWriter`, `RoutingIsmWriter`) now dispatch on `composition`: embedded-mode raw writers/readers receive the full subtree; orchestrated-mode reproduces the existing per-child walk. `DeployedIsmArtifact` was collapsed to `ArtifactDeployed<ConfigOnChain<IsmArtifactConfig, DeployedIsmAddress>, DeployedIsmAddress>` so post-deploy embedded children type-check as `ArtifactDeployed`, and a new pre-collapse `RawDeployedIsmArtifact` alias was introduced for the in-memory diff/conversion paths (`mergeIsmArtifacts`, `ismArtifactToDerivedConfig`) where children may still be `ArtifactNew` for partial redeploys. SVM was the first protocol to ship the embedded path: `SealevelRoutingMultisigReader` / `SealevelRoutingMultisigWriter` replaced the former `SvmMessageIdMultisigIsm{Reader,Writer}` classes — one multisig-ism program now manages all per-domain validator/threshold PDAs under a single `domainRoutingIsm` artifact. Other AltVM SDKs (radix, cosmos, aleo, starknet) and the CLI took a one-line `composition = 'orchestrated'` literal addition.
