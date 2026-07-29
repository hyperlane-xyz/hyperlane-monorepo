use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;
use tracing::{debug, warn};

use hyperlane_core::{HyperlaneLogStore, Indexed, LogMeta, SameChainCcrSwap, H512};

use crate::db::StorableCcrSwap;
use crate::store::storage::HyperlaneDbStore;

#[async_trait]
impl HyperlaneLogStore<SameChainCcrSwap> for HyperlaneDbStore {
    async fn store_logs(&self, swaps: &[(Indexed<SameChainCcrSwap>, LogMeta)]) -> Result<u32> {
        if swaps.is_empty() {
            return Ok(0);
        }
        let txns: HashMap<H512, crate::store::storage::TxnWithId> = self
            .ensure_blocks_and_txns(swaps.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();

        // filter_map mirrors the dispatch/payment store_logs pattern: if
        // ensure_blocks_and_txns silently dropped a txn (transient RPC fetch
        // failure), skip the swap rather than returning Err and stalling the
        // indexer in a tight retry loop for the same block range.
        let storable: Vec<_> = swaps
            .iter()
            .filter_map(|(swap, meta)| {
                let txn = txns.get(&meta.transaction_id);
                if txn.is_none() {
                    warn!(
                        tx_hash = ?meta.transaction_id,
                        "skipping CCR swap: txn not found in enriched map (transient RPC miss?)"
                    );
                }
                txn.map(|t| StorableCcrSwap {
                    swap: swap.inner(),
                    meta,
                    txn_id: t.id,
                })
            })
            .collect();

        debug!(domain = self.domain.id(), ?storable, "storable CCR swaps");

        let stored = self
            .db
            .store_ccr_swaps_as_messages(self.domain.id(), &storable)
            .await?;
        Ok(stored as u32)
    }
}
