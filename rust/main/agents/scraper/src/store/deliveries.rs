use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{Delivery, HyperlaneLogStore, Indexed, LogMeta, H512};

use crate::db::StorableDelivery;
use crate::store::storage::{HyperlaneDbStore, TxnWithId};

#[async_trait]
impl HyperlaneLogStore<Delivery> for HyperlaneDbStore {
    /// Store delivered message ids from the destination mailbox into the database.
    /// We store only delivered messages ids from blocks and transaction which we could successfully
    /// insert into database.
    async fn store_logs(&self, deliveries: &[(Indexed<Delivery>, LogMeta)]) -> Result<u32> {
        if deliveries.is_empty() {
            return Ok(0);
        }
        let txns: HashMap<H512, TxnWithId> = self
            .ensure_blocks_and_txns(deliveries.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();
        let storable = deliveries
            .iter()
            .filter_map(|(message_id, meta)| {
                txns.get(&meta.transaction_id).map(|txn| {
                    (
                        *message_id.inner(),
                        message_id.sequence.map(|v| v as i64),
                        meta,
                        txn.id,
                    )
                })
            })
            .map(|(message_id, sequence, meta, txn_id)| StorableDelivery {
                message_id,
                sequence,
                meta,
                txn_id,
            });

        let stored = self
            .db
            .store_deliveries(self.domain.id(), self.mailbox_address, storable)
            .await?;
        Ok(stored as u32)
    }
}
