use eyre::Result;
use itertools::Itertools;
use sea_orm::{ActiveValue::*, Insert};
use tracing::{debug, instrument, trace};

use hyperlane_core::{InterchainGasPayment, LogMeta};
use migration::OnConflict;

use crate::conversions::{h256_to_bytes, u256_to_decimal};
use crate::date_time;
use crate::db::ScraperDb;

use super::generated::gas_payment;

pub struct StorablePayment<'a> {
    pub payment: &'a InterchainGasPayment,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the payment was made in
    pub txn_id: i64,
}

impl ScraperDb {
    #[instrument(skip_all)]
    pub async fn store_payments(
        &self,
        domain: u32,
        payments: impl Iterator<Item = StorablePayment<'_>>,
    ) -> Result<()> {
        let models = payments
            .map(|storable| gas_payment::ActiveModel {
                id: NotSet,
                time_created: Set(date_time::now()),
                domain: Unchanged(domain as i32),
                msg_id: Unchanged(h256_to_bytes(&storable.payment.message_id)),
                payment: Set(u256_to_decimal(storable.payment.payment)),
                gas_amount: Set(u256_to_decimal(storable.payment.gas_amount)),
                tx_id: Unchanged(storable.txn_id),
                log_index: Unchanged(storable.meta.log_index.as_u64() as i64),
            })
            .collect_vec();

        debug_assert!(!models.is_empty());
        debug!(payments = models.len(), "Writing gas payments to database");
        trace!(?models, "Writing gas payments to database");

        Insert::many(models)
            .on_conflict(
                OnConflict::columns([
                    // don't need domain because TxId includes it
                    gas_payment::Column::MsgId,
                    gas_payment::Column::TxId,
                    gas_payment::Column::LogIndex,
                ])
                .update_columns([
                    gas_payment::Column::TimeCreated,
                    gas_payment::Column::Payment,
                    gas_payment::Column::GasAmount,
                ])
                .to_owned(),
            )
            .exec(&self.0)
            .await?;
        Ok(())
    }
}
