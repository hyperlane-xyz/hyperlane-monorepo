---
name: bridge-tokens
description: Move inventory tokens between chains via external bridge (LiFi) or mock bridge in simulation
allowed-tools: bash read write
---

# Bridge Tokens

Moves the rebalancer's own tokens between chains using an external bridge.
Use this when you need inventory on a chain where you don't have enough.

## Simulation Mode (MockValueTransferBridge)

In simulation, bridges are mock contracts. Read `./rebalancer-config.json` for bridge addresses.

1. **Approve the bridge to spend collateral**:

   ```bash
   cast send <collateralToken> 'approve(address,uint256)' <bridgeAddress> <amountWei> --private-key <rebalancerKey from config> --rpc-url <rpc>
   ```

2. **Execute bridge transfer**:

   ```bash
   cast send <bridgeAddress> 'transferRemote(uint32,bytes32,uint256)' <destDomainId> <recipientBytes32> <amountWei> --private-key <rebalancerKey from config> --rpc-url <rpc>
   ```

   Recipient is the rebalancer address padded to bytes32.

3. **Record in action log** via manage-action-log skill:
   - type: 'bridge_transfer'
   - status: 'pending'

## Production Mode (LiFi API)

1. **Get quote**:

   ```bash
   curl -s 'https://li.quest/v1/quote?fromChain=<chainId>&toChain=<chainId>&fromToken=<addr>&toToken=<addr>&fromAmount=<wei>&fromAddress=<rebalancerAddr>'
   ```

2. **Execute the returned transaction** via `cast send`.

3. **Record in action log**.
