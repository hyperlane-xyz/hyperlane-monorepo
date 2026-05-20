use eyre::{eyre, Result};
use itertools::Itertools;
use sea_orm::{prelude::*, ActiveValue::*, Insert, QuerySelect};
use tracing::{debug, instrument};

use hyperlane_core::{h256_to_bytes, LogMeta, SameChainCcrSwap};
use migration::OnConflict;

use crate::conversions::u256_to_decimal;
use crate::date_time;
use crate::db::ScraperDb;

use super::generated::same_chain_ccr_swap;

#[derive(Debug)]
pub struct StorableCcrSwap<'a> {
    pub swap: &'a SameChainCcrSwap,
    pub sequence: Option<i64>,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the swap was made in
    pub txn_id: i64,
}

impl ScraperDb {
    #[instrument(skip_all)]
    pub async fn store_ccr_swaps(&self, domain: u32, swaps: &[StorableCcrSwap<'_>]) -> Result<u64> {
        let latest_id_before = self.latest_ccr_swap_id(domain).await?;

        let models = swaps
            .iter()
            .map(|storable| same_chain_ccr_swap::ActiveModel {
                id: NotSet,
                time_created: Set(date_time::now()),
                domain: Unchanged(domain as i32),
                source_router: Set(h256_to_bytes(&storable.swap.source_router)),
                destination_router: Set(h256_to_bytes(&storable.swap.destination_router)),
                amount_sent: Set(u256_to_decimal(storable.swap.amount_sent)),
                amount_received: Set(u256_to_decimal(storable.swap.amount_received)),
                recipient: Set(h256_to_bytes(&storable.swap.recipient)),
                tx_id: Unchanged(storable.txn_id),
                log_index: Unchanged(storable.meta.log_index.as_u64() as i64),
                sequence: Set(storable.sequence),
            })
            .collect_vec();

        debug!(?models, "Writing CCR swaps to database");

        if models.is_empty() {
            debug!("Wrote zero new CCR swaps to database");
            return Ok(0);
        }

        Insert::many(models)
            .on_conflict(
                OnConflict::columns([
                    same_chain_ccr_swap::Column::TxId,
                    same_chain_ccr_swap::Column::LogIndex,
                ])
                .update_columns([
                    same_chain_ccr_swap::Column::TimeCreated,
                    same_chain_ccr_swap::Column::SourceRouter,
                    same_chain_ccr_swap::Column::DestinationRouter,
                    same_chain_ccr_swap::Column::AmountSent,
                    same_chain_ccr_swap::Column::AmountReceived,
                    same_chain_ccr_swap::Column::Recipient,
                    same_chain_ccr_swap::Column::Sequence,
                ])
                .to_owned(),
            )
            .exec(&self.0)
            .await?;

        let new_count = self
            .ccr_swaps_count_since_id(domain, latest_id_before)
            .await?;

        debug!(swaps = new_count, "Wrote new CCR swaps to database");
        Ok(new_count)
    }

    async fn latest_ccr_swap_id(&self, domain: u32) -> Result<i64> {
        let result = same_chain_ccr_swap::Entity::find()
            .select_only()
            .column_as(same_chain_ccr_swap::Column::Id.max(), "max_id")
            .filter(same_chain_ccr_swap::Column::Domain.eq(domain))
            .into_tuple::<Option<i64>>()
            .one(&self.0)
            .await?;

        Ok(result
            .ok_or_else(|| eyre!("Error getting latest CCR swap id"))?
            .unwrap_or(0))
    }

    async fn ccr_swaps_count_since_id(&self, domain: u32, prev_id: i64) -> Result<u64> {
        Ok(same_chain_ccr_swap::Entity::find()
            .filter(same_chain_ccr_swap::Column::Domain.eq(domain))
            .filter(same_chain_ccr_swap::Column::Id.gt(prev_id))
            .count(&self.0)
            .await?)
    }
}
