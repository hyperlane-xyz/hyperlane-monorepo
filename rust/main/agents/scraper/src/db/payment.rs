use eyre::{eyre, Result};
use itertools::Itertools;
use sea_orm::{prelude::*, ActiveValue::*, Insert, QuerySelect};
use tracing::{debug, instrument};

use hyperlane_core::{address_to_bytes, h256_to_bytes, InterchainGasPayment, LogMeta, H256};
use migration::OnConflict;

use crate::conversions::{decimal_to_u256, u256_to_decimal};
use crate::date_time;
use crate::db::ScraperDb;

use super::generated::gas_payment;

#[derive(Debug)]
pub struct StorablePayment<'a> {
    pub payment: &'a InterchainGasPayment,
    pub sequence: Option<i64>,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the payment was made in
    pub txn_id: i64,
}

impl ScraperDb {
    /// Get the payment associated with a sequence.
    #[instrument(skip(self))]
    pub async fn retrieve_payment_by_sequence(
        &self,
        origin: u32,
        interchain_gas_paymaster: &H256,
        sequence: u32,
    ) -> Result<Option<InterchainGasPayment>> {
        if let Some(payment) = gas_payment::Entity::find()
            .filter(gas_payment::Column::Origin.eq(origin))
            .filter(
                gas_payment::Column::InterchainGasPaymaster
                    .eq(address_to_bytes(interchain_gas_paymaster)),
            )
            .filter(gas_payment::Column::Sequence.eq(sequence))
            .one(&self.0)
            .await?
        {
            let payment = InterchainGasPayment {
                message_id: H256::from_slice(&payment.msg_id),
                destination: payment.destination as u32,
                payment: decimal_to_u256(payment.payment),
                gas_amount: decimal_to_u256(payment.gas_amount),
            };
            Ok(Some(payment))
        } else {
            Ok(None)
        }
    }

    /// Get the transaction id of the gas payment associated with a sequence.
    #[instrument(skip(self))]
    pub async fn retrieve_payment_tx_id(
        &self,
        origin: u32,
        interchain_gas_paymaster: &H256,
        sequence: u32,
    ) -> Result<Option<i64>> {
        if let Some(payment) = gas_payment::Entity::find()
            .filter(gas_payment::Column::Origin.eq(origin))
            .filter(
                gas_payment::Column::InterchainGasPaymaster
                    .eq(address_to_bytes(interchain_gas_paymaster)),
            )
            .filter(gas_payment::Column::Sequence.eq(sequence))
            .one(&self.0)
            .await?
        {
            let txn_id = payment.tx_id;
            Ok(Some(txn_id))
        } else {
            Ok(None)
        }
    }

    #[instrument(skip_all)]
    pub async fn store_payments(
        &self,
        domain: u32,
        interchain_gas_paymaster: &H256,
        payments: &[StorablePayment<'_>],
    ) -> Result<u64> {
        let latest_id_before = self.latest_payment_id(domain).await?;
        let interchain_gas_paymaster = address_to_bytes(interchain_gas_paymaster);

        // we have a race condition where a message may not have been scraped yet even
        let models = payments
            .iter()
            .map(|storable| gas_payment::ActiveModel {
                id: NotSet,
                time_created: Set(date_time::now()),
                domain: Unchanged(domain as i32),
                msg_id: Unchanged(h256_to_bytes(&storable.payment.message_id)),
                payment: Set(u256_to_decimal(storable.payment.payment)),
                gas_amount: Set(u256_to_decimal(storable.payment.gas_amount)),
                tx_id: Unchanged(storable.txn_id),
                log_index: Unchanged(storable.meta.log_index.as_u64() as i64),
                origin: Set(domain as i32),
                destination: Set(storable.payment.destination as i32),
                interchain_gas_paymaster: Set(interchain_gas_paymaster.clone()),
                sequence: Set(storable.sequence),
            })
            .collect_vec();

        debug!(?models, "Writing gas payments to database");

        if models.is_empty() {
            debug!("Wrote zero new gas payments to database");
            return Ok(0);
        }

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
                    gas_payment::Column::Origin,
                    gas_payment::Column::Destination,
                    gas_payment::Column::InterchainGasPaymaster,
                    gas_payment::Column::Sequence,
                ])
                .to_owned(),
            )
            .exec(&self.0)
            .await?;

        let new_payments_count = self
            .payments_count_since_id(domain, latest_id_before)
            .await?;

        debug!(
            payments = new_payments_count,
            "Wrote new gas payments to database"
        );
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
