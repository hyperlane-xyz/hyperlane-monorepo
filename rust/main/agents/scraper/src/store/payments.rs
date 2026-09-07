use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;
use itertools::Itertools;
use tracing::debug;

use hyperlane_core::{
    HyperlaneLogStore, HyperlaneSequenceAwareIndexerStoreReader, Indexed, InterchainGasPayment,
    LogMeta, H512,
};

use crate::db::StorablePayment;
use crate::store::storage::{txn_id_for_meta, HyperlaneDbStore};

#[async_trait]
impl HyperlaneLogStore<InterchainGasPayment> for HyperlaneDbStore {
    /// Store interchain gas payments into the database.
    /// Payments whose transaction could not be resolved on-chain (zero block
    /// and transaction hashes, e.g. Sealevel basic log meta fallback) are
    /// stored with a NULL transaction relation; other unavailable transactions
    /// are skipped (and retried later).
    async fn store_logs(
        &self,
        payments: &[(Indexed<InterchainGasPayment>, LogMeta)],
    ) -> Result<u32> {
        if payments.is_empty() {
            return Ok(0);
        }
        let txns: HashMap<H512, i64> = self
            .ensure_blocks_and_txns(payments.iter().map(|r| &r.1))
            .await?
            .collect();
        let storable = payments
            .iter()
            .filter_map(|(payment, meta)| {
                txn_id_for_meta(&txns, meta).map(|txn_id| {
                    (
                        payment.inner(),
                        payment.sequence.map(|v| v as i64),
                        meta,
                        txn_id,
                    )
                })
            })
            .map(|(payment, sequence, meta, txn_id)| StorablePayment {
                payment,
                sequence,
                meta,
                txn_id,
            })
            .collect_vec();

        debug!(
            domain = self.domain.id(),
            interchain_gas_paymaster_address = ?self.interchain_gas_paymaster_address,
            ?storable,
            "storable payments",
        );

        let stored = self
            .db
            .store_payments(
                self.domain.id(),
                &self.interchain_gas_paymaster_address,
                &storable,
            )
            .await?;
        Ok(stored as u32)
    }
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<InterchainGasPayment> for HyperlaneDbStore {
    /// Gets a gas payment by sequence
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<InterchainGasPayment>> {
        let message = self
            .db
            .retrieve_payment_by_sequence(
                self.domain.id(),
                &self.interchain_gas_paymaster_address,
                sequence,
            )
            .await?;
        Ok(message)
    }

    /// Gets the block number at which the log occurred.
    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        self.db
            .retrieve_payment_block_number(
                self.domain.id(),
                &self.interchain_gas_paymaster_address,
                sequence,
            )
            .await
    }
}
