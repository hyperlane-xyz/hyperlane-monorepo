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
                    .table(SameChainCcrSwap::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SameChainCcrSwap::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(SameChainCcrSwap::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default(SimpleExpr::Custom("NOW()".to_owned())),
                    )
                    .col(
                        ColumnDef::new(SameChainCcrSwap::Domain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(SameChainCcrSwap::SourceRouter, Address)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(SameChainCcrSwap::DestinationRouter, Address)
                            .not_null(),
                    )
                    .col(ColumnDef::new_with_type(SameChainCcrSwap::AmountSent, Wei).not_null())
                    .col(ColumnDef::new_with_type(SameChainCcrSwap::AmountReceived, Wei).not_null())
                    .col(ColumnDef::new_with_type(SameChainCcrSwap::Recipient, Address).not_null())
                    .col(
                        ColumnDef::new(SameChainCcrSwap::TxId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SameChainCcrSwap::LogIndex)
                            .big_unsigned()
                            .not_null(),
                    )
                    .col(ColumnDef::new(SameChainCcrSwap::Sequence).big_integer())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(SameChainCcrSwap::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(SameChainCcrSwap::TxId)
                            .to(Transaction::Table, Transaction::Id),
                    )
                    .index(
                        Index::create()
                            .col(SameChainCcrSwap::TxId)
                            .col(SameChainCcrSwap::LogIndex)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(SameChainCcrSwap::Table)
                    .name("same_chain_ccr_swap_domain_id_idx")
                    .col(SameChainCcrSwap::Domain)
                    .col(SameChainCcrSwap::Id)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(SameChainCcrSwap::Table)
                    .name("same_chain_ccr_swap_recipient_idx")
                    .col(SameChainCcrSwap::Recipient)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(SameChainCcrSwap::Table)
                    .name("same_chain_ccr_swap_destination_router_idx")
                    .col(SameChainCcrSwap::DestinationRouter)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(SameChainCcrSwap::Table)
                    .name("same_chain_ccr_swap_domain_destination_router_sequence_idx")
                    .col(SameChainCcrSwap::Domain)
                    .col(SameChainCcrSwap::DestinationRouter)
                    .col(SameChainCcrSwap::Sequence)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(SameChainCcrSwap::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
pub enum SameChainCcrSwap {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Domain ID of the chain (same for both sides — same-chain swap)
    Domain,
    /// Address of the source CCR contract (token sent from)
    SourceRouter,
    /// Address of the destination CCR contract (token received by recipient)
    DestinationRouter,
    /// Amount of source token transferred in
    AmountSent,
    /// Amount of destination token transferred out (from ReceivedTransferRemote)
    AmountReceived,
    /// Final token recipient
    Recipient,
    /// Transaction this swap occurred in
    TxId,
    /// Log index of ReceivedTransferRemote in the transaction (for dedup)
    LogIndex,
    /// Sequence for cursor-based indexing (nullable)
    Sequence,
}
