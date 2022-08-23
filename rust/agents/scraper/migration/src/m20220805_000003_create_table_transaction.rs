use crate::l20220805_types::*;
use sea_orm_migration::prelude::*;

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
                    .col(ColumnDef::new_with_type(Transaction::Hash, Hash).not_null())
                    .col(
                        ColumnDef::new(Transaction::BlockId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new_with_type(Transaction::GasUsed, CryptoCurrency).not_null())
                    .col(ColumnDef::new_with_type(Transaction::Sender, Address).not_null())
                    .index(
                        Index::create()
                            .name("idx-hash")
                            .col(Transaction::Hash)
                            .unique(),
                    )
                    .index(Index::create().name("idx-sender").col(Transaction::Sender))
                    .index(Index::create().name("idx-block").col(Transaction::BlockId))
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
enum Transaction {
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
