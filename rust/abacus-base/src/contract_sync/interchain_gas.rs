use std::cmp::min;
use std::time::Duration;

use tokio::{task::JoinHandle, time::sleep};
use tracing::{debug, info, info_span, instrument::Instrumented, Instrument};

use abacus_core::InterchainGasPaymasterIndexer;

use crate::{contract_sync::schema::InterchainGasPaymasterContractSyncDB, ContractSync};

const GAS_PAYMENTS_LABEL: &str = "gas_payments";

impl<I> ContractSync<I>
where
    I: InterchainGasPaymasterIndexer + Clone + 'static,
{
    /// Sync gas payments
    pub fn sync_gas_payments(&self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        let span = info_span!("GasPaymentContractSync");

        let db = self.db.clone();
        let indexer = self.indexer.clone();

        let indexed_height = self
            .metrics
            .indexed_height
            .with_label_values(&[GAS_PAYMENTS_LABEL, &self.chain_name]);

        let stored_messages = self
            .metrics
            .stored_events
            .with_label_values(&[GAS_PAYMENTS_LABEL, &self.chain_name]);

        let config_from = self.index_settings.from();
        let chunk_size = self.index_settings.chunk_size();

        tokio::spawn(async move {
            let mut from = db
                .retrieve_latest_indexed_gas_payment_block()
                .map_or_else(|| config_from, |b| b + 1);

            info!(from = from, "[GasPayments]: resuming indexer from {from}");

            loop {
                indexed_height.set(from.into());

                // Only index blocks considered final.
                // If there's an error getting the block number, just start the loop over
                let tip = if let Ok(num) = indexer.get_finalized_block_number().await {
                    num
                } else {
                    continue;
                };
                if tip <= from {
                    debug!(tip=?tip, from=?from, "[GasPayments]: caught up to tip, waiting for new block");
                    // Sleep if caught up to tip
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }

                let candidate = from + chunk_size;
                let to = min(tip, candidate);
                // Still search the full-size chunk size to possibly catch events that nodes have dropped "close to the tip"
                let full_chunk_from = to.checked_sub(chunk_size).unwrap_or_default();

                let gas_payments = indexer.fetch_gas_payments(full_chunk_from, to).await?;

                info!(
                    from = full_chunk_from,
                    to = to,
                    gas_payments_count = gas_payments.len(),
                    "[GasPayments]: indexed block range"
                );

                let mut new_payments_processed: u64 = 0;
                for gas_payment in gas_payments.iter() {
                    // Attempt to process the gas payment, incrementing new_payments_processed
                    // if it was processed for the first time.
                    if db.process_gas_payment(gas_payment)? {
                        new_payments_processed += 1;
                    }
                }

                stored_messages.inc_by(new_payments_processed);

                db.store_latest_indexed_gas_payment_block(to)?;
                from = to + 1;
            }
        })
        .instrument(span)
    }
}
