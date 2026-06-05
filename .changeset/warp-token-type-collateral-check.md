---
"@hyperlane-xyz/sdk": patch
"@hyperlane-xyz/cli": patch
---

Warp core configs preserved warp route deploy token types, and destination collateral checks were skipped for CCTP and OFT collateral routes that settle through their protocol bridge rather than on-chain escrow.

Existing CCTP and OFT registry routes require token type backfills in hyperlane-registry#1550 to use the exemption.
