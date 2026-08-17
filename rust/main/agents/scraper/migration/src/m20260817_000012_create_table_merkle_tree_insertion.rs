use sea_orm_migration::prelude::*;

use crate::l20230309_types::*;
use crate::m20230309_000001_create_table_domain::Domain;
use crate::m20230309_000003_create_table_transaction::Transaction;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(MerkleTreeInsertion::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(MerkleTreeInsertion::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(MerkleTreeInsertion::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default(SimpleExpr::Custom("NOW()".to_owned())),
                    )
                    .col(
                        ColumnDef::new(MerkleTreeInsertion::Domain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(MerkleTreeInsertion::MerkleTreeHook, Address)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(MerkleTreeInsertion::LeafIndex)
                            .unsigned()
                            .not_null(),
                    )
                    .col(ColumnDef::new_with_type(MerkleTreeInsertion::MessageId, Hash).not_null())
                    .col(
                        ColumnDef::new(MerkleTreeInsertion::OriginTxId)
                            .big_integer()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(MerkleTreeInsertion::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(MerkleTreeInsertion::OriginTxId)
                            .to(Transaction::Table, Transaction::Id),
                    )
                    .index(
                        Index::create()
                            .unique()
                            .col(MerkleTreeInsertion::Domain)
                            .col(MerkleTreeInsertion::MerkleTreeHook)
                            .col(MerkleTreeInsertion::LeafIndex),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(MerkleTreeInsertion::Table)
                    .name("merkle_tree_insertion_message_id_idx")
                    .col(MerkleTreeInsertion::MessageId)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(MerkleTreeInsertion::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
pub enum MerkleTreeInsertion {
    Table,
    Id,
    TimeCreated,
    Domain,
    MerkleTreeHook,
    LeafIndex,
    MessageId,
    OriginTxId,
}
