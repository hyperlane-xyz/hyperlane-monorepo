use sea_orm_migration::prelude::*;

use crate::l20220805_types::*;
use crate::m20220805_000002_create_table_block::Block;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Transaction::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Transaction::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Transaction::TimeCreated)
                            .timestamp()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(Transaction::Hash, Hash)
                            .unique_key()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Transaction::BlockId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new_with_type(Transaction::GasUsed, CryptoCurrency).not_null())
                    .col(ColumnDef::new_with_type(Transaction::Sender, Address).not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Transaction::BlockId)
                            .to(Block::Table, Block::Id),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("transaction_sender_idx")
                    .table(Transaction::Table)
                    .col(Transaction::Sender)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("transaction_block_idx")
                    .table(Transaction::Table)
                    .col(Transaction::BlockId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Transaction::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum Transaction {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// The transaction hash
    Hash,
    /// Block this transaction was included in
    BlockId,
    /// Total gas used by this transaction
    GasUsed,
    /// Transaction signer
    Sender,
}
