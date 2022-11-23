use sea_orm_migration::prelude::*;

use crate::l20221122_types::*;
use crate::m20221122_000001_create_table_domain::Domain;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Block::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Block::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Block::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(ColumnDef::new(Block::Domain).unsigned().not_null())
                    .col(
                        ColumnDef::new_with_type(Block::Hash, Hash)
                            .unique_key()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Block::Height).big_unsigned().not_null())
                    .col(ColumnDef::new(Block::Timestamp).timestamp().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Block::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .index(
                        Index::create()
                            .col(Block::Domain)
                            .col(Block::Height)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(Block::Table)
                    .name("block_hash_idx")
                    .col(Block::Hash)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Block::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum Block {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Domain id the block is on
    Domain,
    /// Block hash
    Hash,
    /// Block height
    Height,
    /// Time the block was created at
    Timestamp,
}
