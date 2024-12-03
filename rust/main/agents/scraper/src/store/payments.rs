use std::collections::HashMap;

use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{HyperlaneLogStore, Indexed, InterchainGasPayment, LogMeta, H512};

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
            });

        let stored = self
            .db
            .store_payments(
                self.domain.id(),
                &self.interchain_gas_paymaster_address,
                storable,
            )
            .await?;
        Ok(stored as u32)
    }
}
