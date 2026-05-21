---
"@hyperlane-xyz/sdk": patch
---

The EvmIcaTxSubmitter now dynamically estimates destination-chain handle() gas via estimateIcaHandleGas instead of relying on the 50k default, so the encoded gasLimit matches the IGP payment and is sufficient for multi-call ICA transactions.
