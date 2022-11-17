use tokio::task::JoinHandle;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use abacus_core::InterchainGasPaymasterIndexer;

use crate::{
    contract_sync::schema::InterchainGasPaymasterContractSyncDB, ContractSync, ContractSyncHelper,
};

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

        let mut sync_helper = {
            let config_initial_height = self.index_settings.from();
            let initial_height = db
                .retrieve_latest_indexed_gas_payment_block()
                .map_or(config_initial_height, |b| b + 1);
            ContractSyncHelper::new(
                indexer.clone(),
                self.index_settings.chunk_size(),
                initial_height,
            )
        };

        tokio::spawn(async move {
            let start_block = sync_helper.current_position();
            info!(from = start_block, "[GasPayments]: resuming indexer");
            indexed_height.set(start_block as i64);

            loop {
                let Ok((from, to)) = sync_helper.next_range().await else { continue };

                let gas_payments = indexer.fetch_gas_payments(from, to).await?;

                info!(
                    from,
                    to,
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
                indexed_height.set(to as i64);
            }
        })
        .instrument(span)
    }
}
