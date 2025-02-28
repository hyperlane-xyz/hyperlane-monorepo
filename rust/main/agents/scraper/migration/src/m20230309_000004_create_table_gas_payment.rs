use sea_orm::ConnectionTrait;
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
                    .col(ColumnDef::new(GasPayment::Origin).unsigned().not_null())
                    .col(
                        ColumnDef::new(GasPayment::Destination)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(GasPayment::InterchainGasPaymaster, Address)
                            .not_null(),
                    )
                    .col(ColumnDef::new(GasPayment::Sequence).big_integer())
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
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(GasPayment::Origin)
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
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(GasPayment::Table)
                    .name("gas_payment_domain_id_idx")
                    .col(GasPayment::Domain)
                    .col(GasPayment::Id)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(GasPayment::Table)
                    .name("gas_payment_origin_id_idx")
                    .col(GasPayment::Origin)
                    .col(GasPayment::Id)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(GasPayment::Table)
                    .name("gas_payment_origin_interchain_gas_paymaster_sequence_idx")
                    .col(GasPayment::Origin)
                    .col(GasPayment::InterchainGasPaymaster)
                    .col(GasPayment::Sequence)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"
            CREATE VIEW "{tgp_table}" AS
            SELECT
                "gp"."{gp_mid}" AS "{tgp_mid}",
                COUNT("gp"."{gp_mid}") AS "{tgp_num_payments}",
                SUM("gp"."{gp_payment}") AS "{tgp_payment}",
                SUM("gp"."{gp_gas_amount}") AS "{tgp_gas_amount}"
            FROM "{gp_table}" AS "gp"
            GROUP BY "gp"."{gp_mid}"
            "#,
                gp_table = GasPayment::Table.to_string(),
                gp_mid = GasPayment::MsgId.to_string(),
                gp_payment = GasPayment::Payment.to_string(),
                gp_gas_amount = GasPayment::GasAmount.to_string(),
                tgp_table = TotalGasPayment::Table.to_string(),
                tgp_mid = TotalGasPayment::MsgId.to_string(),
                tgp_num_payments = TotalGasPayment::NumPayments.to_string(),
                tgp_payment = TotalGasPayment::TotalPayment.to_string(),
                tgp_gas_amount = TotalGasPayment::TotalGasAmount.to_string(),
            ))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"DROP VIEW IF EXISTS "{}""#,
                TotalGasPayment::Table.to_string()
            ))
            .await?;

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
    /// Domain ID of the chain the payment was made on; technically duplicating
    /// field Domain, but Domain becomes ambiguous as we add Destination domain as well.
    Origin,
    /// Domain ID of the chain the payment was made for.
    Destination,
    /// Interchain Gas Paymaster contract address
    InterchainGasPaymaster,
    /// Sequence of this payment for indexing by agent. It can be null if agent
    /// does not use sequence-aware indexing.
    Sequence,
}

#[derive(Iden)]
pub enum TotalGasPayment {
    Table,
    MsgId,
    NumPayments,
    TotalPayment,
    TotalGasAmount,
}
