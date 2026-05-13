---
'@hyperlane-xyz/sdk': patch
---

The ERC-4626 vault collateral balance check was fixed to use vault.maxWithdraw() instead of wrappedToken().balanceOf(). For vault-based collateral contracts (EvmHypOwnerCollateral), the previous approach returned 0 because the contract holds vault shares rather than the underlying asset directly. This caused "Insufficient collateral on destination" errors blocking all outbound transfers.
