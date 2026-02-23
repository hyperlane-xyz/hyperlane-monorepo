CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,           -- 'on_chain_rebalance', 'inventory_deposit', 'bridge_transfer'
  origin TEXT NOT NULL,         -- chain name
  destination TEXT NOT NULL,    -- chain name
  amount TEXT NOT NULL,         -- wei string
  asset TEXT,                   -- 'USDC', 'USDT', etc.
  tx_hash TEXT,
  message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'in_progress', 'completed', 'failed'
  error TEXT,
  metadata TEXT,                -- JSON blob for extra data
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_type ON actions(type);
