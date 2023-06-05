use eyre::Result;
use itertools::Itertools;
use sea_orm::{prelude::*, ActiveValue::*, Insert};
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
    ) -> Result<u64> {
        let payment_count_before = self.payments_count(domain).await?;
        // we have a race condition where a message may not have been scraped yet even
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
        let payment_count_after = self.payments_count(domain).await?;
        let difference = payment_count_after.saturating_sub(payment_count_before);
        if difference > 0 {
            debug!(payments = difference, "Wrote new gas payments to database");
        }
        Ok(difference)
    }

    async fn payments_count(&self, domain: u32) -> Result<u64> {
        Ok(gas_payment::Entity::find()
            .filter(gas_payment::Column::Domain.eq(domain))
            .count(&self.0)
            .await?)
    }
}
