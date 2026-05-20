use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;
use itertools::Itertools;
use tracing::debug;

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

        let storable = swaps
            .iter()
            .filter_map(|(swap, meta)| {
                txns.get(&meta.transaction_id).map(|txn| StorableCcrSwap {
                    swap: swap.inner(),
                    meta,
                    txn_id: txn.id,
                })
            })
            .collect_vec();

        debug!(domain = self.domain.id(), ?storable, "storable CCR swaps");

        let stored = self
            .db
            .store_ccr_swaps_as_messages(self.domain.id(), &storable)
            .await?;
        Ok(stored as u32)
    }
}
