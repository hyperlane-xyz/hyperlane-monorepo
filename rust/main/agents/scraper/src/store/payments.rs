use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;
use itertools::Itertools;
use tracing::debug;

use hyperlane_core::{
    unwrap_or_none_result, HyperlaneLogStore, HyperlaneSequenceAwareIndexerStoreReader, Indexed,
    InterchainGasPayment, LogMeta, H512,
};

use crate::db::StorablePayment;
use crate::store::storage::HyperlaneDbStore;

#[async_trait]
impl HyperlaneLogStore<InterchainGasPayment> for HyperlaneDbStore {
    /// Store interchain gas payments into the database.
    /// We store only interchain gas payments from blocks and transaction which we could
    /// successfully insert into database.
    async fn store_logs(
        &self,
        payments: &[(Indexed<InterchainGasPayment>, LogMeta)],
    ) -> Result<u32> {
        if payments.is_empty() {
            return Ok(0);
        }
        let txns: HashMap<H512, crate::store::storage::TxnWithId> = self
            .ensure_blocks_and_txns(payments.iter().map(|r| &r.1))
            .await?
            .map(|t| (t.hash, t))
            .collect();
        let storable = payments
            .iter()
            .filter_map(|(payment, meta)| {
                txns.get(&meta.transaction_id).map(|txn| {
                    (
                        payment.inner(),
                        payment.sequence.map(|v| v as i64),
                        meta,
                        txn.id,
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
        let tx_id = unwrap_or_none_result!(
            self.db
                .retrieve_payment_tx_id(
                    self.domain.id(),
                    &self.interchain_gas_paymaster_address,
                    sequence,
                )
                .await?
        );
        let block_id = unwrap_or_none_result!(self.db.retrieve_block_id(tx_id).await?);
        Ok(self.db.retrieve_block_number(block_id).await?)
    }
}
