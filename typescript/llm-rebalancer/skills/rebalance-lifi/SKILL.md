---
name: rebalance-lifi
description: Rebalance via LiFi (production, off-chain bridge)
allowed-tools: bash read write
---

# Rebalance via LiFi

For production environments using LiFi as an off-chain bridge aggregator. LiFi finds the best route and returns a transaction to execute.

## Steps

1. **Get chain metadata** via `get_chain_metadata` tool for chain IDs, token addresses, and RPC URLs.

2. **Get a quote** from LiFi API:

   ```bash
   curl -s 'https://li.quest/v1/quote?fromChain=<chainId>&toChain=<chainId>&fromToken=<tokenAddr>&toToken=<tokenAddr>&fromAmount=<amountWei>&fromAddress=<rebalancerAddr>'
   ```

3. **Approve token spend** if required (check `quote.action.fromToken.address`):

   ```bash
   cast send <fromToken> 'approve(address,uint256)' <approvalAddress> <amountWei> \
     --account rebalancer --password '' \
     --rpc-url <sourceRpc>
   ```

4. **Execute the quote transaction** (see `submit-transaction` skill for signing):

   ```bash
   cast send <quote.transactionRequest.to> \
     --data <quote.transactionRequest.data> \
     --value <quote.transactionRequest.value> \
     --account rebalancer --password '' \
     --rpc-url <sourceRpc>
   ```

5. **Verify delivery** via LiFi status API:

   ```bash
   curl -s "https://li.quest/v1/status?txHash=<txHash>&bridge=<quote.tool>&fromChain=<chainId>&toChain=<chainId>"
   ```

   Poll until `status` is `DONE` or `FAILED`.

6. **Save context**: Record LiFi txHash, bridge tool, amount, source→dest in `save_context`.
