use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{
    unwrap_or_none_result, Delivery, HyperlaneLogStore, HyperlaneSequenceAwareIndexerStoreReader,
    Indexed, LogMeta, H512,
};
use tracing::warn;

use crate::db::{StorableDelivery, StorableDestinationHyperswap};
use crate::hyperswap::decode_destination_hyperswap_from_process_with_logs;
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
            })
            .collect::<Vec<_>>();

        let stored = self
            .db
            .store_deliveries(
                self.domain.id(),
                self.mailbox_address,
                storable.clone().into_iter(),
            )
            .await?;
        self.store_destination_hyperswaps(&storable).await?;
        Ok(stored as u32)
    }
}

impl HyperlaneDbStore {
    async fn store_destination_hyperswaps(
        &self,
        deliveries: &[StorableDelivery<'_>],
    ) -> Result<()> {
        for delivery in deliveries {
            let tx_info = match self.fetch_txn_info(&delivery.meta.transaction_id).await {
                Ok(tx_info) => tx_info,
                Err(err) => {
                    warn!(
                        tx_hash = ?delivery.meta.transaction_id,
                        ?err,
                        "skipping hyperswap destination enrichment: failed to fetch transaction"
                    );
                    continue;
                }
            };
            let Some(raw_input_data) = tx_info.raw_input_data.as_deref() else {
                continue;
            };
            let logs = tx_info
                .receipt
                .as_ref()
                .and_then(|receipt| receipt.logs.as_deref())
                .unwrap_or(&[]);
            let Some(destination) =
                decode_destination_hyperswap_from_process_with_logs(raw_input_data, logs)
            else {
                continue;
            };
            self.db
                .update_destination_hyperswap_by_reveal_message_id(
                    delivery.message_id,
                    StorableDestinationHyperswap {
                        destination,
                        destination_tx_id: delivery.txn_id,
                    },
                )
                .await?;
        }
        Ok(())
    }
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<Delivery> for HyperlaneDbStore {
    /// Gets a delivered message by its sequence.
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<Delivery>> {
        let delivery = self
            .db
            .retrieve_delivery_by_sequence(self.domain.id(), &self.mailbox_address, sequence)
            .await?;
        Ok(delivery)
    }

    /// Gets the block number at which the log occurred.
    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        let tx_id = unwrap_or_none_result!(
            self.db
                .retrieve_delivered_message_tx_id(self.domain.id(), &self.mailbox_address, sequence)
                .await?
        );
        let block_id = unwrap_or_none_result!(self.db.retrieve_block_id(tx_id).await?);
        Ok(self.db.retrieve_block_number(block_id).await?)
    }
}
