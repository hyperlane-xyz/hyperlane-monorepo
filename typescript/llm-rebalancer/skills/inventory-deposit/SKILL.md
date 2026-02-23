---
name: inventory-deposit
description: Deposit inventory tokens into a warp route to increase collateral on a deficit chain
allowed-tools: bash read write
---

# Inventory Deposit

Deposits tokens from the rebalancer's own inventory into a warp route.
**Direction is REVERSED**: to fill a deficit on chainB, you call `transferRemote` FROM chainB
(sending tokens to the destination chain where they'll be locked as collateral).

## Steps

1. **Read config** from `./rebalancer-config.json`.

2. **Check inventory balance** on the deficit chain:

   ```bash
   cast call <collateralToken> 'balanceOf(address)(uint256)' <rebalancerAddress from config> --rpc-url <rpc>
   ```

   Abort if insufficient balance.

3. **Approve the warp token to spend collateral**:

   ```bash
   cast send <collateralToken> 'approve(address,uint256)' <warpToken> <amountWei> --private-key <rebalancerKey from config> --rpc-url <rpc>
   ```

4. **Execute transferRemote** from the deficit chain:

   ```bash
   cast send <warpToken> 'transferRemote(uint32,bytes32,uint256)' <destDomainId> <recipientBytes32> <amountWei> --private-key <rebalancerKey from config> --rpc-url <rpc>
   ```

   The recipient should be the rebalancer address padded to bytes32:

   ```bash
   cast --to-bytes32 <rebalancerAddress from config>
   ```

5. **Record in action log** using the manage-action-log skill:
   - type: 'inventory_deposit'
   - origin: deficit chain name (where transferRemote was called)
   - destination: surplus chain name
   - amount: wei string
   - tx_hash: transaction hash
   - status: 'pending'
