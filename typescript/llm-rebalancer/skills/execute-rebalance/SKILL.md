---
name: execute-rebalance
description: Execute on-chain rebalance via MovableCollateralRouter.rebalance()
allowed-tools: bash read write
---

# Execute On-Chain Rebalance

Moves collateral between chains using the warp token's built-in rebalance function.
The bridge contract must be pre-configured on the warp token.

## Signing

All `cast send` commands use the foundry keystore:

```bash
--account rebalancer --keystore-dir ./keystore --password ''
```

**Do NOT use `--private-key`.** See the `wallet-setup` skill for details.

## Bridge Taxonomy

| Bridge Type             | Contract      | Delivery Check                  |
| ----------------------- | ------------- | ------------------------------- |
| MockValueTransferBridge | Sim only      | `check_hyperlane_delivery` tool |
| CCTP                    | Circle bridge | Check CCTP attestation via API  |
| OFT                     | LayerZero OFT | Check LZ message status         |
| DEX                     | On-chain swap | Immediate (same-chain)          |

## Steps

1. **Get chain metadata** using `get_chain_metadata` tool for addresses and RPC URLs. Or read `./rebalancer-config.json` directly.

2. **Look up the bridge address** for the source→destination route from `rebalancer-config.json`. The `bridge` field in each chain's config is the bridge address to pass to `rebalance()`.

3. **Execute rebalance**:

   ```bash
   cast send <sourceWarpToken> 'rebalance(uint32,uint256,address)' <destDomainId> <amountWei> <bridgeAddress> \
     --account rebalancer --keystore-dir ./keystore --password '' --rpc-url <sourceRpc>
   ```

4. **Parse the transaction receipt** for the Dispatch event to get the messageId:

   ```bash
   cast receipt <txHash> --rpc-url <sourceRpc> --json | jq '.logs[] | select(.topics[0] == "0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814") | .topics[1]'
   ```

   The Dispatch event topic0 is `0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814`.

5. **Include in save_context summary**: Record the messageId, amount, source/dest chains, and bridge type so the next invocation can verify delivery via `check_hyperlane_delivery` or the bridge-specific method.
