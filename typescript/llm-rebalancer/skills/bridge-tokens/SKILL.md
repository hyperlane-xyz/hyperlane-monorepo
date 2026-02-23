---
name: bridge-tokens
description: Move inventory tokens between chains via external bridge (LiFi) or mock bridge in simulation
allowed-tools: bash read write
---

# Bridge Tokens

Moves the rebalancer's own tokens between chains using an external bridge.
Use this when you need inventory on a chain where you don't have enough.

> For transaction signing and receipt parsing, see the `submit-transaction` skill.

## Bridge Selection Strategy

| Bridge                  | When to Use             | Delivery                        |
| ----------------------- | ----------------------- | ------------------------------- |
| MockValueTransferBridge | Simulation only         | `check_hyperlane_delivery` tool |
| LiFi                    | Production, cross-chain | Poll LiFi status API            |
| CEX                     | Large amounts           | Manual verification             |

## Simulation Mode (MockValueTransferBridge)

In simulation, bridges are mock contracts. Use `get_chain_metadata` tool for addresses.

1. **Approve the bridge to spend collateral**:

   ```bash
   cast send <collateralToken> 'approve(address,uint256)' <bridgeAddress> <amountWei> \
     --account rebalancer --password '' --rpc-url <rpc>
   ```

2. **Execute bridge transfer**:

   ```bash
   cast send <bridgeAddress> 'transferRemote(uint32,bytes32,uint256)' <destDomainId> <recipientBytes32> <amountWei> \
     --account rebalancer --password '' --rpc-url <rpc>
   ```

   Convert recipient to bytes32: `cast --to-bytes32 <rebalancerAddress>`

3. **Extract messageId** from Dispatch event (see `submit-transaction` skill).

4. **Save context**: Record messageId, amount, source/dest so next invocation can verify via `check_hyperlane_delivery`.

## Production Mode (LiFi API)

See the `rebalance-lifi` skill for LiFi quote + execution flow.
