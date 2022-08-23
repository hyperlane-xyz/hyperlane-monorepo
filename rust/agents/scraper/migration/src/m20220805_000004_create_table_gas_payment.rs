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
                    .table(GasPayment::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(GasPayment::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(GasPayment::TimeCreated)
                            .timestamp()
                            .not_null(),
                    )
                    .col(ColumnDef::new(GasPayment::Domain).unsigned().not_null())
                    .col(ColumnDef::new(GasPayment::LeafIndex).unsigned().not_null())
                    .col(ColumnDef::new_with_type(GasPayment::OutboxAddress, Address).not_null())
                    .col(ColumnDef::new_with_type(GasPayment::Amount, CryptoCurrency).not_null())
                    .col(ColumnDef::new(GasPayment::TxId).big_integer().not_null())
                    .index(
                        Index::create()
                            .name("idx-domain-outbox-leaf")
                            .col(GasPayment::Domain)
                            .col(GasPayment::OutboxAddress)
                            .col(GasPayment::LeafIndex),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(GasPayment::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
enum GasPayment {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Domain ID of the chain the payment was made on; technically duplicating
    /// Tx -> Block -> Domain but this will be used a lot for lookups.
    Domain,
    /// Message leaf index the payment was for
    LeafIndex,
    /// Address of the outbox contract
    OutboxAddress,
    /// How much was paid
    Amount,
    /// Transaction the payment was made in
    TxId,
}
