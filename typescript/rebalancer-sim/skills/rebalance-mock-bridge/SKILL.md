---
name: rebalance-mock-bridge
description: Rebalance via MockValueTransferBridge (simulation only)
allowed-tools: bash read write
---

# Rebalance via MockValueTransferBridge

For simulation environments only. Calls `rebalance()` on the source chain's warp token, which routes through the MockValueTransferBridge.

## Steps

1. **Get chain metadata** via `get_chain_metadata` tool for addresses and RPC URLs.

2. **Look up the bridge address** from the metadata. For multi-asset deployments, use the asset-specific bridge from `assets.<SYMBOL>.bridge` on the source chain. For single-asset, use the chain-level `bridge` field.

3. **Execute rebalance** (see `submit-transaction` skill for signing):

   ```bash
   cast send <sourceWarpToken> 'rebalance(uint32,uint256,address)' \
     <destDomainId> <amountWei> <bridgeAddress> \
     --account rebalancer --password '' \
     --rpc-url <sourceRpc>
   ```

4. **Extract messageId** from the DispatchId event (see `submit-transaction` skill for receipt parsing):

   ```bash
   cast receipt <txHash> --rpc-url <sourceRpc> --json | jq -r '.logs[] | select(.topics[0] == "0x788dbc1b7152732178210e7f4d9d010ef016f9eafbe66786bd7169f56e0c353a") | .topics[1]'
   ```

5. **Verify delivery** using `check_hyperlane_delivery` tool with the messageId and destination chain.

6. **Save context**: Record messageId, amount, source→dest, bridge type in `save_context` summary.
