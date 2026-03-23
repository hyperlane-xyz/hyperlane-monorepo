---
'@hyperlane-xyz/core': minor
---

Offchain fee quoting was added to InterchainGasPaymaster via AbstractOffchainQuoter inheritance. OffchainQuotedLinearFee was added as a new ITokenFee implementation for warp route fees. QuotedCalls command-based router was added for atomic quote submission with Permit2 and transient approvals. Solc was bumped to 0.8.28 with Cancun EVM target for transient storage support.
