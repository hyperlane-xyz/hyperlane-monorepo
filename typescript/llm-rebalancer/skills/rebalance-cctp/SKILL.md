---
name: rebalance-cctp
description: Rebalance via CCTP bridge (production)
allowed-tools: bash read write
---

# Rebalance via CCTP Bridge

For production CCTP (Circle) bridges. Calls `rebalance()` on the source chain's warp token with the CCTP bridge address.

## Steps

1. **Get chain metadata** via `get_chain_metadata` tool for addresses and RPC URLs.

2. **Look up the CCTP bridge address** from the source chain's `bridge` field.

3. **Execute rebalance** (see `submit-transaction` skill for signing):

   ```bash
   cast send <sourceWarpToken> 'rebalance(uint32,uint256,address)' \
     <destDomainId> <amountWei> <cctpBridgeAddress> \
     --account rebalancer --password '' \
     --rpc-url <sourceRpc>
   ```

4. **Extract messageId** from the Dispatch event (see `submit-transaction` skill for receipt parsing).

5. **Verify delivery** — CCTP uses Circle attestation, not Hyperlane delivery:

   ```bash
   # Get the CCTP message hash from tx logs
   # Poll Circle attestation API:
   curl -s "https://iris-api.circle.com/attestations/<messageHash>"
   ```

   Check `status` field — `complete` means attested and ready for claim.

6. **Save context**: Record messageId, CCTP message hash, amount, source→dest in `save_context`.
