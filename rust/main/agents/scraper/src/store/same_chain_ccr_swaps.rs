use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;
use tracing::{debug, warn};

use hyperlane_core::{HyperlaneLogStore, Indexed, LogMeta, SameChainCcrSwap, H512};

use crate::db::StorableCcrSwap;
use crate::store::storage::{ensure_event_enrichment_complete, HyperlaneDbStore};

#[async_trait]
impl HyperlaneLogStore<SameChainCcrSwap> for HyperlaneDbStore {
    async fn store_logs(&self, swaps: &[(Indexed<SameChainCcrSwap>, LogMeta)]) -> Result<u32> {
        if swaps.is_empty() {
            return Ok(0);
        }
        let txns: HashMap<H512, i64> = self
            .ensure_blocks_and_txns(swaps.iter().map(|r| &r.1))
            .await?
            .collect();

        // Persist resolvable siblings before rejecting an incomplete range.
        // Retries are idempotent by the transaction/log-derived synthetic ID.
        let storable: Vec<_> = swaps
            .iter()
            .filter_map(|(swap, meta)| {
                let txn = txns.get(&meta.transaction_id);
                if txn.is_none() {
                    warn!(
                        tx_hash = ?meta.transaction_id,
                        "deferring CCR swap without transaction metadata"
                    );
                }
                txn.map(|t| StorableCcrSwap {
                    swap: swap.inner(),
                    meta,
                    txn_id: *t,
                })
            })
            .collect();

        debug!(domain = self.domain.id(), ?storable, "storable CCR swaps");

        let stored = self
            .db
            .store_ccr_swaps_as_messages(self.domain.id(), &storable)
            .await?;
        ensure_event_enrichment_complete(&txns, swaps.iter().map(|r| &r.1))?;
        Ok(stored as u32)
    }
}
