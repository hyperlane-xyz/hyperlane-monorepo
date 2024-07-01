use eyre::{eyre, Result};
use itertools::Itertools;
use sea_orm::{prelude::*, ActiveValue::*, Insert, QuerySelect};
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
        let latest_id_before = self.latest_payment_id(domain).await?;

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

        let new_payments_count = self
            .payments_count_since_id(domain, latest_id_before)
            .await?;

        if new_payments_count > 0 {
            debug!(
                payments = new_payments_count,
                "Wrote new gas payments to database"
            );
        }
        Ok(new_payments_count)
    }

    async fn latest_payment_id(&self, domain: u32) -> Result<i64> {
        let result = gas_payment::Entity::find()
            .select_only()
            .column_as(gas_payment::Column::Id.max(), "max_id")
            .filter(gas_payment::Column::Domain.eq(domain))
            .into_tuple::<Option<i64>>()
            .one(&self.0)
            .await?;

        Ok(result
            // Top level Option indicates some kind of error
            .ok_or_else(|| eyre!("Error getting latest payment id"))?
            // Inner Option indicates whether there was any data in the filter -
            // just default to 0 if there was no data
            .unwrap_or(0))
    }

    async fn payments_count_since_id(&self, domain: u32, prev_id: i64) -> Result<u64> {
        Ok(gas_payment::Entity::find()
            .filter(gas_payment::Column::Domain.eq(domain))
            .filter(gas_payment::Column::Id.gt(prev_id))
            .count(&self.0)
            .await?)
    }
}
