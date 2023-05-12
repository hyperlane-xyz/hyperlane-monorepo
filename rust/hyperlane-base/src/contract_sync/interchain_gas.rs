use tracing::{debug, info, instrument};
use std::time::{Duration};

use hyperlane_core::{utils::fmt_sync_time, InterchainGasPaymasterIndexer, SyncBlockRangeCursor};
use tokio::time::sleep;

use crate::{
    contract_sync::{
        cursor::RateLimitedSyncBlockRangeCursor, schema::InterchainGasPaymasterContractSyncDB,
    },
    ContractSync,
};

const GAS_PAYMENTS_LABEL: &str = "gas_payments";

impl<I> ContractSync<I>
where
    I: InterchainGasPaymasterIndexer + Clone + 'static,
{
    /// Sync gas payments
    #[instrument(name = "GasPaymentContractSync", skip(self))]
    pub(crate) async fn sync_gas_payments(&self) -> eyre::Result<()> {
        let chain_name = self.domain.as_ref();
        let indexed_height = self
            .metrics
            .indexed_height
            .with_label_values(&[GAS_PAYMENTS_LABEL, chain_name]);
        let stored_messages = self
            .metrics
            .stored_events
            .with_label_values(&[GAS_PAYMENTS_LABEL, chain_name]);

        let cursor = {
            let config_initial_height = self.index_settings.from;
            let initial_height = self
                .db
                .retrieve_latest_indexed_gas_payment_block()
                .map_or(config_initial_height, |b| b + 1);
            RateLimitedSyncBlockRangeCursor::new(
                self.indexer.clone(),
                self.index_settings.chunk_size,
                initial_height,
            )
        };

        let mut cursor = cursor.await?;

        let start_block = cursor.current_position();
        info!(from = start_block, "Resuming indexer");
        indexed_height.set(start_block as i64);

        loop {
            let Ok(range) = cursor.next_range().await else { continue };
            // TODO: The cursor used by the IGP syncer should never return none, should it?
            if range.is_none() {
                // TODO: Define the sleep time from interval flag
                sleep(Duration::from_secs(5)).await;
            } else {
                let (from, to, eta) = range.unwrap();
                let gas_payments = self.indexer.fetch_gas_payments(from, to).await?;

                debug!(
                    from,
                    to,
                    // distance_from_tip = cursor.distance_from_tip(),
                    gas_payments_count = gas_payments.len(),
                    estimated_time_to_sync = fmt_sync_time(eta),
                    "Indexed block range"
                );

                let mut new_payments_processed: u64 = 0;
                for (payment, meta) in gas_payments.iter() {
                    // Attempt to process the gas payment, incrementing new_payments_processed
                    // if it was processed for the first time.
                    if self.db.process_gas_payment(*payment, meta)? {
                        new_payments_processed += 1;
                    }
                }

                stored_messages.inc_by(new_payments_processed);

                self.db.store_latest_indexed_gas_payment_block(from)?;
                indexed_height.set(to as i64);
            }
        }
    }
}
