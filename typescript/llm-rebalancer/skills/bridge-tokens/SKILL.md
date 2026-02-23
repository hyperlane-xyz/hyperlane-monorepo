---
name: bridge-tokens
description: Move inventory tokens between chains via external bridge (LiFi) or mock bridge in simulation
allowed-tools: bash read write
---

# Bridge Tokens

Moves the rebalancer's own tokens between chains using an external bridge.
Use this when you need inventory on a chain where you don't have enough.

## Signing

All `cast send` commands use the foundry keystore:

```bash
--account rebalancer --keystore-dir ./keystore --password ''
```

**Do NOT use `--private-key`.** See the `wallet-setup` skill for details.

## Bridge Selection Strategy

| Bridge                  | When to Use                   | Delivery                        |
| ----------------------- | ----------------------------- | ------------------------------- |
| MockValueTransferBridge | Simulation only               | `check_hyperlane_delivery` tool |
| LiFi                    | Production, cross-chain       | Poll LiFi status API            |
| CEX                     | Large amounts, cost-sensitive | Manual verification             |

## Simulation Mode (MockValueTransferBridge)

In simulation, bridges are mock contracts. Use `get_chain_metadata` tool for addresses.

1. **Approve the bridge to spend collateral**:

   ```bash
   cast send <collateralToken> 'approve(address,uint256)' <bridgeAddress> <amountWei> \
     --account rebalancer --keystore-dir ./keystore --password '' --rpc-url <rpc>
   ```

2. **Execute bridge transfer**:

   ```bash
   cast send <bridgeAddress> 'transferRemote(uint32,bytes32,uint256)' <destDomainId> <recipientBytes32> <amountWei> \
     --account rebalancer --keystore-dir ./keystore --password '' --rpc-url <rpc>
   ```

   Recipient is the rebalancer address padded to bytes32.

3. **Include in save_context summary**: Record messageId (from Dispatch event), amount, source/dest so next invocation can verify via `check_hyperlane_delivery`.

## Production Mode (LiFi API)

1. **Get quote**:

   ```bash
   curl -s 'https://li.quest/v1/quote?fromChain=<chainId>&toChain=<chainId>&fromToken=<addr>&toToken=<addr>&fromAmount=<wei>&fromAddress=<rebalancerAddr>'
   ```

2. **Execute the returned transaction** via `cast send`.

3. **Include in save_context summary**: Record the LiFi transaction hash and bridge type for delivery verification.
