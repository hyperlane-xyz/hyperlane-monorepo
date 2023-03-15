use std::collections::HashMap;

use eyre::{eyre, Context, Result};
use sea_orm::{prelude::*, ActiveValue::*, DeriveColumn, EnumIter, Insert, NotSet, QuerySelect};
use tracing::{debug, instrument, trace};

use hyperlane_core::{TxnInfo, H256};

use crate::conversions::{address_to_bytes, h256_to_bytes, u256_to_decimal};
use crate::date_time;
use crate::db::ScraperDb;

use super::generated::transaction;

#[derive(Debug, Clone)]
pub struct StorableTxn {
    pub info: TxnInfo,
    pub block_id: i64,
}

impl ScraperDb {
    /// Lookup transactions and find their ids. Any transactions which are not
    /// found be excluded from the hashmap.
    pub async fn get_txn_ids(
        &self,
        hashes: impl Iterator<Item = &H256>,
    ) -> Result<HashMap<H256, i64>> {
        #[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
        enum QueryAs {
            Id,
            Hash,
        }

        // check database to see which txns we already know and fetch their IDs
        let txns = transaction::Entity::find()
            .filter(transaction::Column::Hash.is_in(hashes.map(h256_to_bytes)))
            .select_only()
            .column_as(transaction::Column::Id, QueryAs::Id)
            .column_as(transaction::Column::Hash, QueryAs::Hash)
            .into_values::<(i64, Vec<u8>), QueryAs>()
            .all(&self.0)
            .await
            .context("When querying transactions")?
            .into_iter()
            .map(|(id, hash)| Ok((H256::from_slice(&hash), id)))
            .collect::<Result<HashMap<_, _>>>()?;

        debug!(txns=txns.len(), "Queried transaction info for hashes");
        trace!(?txns, "Queried transaction info for hashes");
        Ok(txns)
    }

    /// Store a new transaction into the database (or update an existing one).
    #[instrument(skip_all)]
    pub async fn store_txns(&self, txns: impl Iterator<Item = StorableTxn>) -> Result<i64> {
        let models = txns
            .map(|txn| {
                let receipt = txn
                    .receipt
                    .as_ref()
                    .ok_or_else(|| eyre!("Transaction is not yet included"))?;

                Ok(transaction::ActiveModel {
                    id: NotSet,
                    block_id: Unchanged(txn.block_id),
                    gas_limit: Set(u256_to_decimal(txn.gas_limit)),
                    max_priority_fee_per_gas: Set(txn
                        .max_priority_fee_per_gas
                        .map(u256_to_decimal)),
                    hash: Unchanged(h256_to_bytes(&txn.hash)),
                    time_created: Set(date_time::now()),
                    gas_used: Set(u256_to_decimal(receipt.gas_used)),
                    gas_price: Set(txn.gas_price.map(u256_to_decimal)),
                    effective_gas_price: Set(receipt.effective_gas_price.map(u256_to_decimal)),
                    nonce: Set(txn.nonce as i64),
                    sender: Set(address_to_bytes(&txn.sender)),
                    recipient: Set(txn.recipient.as_ref().map(address_to_bytes)),
                    max_fee_per_gas: Set(txn.max_fee_per_gas.map(u256_to_decimal)),
                    cumulative_gas_used: Set(u256_to_decimal(receipt.cumulative_gas_used)),
                })
            })
            .collect::<Result<Vec<_>>>()?;

        debug_assert!(!models.is_empty());
        let id_offset = models.len() as i64 - 1;
        debug!(txns=models.len(), "Writing txns to database");
        trace!(?models, "Writing txns to database");
        let first_id = Insert::many(models).exec(&self.0).await?.last_insert_id - id_offset;
        debug_assert!(first_id > 0);
        Ok(first_id)
    }
}
