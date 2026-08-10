use eyre::Result;
use sea_orm::{
    prelude::*, sea_query::OnConflict, ActiveValue::*, EntityTrait, Insert, QuerySelect,
};
use tracing::instrument;

use hyperlane_core::{h256_to_bytes, H256};

use crate::{
    conversions::u256_to_decimal,
    date_time,
    hyperswap::{DestinationHyperswap, OriginHyperswap},
};

use super::{
    generated::{hyperswap, transaction},
    ScraperDb,
};

#[derive(Debug, Clone)]
pub struct StorableOriginHyperswap {
    pub origin: OriginHyperswap,
    pub origin_domain: u32,
    pub origin_tx_id: i64,
    pub warp_message_id: Option<H256>,
    pub commit_message_id: Option<H256>,
    pub reveal_message_id: Option<H256>,
}

#[derive(Debug, Clone)]
pub struct StorableDestinationHyperswap {
    pub destination: DestinationHyperswap,
    pub destination_tx_id: i64,
}

impl ScraperDb {
    #[instrument(skip_all)]
    pub async fn retrieve_tx_raw_input_data(&self, tx_id: i64) -> Result<Option<Vec<u8>>> {
        let raw_input_data = transaction::Entity::find_by_id(tx_id)
            .select_only()
            .column(transaction::Column::RawInputData)
            .into_tuple::<Option<Vec<u8>>>()
            .one(&self.0)
            .await?
            .flatten();
        Ok(raw_input_data)
    }

    #[instrument(skip_all)]
    pub async fn store_origin_hyperswap(&self, storable: StorableOriginHyperswap) -> Result<()> {
        let origin = storable.origin;
        let model = hyperswap::ActiveModel {
            id: NotSet,
            time_created: Set(date_time::now()),
            time_updated: Set(date_time::now()),
            commitment: Unchanged(h256_to_bytes(&origin.commitment)),
            warp_message_id: Set(storable.warp_message_id.map(|id| h256_to_bytes(&id))),
            commit_message_id: Set(storable.commit_message_id.map(|id| h256_to_bytes(&id))),
            reveal_message_id: Set(storable.reveal_message_id.map(|id| h256_to_bytes(&id))),
            origin_domain: Unchanged(storable.origin_domain as i32),
            destination_domain: Set(origin.destination_domain as i32),
            origin_tx_id: Set(storable.origin_tx_id),
            destination_tx_id: NotSet,
            origin_token_address: Set(h256_to_bytes(&origin.origin_token_address)),
            destination_token_address: NotSet,
            bridge_token_address: Set(Some(h256_to_bytes(&origin.bridge_token_address))),
            bridge_amount: Set(Some(u256_to_decimal(origin.bridge_amount))),
            origin_swap: Set(origin.origin_swap),
            destination_swap: NotSet,
            destination_sweep: NotSet,
            destination_sweep_executed: NotSet,
            destination_sweep_token: NotSet,
        };

        Insert::one(model)
            .on_conflict(
                OnConflict::column(hyperswap::Column::Commitment)
                    .update_columns([
                        hyperswap::Column::TimeUpdated,
                        hyperswap::Column::WarpMessageId,
                        hyperswap::Column::CommitMessageId,
                        hyperswap::Column::RevealMessageId,
                        hyperswap::Column::DestinationDomain,
                        hyperswap::Column::OriginTxId,
                        hyperswap::Column::OriginTokenAddress,
                        hyperswap::Column::BridgeTokenAddress,
                        hyperswap::Column::BridgeAmount,
                        hyperswap::Column::OriginSwap,
                    ])
                    .to_owned(),
            )
            .exec(&self.0)
            .await?;
        Ok(())
    }

    #[instrument(skip_all)]
    pub async fn update_destination_hyperswap_by_reveal_message_id(
        &self,
        reveal_message_id: H256,
        storable: StorableDestinationHyperswap,
    ) -> Result<()> {
        hyperswap::Entity::update_many()
            .col_expr(
                hyperswap::Column::TimeUpdated,
                Expr::value(date_time::now()),
            )
            .col_expr(
                hyperswap::Column::DestinationTxId,
                Expr::value(storable.destination_tx_id),
            )
            .col_expr(
                hyperswap::Column::DestinationTokenAddress,
                Expr::value(
                    storable
                        .destination
                        .destination_token_address
                        .map(|id| h256_to_bytes(&id)),
                ),
            )
            .col_expr(
                hyperswap::Column::DestinationSwap,
                Expr::value(storable.destination.destination_swap),
            )
            .col_expr(
                hyperswap::Column::DestinationSweep,
                Expr::value(storable.destination.destination_sweep),
            )
            .col_expr(
                hyperswap::Column::DestinationSweepToken,
                Expr::value(
                    storable
                        .destination
                        .destination_sweep_token
                        .map(|id| h256_to_bytes(&id)),
                ),
            )
            .filter(hyperswap::Column::RevealMessageId.eq(h256_to_bytes(&reveal_message_id)))
            .exec(&self.0)
            .await?;
        Ok(())
    }
}
