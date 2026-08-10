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
                    .table(Hyperswap::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Hyperswap::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Hyperswap::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default(SimpleExpr::Custom("NOW()".to_owned())),
                    )
                    .col(
                        ColumnDef::new(Hyperswap::TimeUpdated)
                            .timestamp()
                            .not_null()
                            .default(SimpleExpr::Custom("NOW()".to_owned())),
                    )
                    .col(
                        ColumnDef::new_with_type(Hyperswap::Commitment, Hash)
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new_with_type(Hyperswap::WarpMessageId, Hash))
                    .col(ColumnDef::new_with_type(Hyperswap::CommitMessageId, Hash))
                    .col(ColumnDef::new_with_type(Hyperswap::RevealMessageId, Hash))
                    .col(
                        ColumnDef::new(Hyperswap::OriginDomain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Hyperswap::DestinationDomain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Hyperswap::OriginTxId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Hyperswap::DestinationTxId).big_integer())
                    .col(
                        ColumnDef::new_with_type(Hyperswap::OriginTokenAddress, Address).not_null(),
                    )
                    .col(ColumnDef::new_with_type(
                        Hyperswap::DestinationTokenAddress,
                        Address,
                    ))
                    .col(ColumnDef::new_with_type(
                        Hyperswap::BridgeTokenAddress,
                        Address,
                    ))
                    .col(ColumnDef::new_with_type(Hyperswap::BridgeAmount, Wei))
                    .col(ColumnDef::new(Hyperswap::OriginSwap).boolean().not_null())
                    .col(ColumnDef::new(Hyperswap::DestinationSwap).boolean())
                    .col(ColumnDef::new(Hyperswap::DestinationSweep).boolean())
                    .col(ColumnDef::new(Hyperswap::DestinationSweepExecuted).boolean())
                    .col(ColumnDef::new_with_type(
                        Hyperswap::DestinationSweepToken,
                        Address,
                    ))
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Hyperswap::OriginDomain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Hyperswap::DestinationDomain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Hyperswap::OriginTxId)
                            .to(Transaction::Table, Transaction::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Hyperswap::DestinationTxId)
                            .to(Transaction::Table, Transaction::Id),
                    )
                    .to_owned(),
            )
            .await?;

        for (name, col) in [
            ("hyperswap_warp_message_id_idx", Hyperswap::WarpMessageId),
            (
                "hyperswap_commit_message_id_idx",
                Hyperswap::CommitMessageId,
            ),
            (
                "hyperswap_reveal_message_id_idx",
                Hyperswap::RevealMessageId,
            ),
        ] {
            manager
                .create_index(
                    Index::create()
                        .table(Hyperswap::Table)
                        .name(name)
                        .col(col)
                        .index_type(IndexType::Hash)
                        .to_owned(),
                )
                .await?;
        }

        manager
            .create_index(
                Index::create()
                    .table(Hyperswap::Table)
                    .name("hyperswap_domains_idx")
                    .col(Hyperswap::OriginDomain)
                    .col(Hyperswap::DestinationDomain)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Hyperswap::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
pub enum Hyperswap {
    Table,
    Id,
    TimeCreated,
    TimeUpdated,
    Commitment,
    WarpMessageId,
    CommitMessageId,
    RevealMessageId,
    OriginDomain,
    DestinationDomain,
    OriginTxId,
    DestinationTxId,
    OriginTokenAddress,
    DestinationTokenAddress,
    BridgeTokenAddress,
    BridgeAmount,
    OriginSwap,
    DestinationSwap,
    DestinationSweep,
    DestinationSweepExecuted,
    DestinationSweepToken,
}
