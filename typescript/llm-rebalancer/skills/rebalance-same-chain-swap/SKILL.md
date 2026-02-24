---
name: rebalance-same-chain-swap
description: Swap between assets on the same chain via MultiCollateral transferRemoteTo
allowed-tools: bash read write
---

# Same-Chain Asset Swap

Swaps between two different assets on the same chain using `MultiCollateral.transferRemoteTo()`.
This calls `handle()` directly (same-chain destination = local domain), so it is **atomic** — no Hyperlane message, no bridge delay.

Use this when a chain has surplus of one asset but deficit of another.

> For transaction signing, see the `submit-transaction` skill.

## Steps

1. **Get chain metadata** via `get_chain_metadata` tool. Identify:
   - `sourceWarpToken`: the warp token of the asset you want to swap FROM
   - `targetWarpToken`: the warp token of the asset you want to swap TO
   - `sourceCollateral`: the collateral token of the source asset
   - `localDomainId`: the domain ID of this chain
   - `rpcUrl`: the chain's RPC URL

2. **Approve source collateral to source warp token**:

   ```bash
   cast send <sourceCollateral> 'approve(address,uint256)' <sourceWarpToken> <amountWei> \
     --account rebalancer --password '' --rpc-url <rpcUrl>
   ```

3. **Execute same-chain swap** via `transferRemoteTo`:

   ```bash
   cast send <sourceWarpToken> 'transferRemoteTo(uint32,bytes32,uint256,bytes32)' \
     <localDomainId> \
     $(cast --to-bytes32 <rebalancerAddress>) \
     <amountWei> \
     $(cast --to-bytes32 <targetWarpToken>) \
     --account rebalancer --password '' --rpc-url <rpcUrl>
   ```

   This is atomic — the swap completes in the same transaction.

4. **Save context**: Note the swap completed (no messageId needed since it's atomic). Record source/dest assets, amount, chain.
