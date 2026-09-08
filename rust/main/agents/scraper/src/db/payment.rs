use std::collections::{HashMap, HashSet};

use eyre::{ensure, Result};
use itertools::Itertools;
use sea_orm::{
    prelude::*, ActiveModelTrait, ActiveValue::*, ConnectionTrait, Insert, QuerySelect, QueryTrait,
    Statement, TransactionTrait,
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
    // Eleven parameters per inserted row; reads add two scope parameters.
    const PAYMENT_STORE_CHUNK_SIZE: usize = 5_000;

    const PAYMENT_STORE_LOCK_NAMESPACE: i32 = 0x4859_504C;

    /// Get the payment associated with a sequence.
    #[instrument(skip(self))]
    pub async fn retrieve_payment_by_sequence(
        &self,
        origin: u32,
        interchain_gas_paymaster: &H256,
        sequence: u32,
    ) -> Result<Option<InterchainGasPayment>> {
        if let Some((msg_id, destination, payment, gas_amount)) = gas_payment::Entity::find()
            .select_only()
            .columns([
                gas_payment::Column::MsgId,
                gas_payment::Column::Destination,
                gas_payment::Column::Payment,
                gas_payment::Column::GasAmount,
            ])
            .filter(gas_payment::Column::Origin.eq(origin))
            .filter(
                gas_payment::Column::InterchainGasPaymaster
                    .eq(address_to_bytes(interchain_gas_paymaster)),
            )
            .filter(gas_payment::Column::Sequence.eq(sequence))
            .into_tuple::<(Vec<u8>, i32, BigDecimal, BigDecimal)>()
            .one(&self.0)
            .await?
        {
            let payment = InterchainGasPayment {
                message_id: H256::from_slice(&msg_id),
                destination: destination as u32,
                payment: decimal_to_u256(payment),
                gas_amount: decimal_to_u256(gas_amount),
            };
            Ok(Some(payment))
        } else {
            Ok(None)
        }
    }

    /// Get the block height of the gas payment associated with a sequence.
    /// Also returns `None` for payments stored with a NULL transaction id
    /// (unresolvable log meta fallback).
    #[instrument(skip(self))]
    pub async fn retrieve_payment_block_number(
        &self,
        origin: u32,
        interchain_gas_paymaster: &H256,
        sequence: u32,
    ) -> Result<Option<u64>> {
        let tx_id_query = gas_payment::Entity::find()
            .filter(gas_payment::Column::Origin.eq(origin))
            .filter(
                gas_payment::Column::InterchainGasPaymaster
                    .eq(address_to_bytes(interchain_gas_paymaster)),
            )
            .filter(gas_payment::Column::Sequence.eq(sequence))
            .select_only()
            .column(gas_payment::Column::TxId)
            .limit(1)
            .into_query();
        self.retrieve_block_number_by_tx_query(tx_id_query).await
    }

    #[instrument(skip_all)]
    pub async fn store_payments(
        &self,
        domain: u32,
        interchain_gas_paymaster: &H256,
        payments: &[StorablePayment<'_>],
    ) -> Result<u64> {
        if payments.is_empty() {
            return Ok(0);
        }
        // PostgreSQL rejects repeated non-NULL conflict keys in one upsert.
        // Retain that rejection even if keys would land in different chunks.
        let mut resolved_keys = HashSet::new();
        for payment in payments {
            if let Some(tx_id) = payment.txn_id {
                ensure!(
                    resolved_keys.insert((
                        payment.payment.message_id,
                        payment.meta.log_index.as_u64(),
                        tx_id,
                    )),
                    "Duplicate resolved gas payment in one batch"
                );
            }
        }
        drop(resolved_keys);
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

        let payment_msg_ids = payments
            .iter()
            .map(|storable| h256_to_bytes(&storable.payment.message_id))
            .unique()
            .collect_vec();
        let mut seen_fallback_payments = HashSet::new();
        let mut existing_null_payments = HashMap::new();
        let mut existing_resolved_payments = HashSet::new();
        for message_ids in payment_msg_ids.chunks(Self::PAYMENT_STORE_CHUNK_SIZE) {
            let existing_payments = gas_payment::Entity::find()
                .select_only()
                .columns([
                    gas_payment::Column::Id,
                    gas_payment::Column::MsgId,
                    gas_payment::Column::LogIndex,
                    gas_payment::Column::TxId,
                ])
                .filter(gas_payment::Column::Domain.eq(domain))
                .filter(
                    gas_payment::Column::InterchainGasPaymaster
                        .eq(interchain_gas_paymaster.clone()),
                )
                .filter(gas_payment::Column::MsgId.is_in(message_ids.iter().cloned()))
                .into_tuple::<(i64, Vec<u8>, i64, Option<i64>)>()
                .all(&txn)
                .await?;
            existing_resolved_payments.extend(existing_payments.iter().filter_map(
                |(_, msg_id, log_index, tx_id)| {
                    tx_id.map(|tx_id| (msg_id.clone(), *log_index, tx_id))
                },
            ));
            for (id, msg_id, log_index, tx_id) in existing_payments {
                let identity = (msg_id, log_index);
                if tx_id.is_none() {
                    existing_null_payments.insert(identity.clone(), id);
                }
                seen_fallback_payments.insert(identity);
            }
        }
        let resolved_batch_payments: HashSet<(Vec<u8>, i64)> = payments
            .iter()
            .filter(|storable| storable.txn_id.is_some())
            .map(payment_identity)
            .collect();

        let mut models = Vec::with_capacity(payments.len());
        let mut reconciled_payments_count = 0;
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
            } else if let Some(existing) = existing_null_payments.remove(&identity) {
                // A legacy resolved sibling may already own this unique key.
                // Keep its NULL sibling (and cursor) and upsert the resolved row.
                if !storable.txn_id.is_some_and(|tx_id| {
                    existing_resolved_payments.contains(&(identity.0.clone(), identity.1, tx_id))
                }) {
                    // Preserve the row's durable stream identity while enriching
                    // its transaction relation. Deleting and reinserting here
                    // would leave a gap in the commit-ordered cursor stream.
                    let mut model =
                        payment_model(domain, interchain_gas_paymaster.clone(), storable);
                    model.id = Unchanged(existing);
                    model.tx_id = Set(storable.txn_id);
                    model.update(&txn).await?;
                    reconciled_payments_count += 1;
                    continue;
                }
            }

            models.push(payment_model(
                domain,
                interchain_gas_paymaster.clone(),
                storable,
            ));
        }

        debug!(?models, "Writing gas payments to database");

        let inserted_payments_count = if models.is_empty() {
            debug!("Wrote zero new gas payments to database");
            0
        } else {
            let latest_id_before = gas_payment::Entity::find()
                .select_only()
                .column_as(gas_payment::Column::Id.max(), "max_id")
                .filter(gas_payment::Column::Domain.eq(domain))
                .into_tuple::<Option<i64>>()
                .one(&txn)
                .await?
                .flatten()
                .unwrap_or(0);

            let mut models = models.into_iter();
            while !models.as_slice().is_empty() {
                let chunk = models
                    .by_ref()
                    .take(Self::PAYMENT_STORE_CHUNK_SIZE)
                    .collect::<Vec<_>>();
                Insert::many(chunk)
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
            }

            gas_payment::Entity::find()
                .filter(gas_payment::Column::Domain.eq(domain))
                .filter(gas_payment::Column::Id.gt(latest_id_before))
                .count(&txn)
                .await?
        };
        let stored_payments_count = inserted_payments_count + reconciled_payments_count;
        txn.commit().await?;

        debug!(
            payments = stored_payments_count,
            "Wrote new gas payments to database"
        );
        Ok(stored_payments_count)
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
