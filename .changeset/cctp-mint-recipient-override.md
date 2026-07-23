---
"@hyperlane-xyz/core": minor
"@hyperlane-xyz/sdk": minor
"@hyperlane-xyz/cli": minor
---

A `cctpMintRecipientOverrides` mapping and `setCctpMintRecipientOverride` setter were added to `TokenBridgeCctpBase`, letting an EVM CCTP route redirect Circle's `mintRecipient` to a fixed address instead of the transfer's own recipient. This closes a gap where a Solana recipient who had never held the route's USDC mint before would fail to receive funds, since Circle's own program requires `mint_recipient` to already be an initialized token account and never creates one. The paired `hyperlane-sealevel-token-cctp` Solana program now mints into a program-controlled vault (its `ata_payer` PDA's own ATA, always created on demand) and forwards the funds on to the real recipient's ATA in the same transaction, creating that ATA on demand too. `EvmWarpModule` auto-derives and sets this override for enrolled Sealevel remote routers during `hyperlane warp apply`, with no manual config field needed.
