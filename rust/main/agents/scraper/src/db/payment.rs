use std::collections::HashSet;

use eyre::Result;
use itertools::Itertools;
use sea_orm::{
    prelude::*, ActiveValue::*, ConnectionTrait, Insert, QuerySelect, Statement, TransactionTrait,
};
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
    /// The database id of the transaction the payment was made in, or `None`
    /// if the transaction could not be resolved on-chain (e.g. Sealevel basic
    /// log meta fallback).
    pub txn_id: Option<i64>,
}

impl ScraperDb {
    const PAYMENT_STORE_LOCK_NAMESPACE: i32 = 0x4859_504C;

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
    /// Also returns `None` for payments stored with a NULL transaction id
    /// (unresolvable log meta fallback).
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
            Ok(payment.tx_id)
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
        let interchain_gas_paymaster = address_to_bytes(interchain_gas_paymaster);

        // Postgres unique indexes treat NULLs as distinct, so the
        // (msg_id, tx_id, log_index) ON CONFLICT clause below never matches
        // payments whose transaction could not be resolved (tx_id IS NULL).
        // Dedupe those fallback payments explicitly so re-scrapes stay
        // idempotent.
        // The NULL fallback identity is enforced in application code because
        // the legacy unique index treats NULL tx IDs as distinct. Serialize
        // the read/reconcile/write sequence across scraper processes so
        // rolling deploys cannot race.
        let txn = self.0.begin().await?;
        txn.execute(Statement::from_sql_and_values(
            txn.get_database_backend(),
            "SELECT pg_advisory_xact_lock($1, $2)",
            [
                Self::PAYMENT_STORE_LOCK_NAMESPACE.into(),
                i32::from_ne_bytes(domain.to_ne_bytes()).into(),
            ],
        ))
        .await?;

        let latest_id_before = gas_payment::Entity::find()
            .select_only()
            .column_as(gas_payment::Column::Id.max(), "max_id")
            .filter(gas_payment::Column::Domain.eq(domain))
            .into_tuple::<Option<i64>>()
            .one(&txn)
            .await?
            .flatten()
            .unwrap_or(0);

        let payment_msg_ids = payments
            .iter()
            .map(|storable| h256_to_bytes(&storable.payment.message_id))
            .collect_vec();
        let existing_payments = if payment_msg_ids.is_empty() {
            Vec::new()
        } else {
            gas_payment::Entity::find()
                .filter(gas_payment::Column::Domain.eq(domain))
                .filter(
                    gas_payment::Column::InterchainGasPaymaster
                        .eq(interchain_gas_paymaster.clone()),
                )
                .filter(gas_payment::Column::MsgId.is_in(payment_msg_ids))
                .all(&txn)
                .await?
        };
        let mut seen_fallback_payments: HashSet<(Vec<u8>, i64)> = existing_payments
            .iter()
            .map(|payment| (payment.msg_id.clone(), payment.log_index))
            .collect();
        let mut existing_null_payments: HashSet<(Vec<u8>, i64)> = existing_payments
            .into_iter()
            .filter(|payment| payment.tx_id.is_none())
            .map(|payment| (payment.msg_id, payment.log_index))
            .collect();
        let resolved_batch_payments: HashSet<(Vec<u8>, i64)> = payments
            .iter()
            .filter(|storable| storable.txn_id.is_some())
            .map(payment_identity)
            .collect();

        let mut models = Vec::with_capacity(payments.len());
        for storable in payments {
            let identity = payment_identity(storable);
            if storable.txn_id.is_none() {
                // Prefer a resolved variant in the same batch, and skip any
                // identity already stored or accepted.
                if resolved_batch_payments.contains(&identity)
                    || !seen_fallback_payments.insert(identity)
                {
                    continue;
                }
            } else if existing_null_payments.remove(&identity) {
                // Replace an earlier fallback row instead of keeping both
                // variants and double-counting it.
                gas_payment::Entity::delete_many()
                    .filter(gas_payment::Column::Domain.eq(domain))
                    .filter(
                        gas_payment::Column::InterchainGasPaymaster
                            .eq(interchain_gas_paymaster.clone()),
                    )
                    .filter(gas_payment::Column::MsgId.eq(identity.0.clone()))
                    .filter(gas_payment::Column::LogIndex.eq(identity.1))
                    .filter(gas_payment::Column::TxId.is_null())
                    .exec(&txn)
                    .await?;
            }

            models.push(payment_model(
                domain,
                interchain_gas_paymaster.clone(),
                storable,
            ));
        }

        debug!(?models, "Writing gas payments to database");

        let new_payments_count = if models.is_empty() {
            debug!("Wrote zero new gas payments to database");
            0
        } else {
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
                .exec(&txn)
                .await?;

            gas_payment::Entity::find()
                .filter(gas_payment::Column::Domain.eq(domain))
                .filter(gas_payment::Column::Id.gt(latest_id_before))
                .count(&txn)
                .await?
        };
        txn.commit().await?;

        debug!(
            payments = new_payments_count,
            "Wrote new gas payments to database"
        );
        Ok(new_payments_count)
    }
}

fn payment_identity(storable: &StorablePayment<'_>) -> (Vec<u8>, i64) {
    (
        h256_to_bytes(&storable.payment.message_id),
        // CAST SAFETY: Postgres stores log indexes as signed BIGINT; Sealevel
        // fallback indexes are sequence numbers (u32).
        storable.meta.log_index.as_u64() as i64,
    )
}

fn payment_model(
    domain: u32,
    interchain_gas_paymaster: Vec<u8>,
    storable: &StorablePayment<'_>,
) -> gas_payment::ActiveModel {
    gas_payment::ActiveModel {
        id: NotSet,
        time_created: Set(date_time::now()),
        // CAST SAFETY: domain IDs are stored using the same 32-bit bit pattern
        // in the legacy signed PostgreSQL schema.
        domain: Unchanged(domain as i32),
        msg_id: Unchanged(h256_to_bytes(&storable.payment.message_id)),
        payment: Set(u256_to_decimal(storable.payment.payment)),
        gas_amount: Set(u256_to_decimal(storable.payment.gas_amount)),
        tx_id: Unchanged(storable.txn_id),
        // CAST SAFETY: supported chain log indexes fit PostgreSQL BIGINT; this
        // preserves the existing scraper schema conversion.
        log_index: Unchanged(storable.meta.log_index.as_u64() as i64),
        // CAST SAFETY: domain IDs use the legacy signed 32-bit schema encoding.
        origin: Set(domain as i32),
        destination: Set(storable.payment.destination as i32),
        interchain_gas_paymaster: Set(interchain_gas_paymaster),
        sequence: Set(storable.sequence),
    }
}
