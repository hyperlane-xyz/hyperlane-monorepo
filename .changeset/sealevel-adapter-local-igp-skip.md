---
"@hyperlane-xyz/sdk": patch
---

The base Sealevel token adapter now skips the interchain gas (IGP) quote for same-domain (local) transfers, mirroring the cross-collateral adapter. Previously `quoteTransferGas` computed a non-zero IGP fee from `destination_gas` for a local destination, which surfaced as a spurious interchain gas fee in fee estimates (e.g. solana↔solana transfers) even though a local transfer sends no interchain message.
