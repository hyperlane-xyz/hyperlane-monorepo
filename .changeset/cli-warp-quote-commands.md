---
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/sealevel-sdk": minor
"@hyperlane-xyz/provider-sdk": minor
---

Two new CLI commands for managing offchain-signed warp fee quotes were added: `hyperlane warp quote create` submits a transient (`--ttl=0`) or standing (`--ttl>0`) signed quote against a deployed `OffchainQuotedLinearFee` leaf on EVM or SVM, and `hyperlane warp quote read` enumerates the standing quotes stored on every supported chain in a warp route (or a single `--chain`), rendering bytes32 sentinels (`TARGET_ROUTER_NONE`, `DEFAULT_CROSS_COLLATERAL_ROUTER`, `WILDCARD_RECIPIENT`) as labels with ISO timestamps and an `expired` flag. The CLI bridges EVM and AltVM via a single `factories.ts` switch (EVM doesn't implement `ProtocolProvider`), shared by both commands. Underneath, `@hyperlane-xyz/sdk` adds `EvmQuoteArtifactManager` / `EvmQuoteWriter` / `EvmQuoteReader` / `EvmPrivateKeyQuoteSigner` against the EIP-712 typed-data layout plus a `buildFeeReadContextFromWarpDeployConfig` helper that bypasses AltVM token-type validation; `@hyperlane-xyz/sealevel-sdk` adds the equivalent `SvmQuote*` surface against the SVM fee-program's `SubmitQuote` instruction and exports `resolveFeeSalt`; `@hyperlane-xyz/provider-sdk` defines the cross-VM interfaces (`IRawWarpQuoteArtifactManager`, `RawQuoteSigner`, `enumerateWarpQuoteCandidates`).
