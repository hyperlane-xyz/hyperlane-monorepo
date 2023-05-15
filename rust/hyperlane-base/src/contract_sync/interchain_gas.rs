use std::{error::Error, time::Duration};
use tracing::{debug, info, instrument};

use hyperlane_core::{utils::fmt_sync_time, InterchainGasPaymasterIndexer, SyncBlockRangeCursor};
use tokio::time::sleep;

use crate::{contract_sync::cursor::RateLimitedSyncBlockRangeCursor, ContractSync};

const GAS_PAYMENTS_LABEL: &str = "gas_payments";

impl<I> ContractSync<I>
where
    I: InterchainGasPaymasterIndexer + Clone + 'static,
{
    /// Sync gas payments
    #[instrument(name = "GasPaymentContractSync", skip(self, cursor))]
    pub(crate) async fn sync_gas_payments(
        &self,
        mut cursor: Box<dyn SyncBlockRangeCursor>,
    ) -> eyre::Result<()> {
        let chain_name = self.domain.as_ref();
        let stored_payments = self
            .metrics
            .stored_events
            .with_label_values(&[GAS_PAYMENTS_LABEL, chain_name]);

        loop {
            let Ok(range) = cursor.next_range().await else { continue };
            // TODO: The cursor used by the IGP syncer should never return none, should it?
            if range.is_none() {
                // TODO: Define the sleep time from interval flag
                sleep(Duration::from_secs(5)).await;
            } else {
                let (from, to, _) = range.unwrap();
                debug!(from, to, "Looking for for gas payment(s) in block range");
                let payments = self.indexer.fetch_gas_payments(from, to).await?;

                info!(
                    from,
                    to,
                    num_payments = payments.len(),
                    "Found delivered message(s) in block range"
                );

                let stored = self.db.store_gas_payments(&payments).await?;
                stored_payments.inc_by(stored.into());
            }
        }
    }
}
