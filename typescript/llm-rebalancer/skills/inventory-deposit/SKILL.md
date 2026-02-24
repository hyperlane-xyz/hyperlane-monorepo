---
name: inventory-deposit
description: Deposit inventory tokens into a warp route via the bridge to increase collateral on a deficit chain
allowed-tools: bash read write
---

# Inventory Deposit

Deposits tokens from the rebalancer's own inventory into a warp route **via the bridge**.
Unlike `warp.rebalance()` (which moves collateral warp→warp), this calls the bridge directly
so the rebalancer's own wallet funds the deposit.

## When to Use

- An asset is **DEPLETED** (totalBalance=0) — `warp.rebalance()` fails because no warp has collateral
- The rebalancer has the asset in its wallet (check `get_inventory`)

## Steps

1. **Find a chain where the rebalancer has the asset** (via `get_inventory`).

2. **Look up addresses** from `get_chain_metadata`:
   - `bridge` address on the SOURCE chain (where rebalancer has tokens). For multi-asset, use `assets.<SYMBOL>.bridge`.
   - `collateralToken` on the source chain. For multi-asset, use `assets.<SYMBOL>.collateralToken`.
   - `warpToken` on the DESTINATION chain (where collateral is needed). For multi-asset, use `assets.<SYMBOL>.warpToken`.
   - `domainId` of the destination chain.

3. **Approve the bridge** to spend the rebalancer's collateral:

   ```bash
   cast send <collateralToken> 'approve(address,uint256)' <sourceBridge> <amountWei> \
     --account rebalancer --password '' --rpc-url <sourceRpc>
   ```

4. **Call bridge.transferRemote** with the destination warp token as recipient:

   ```bash
   # Pad the warp token address to bytes32 (left-pad with zeros to 66 chars)
   WARP_BYTES32=$(cast --to-bytes32 <destWarpToken>)

   cast send <sourceBridge> 'transferRemote(uint32,bytes32,uint256)' \
     <destDomainId> $WARP_BYTES32 <amountWei> \
     --account rebalancer --password '' --rpc-url <sourceRpc>
   ```

5. **Extract messageId** from the transaction logs and save context for delivery verification.

## How It Works

- The bridge pulls collateral from the rebalancer (not the warp token)
- On delivery, the bridge mints new collateral to the destination warp token
- The warp token's collateral balance increases, allowing pending transfers to complete
- The rebalancer's wallet balance decreases (cost of restocking depleted liquidity)

## Amount Calculation

Calculate the total needed: sum ALL pending transfer amounts that need this asset on the destination chain.
Deposit the **full amount** needed, not just a fraction.

## Important

- This goes through the Hyperlane message system — there is a delivery delay
- The bridge on the source chain must be enrolled with the destination bridge (it already is in standard deployments)
- For multi-asset deployments, each asset has its own bridge — use the correct one
