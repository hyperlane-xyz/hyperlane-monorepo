use sea_orm_migration::prelude::*;

use crate::m20230309_000004_create_table_gas_payment::GasPayment;
use crate::m20230309_000005_create_table_message::Message;
use crate::m20260817_000012_create_table_merkle_tree_insertion::MerkleTreeInsertion;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// The indexes on populated source tables are created by the
/// `create-outbox-source-indexes` bin because Postgres requires
/// `CREATE INDEX CONCURRENTLY` to run outside a transaction.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_index(
                Index::create()
                    .table(MerkleTreeInsertion::Table)
                    .name("merkle_tree_insertion_origin_tx_id_idx")
                    .col(MerkleTreeInsertion::OriginTxId)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .table(MerkleTreeInsertion::Table)
                    .name("merkle_tree_insertion_origin_tx_id_idx")
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(GasPayment::Table)
                    .name("gas_payment_tx_id_idx")
                    .if_exists()
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(Message::Table)
                    .name("message_origin_tx_id_idx")
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}
