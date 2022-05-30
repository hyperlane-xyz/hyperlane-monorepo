use abacus_core::InterchainGasPaymasterIndexer;

use tokio::time::sleep;
use tracing::{info, info_span};
use tracing::{instrument::Instrumented, Instrument};

use std::cmp::min;
use std::time::Duration;

use crate::{contract_sync::schema::InterchainGasPaymasterContractSyncDB, ContractSync};

const GAS_PAYMENTS_LABEL: &str = "gas_payments";

impl<I> ContractSync<I>
where
    I: InterchainGasPaymasterIndexer + 'static,
{
    /// Sync gas payments
    pub fn sync_gas_payments(&self) -> Instrumented<tokio::task::JoinHandle<eyre::Result<()>>> {
        let span = info_span!("GasPaymentContractSync");

        let db = self.db.clone();
        let indexer = self.indexer.clone();

        let indexed_height = self.metrics.indexed_height.clone().with_label_values(&[
            GAS_PAYMENTS_LABEL,
            &self.chain_name,
            &self.agent_name,
        ]);

        let stored_messages = self.metrics.stored_events.clone().with_label_values(&[
            GAS_PAYMENTS_LABEL,
            &self.chain_name,
            &self.agent_name,
        ]);

        let config_from = self.index_settings.from();
        let chunk_size = self.index_settings.chunk_size();

        tokio::spawn(async move {
            let mut from = db
                .retrieve_latest_indexed_gas_payment_block()
                .map_or_else(|| config_from, |b| b + 1);

            info!(from = from, "[GasPayments]: resuming indexer from {}", from);

            loop {
                indexed_height.set(from.into());

                let tip = indexer.get_block_number().await?;
                if tip <= from {
                    // TODO: Make this configurable
                    // Sleep if caught up to tip
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }

                let candidate = from + chunk_size;
                let to = min(tip, candidate);

                let gas_payments = indexer.fetch_gas_payments(from, to).await?;

                info!(
                    from = from,
                    to = to,
                    gas_payments_count = gas_payments.len(),
                    "[GasPayments]: indexed block heights {}...{}",
                    from,
                    to
                );

                for gas_payment in gas_payments.iter() {
                    db.store_gas_payment(gas_payment)?;
                }
                stored_messages.add(gas_payments.len().try_into()?);

                db.store_latest_indexed_gas_payment_block(to)?;
                from = to + 1;
            }
        })
        .instrument(span)
    }
}
