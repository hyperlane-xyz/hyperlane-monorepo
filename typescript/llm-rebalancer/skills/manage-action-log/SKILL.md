---
name: manage-action-log
description: Read and write the SQLite action log for crash recovery and inflight tracking
allowed-tools: bash read
---

# Action Log Management

The action log is a SQLite database at `./action-log.db` that tracks all rebalancer actions
for crash recovery and inflight deduction.

## Common Operations

### Read all pending actions

```bash
sqlite3 ./action-log.db "SELECT * FROM actions WHERE status IN ('pending','in_progress') ORDER BY created_at"
```

### Insert a new action

```bash
sqlite3 ./action-log.db "INSERT INTO actions (type, origin, destination, amount, asset, tx_hash, message_id, status, created_at) VALUES ('<type>', '<origin>', '<destination>', '<amountWei>', '<asset>', '<txHash>', '<messageId>', 'pending', datetime('now'))"
```

### Update action status to completed

```bash
sqlite3 ./action-log.db "UPDATE actions SET status='completed', updated_at=datetime('now') WHERE id=<id>"
```

### Update action status to failed

```bash
sqlite3 ./action-log.db "UPDATE actions SET status='failed', error='<error message>', updated_at=datetime('now') WHERE id=<id>"
```

### Read recent history

```bash
sqlite3 ./action-log.db "SELECT * FROM actions ORDER BY created_at DESC LIMIT 20"
```

### Get total inflight amount per destination

```bash
sqlite3 ./action-log.db "SELECT destination, SUM(CAST(amount AS INTEGER)) as total_inflight FROM actions WHERE status IN ('pending','in_progress') GROUP BY destination"
```

## Schema

The database is initialized with schema from `./schema/action-log.sql`.
Fields: id, type, origin, destination, amount (wei string), asset, tx_hash, message_id, status, error, metadata (JSON), created_at, updated_at.
