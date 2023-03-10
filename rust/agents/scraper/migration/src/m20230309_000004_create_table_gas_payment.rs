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
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(ColumnDef::new(GasPayment::Domain).unsigned().not_null())
                    .col(ColumnDef::new_with_type(GasPayment::MsgId, Hash).not_null())
                    .col(ColumnDef::new_with_type(GasPayment::Payment, Wei).not_null())
                    .col(ColumnDef::new_with_type(GasPayment::GasAmount, Wei).not_null())
                    .col(ColumnDef::new(GasPayment::TxId).big_integer().not_null())
                    .col(
                        ColumnDef::new(GasPayment::LogIndex)
                            .big_unsigned()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(GasPayment::TxId)
                            .to(Transaction::Table, Transaction::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(GasPayment::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .index(
                        Index::create()
                            // don't need domain because TxId includes it
                            .col(GasPayment::MsgId)
                            .col(GasPayment::TxId)
                            .col(GasPayment::LogIndex)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(GasPayment::Table)
                    .name("gas_payment_msg_id_idx")
                    .col(GasPayment::MsgId)
                    .index_type(IndexType::Hash)
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
pub enum GasPayment {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Domain ID of the chain the payment was made on; technically duplicating
    /// Tx -> Block -> Domain but this will be used a lot for lookups.
    Domain,
    /// Unique id of the message on the blockchain which was paid for
    MsgId,
    /// Amount of native tokens paid.
    Payment,
    /// Amount of destination gas paid for.
    GasAmount,
    /// Transaction the payment was made in.
    TxId,
    /// Used to disambiguate duplicate payments from multiple payments made in
    /// same transaction.
    LogIndex,
}
