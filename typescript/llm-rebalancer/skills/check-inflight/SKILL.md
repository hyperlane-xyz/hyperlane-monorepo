---
name: check-inflight
description: Check for inflight transfers and rebalances that haven't completed yet
allowed-tools: bash read
---

# Check Inflight Actions

Checks pending actions from the action log and verifies their on-chain delivery status.

## Steps

1. **Read pending actions** from the action log:

   ```bash
   sqlite3 ./action-log.db "SELECT id, type, origin, destination, amount, message_id, status, created_at FROM actions WHERE status IN ('pending','in_progress') ORDER BY created_at"
   ```

2. **For each pending action with a message_id**, check if the Hyperlane message was delivered:

   ```bash
   cast call <destMailbox> 'delivered(bytes32)(bool)' <messageId> --rpc-url <destRpc>
   ```

   Look up the destination chain's mailbox address from `./rebalancer-config.json`.

3. **Update completed actions**:

   ```bash
   sqlite3 ./action-log.db "UPDATE actions SET status='completed', updated_at=datetime('now') WHERE id=<id>"
   ```

4. **Report summary**:
   - Number of still-pending actions
   - Total inflight amount per chain pair
   - Any actions older than expected (might indicate issues)

The inflight amounts MUST be subtracted from surplus calculations to avoid double-rebalancing.
