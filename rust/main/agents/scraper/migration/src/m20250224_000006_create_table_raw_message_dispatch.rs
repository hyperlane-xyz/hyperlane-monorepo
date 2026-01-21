use sea_orm_migration::prelude::*;

use crate::l20230309_types::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(RawMessageDispatch::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(RawMessageDispatch::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(RawMessageDispatch::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(
                        ColumnDef::new_with_type(RawMessageDispatch::MsgId, Hash)
                            .unique_key()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(RawMessageDispatch::OriginTxHash, Hash).not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(RawMessageDispatch::OriginBlockHash, Hash)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RawMessageDispatch::OriginBlockHeight)
                            .big_unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RawMessageDispatch::Nonce)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RawMessageDispatch::OriginDomain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(RawMessageDispatch::DestinationDomain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(ColumnDef::new_with_type(RawMessageDispatch::Sender, Address).not_null())
                    .col(
                        ColumnDef::new_with_type(RawMessageDispatch::Recipient, Address).not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(RawMessageDispatch::OriginMailbox, Address)
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // Create an index on origin_domain for filtering
        manager
            .create_index(
                Index::create()
                    .table(RawMessageDispatch::Table)
                    .name("raw_message_dispatch_origin_domain_idx")
                    .col(RawMessageDispatch::OriginDomain)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        // Create an index on destination_domain for filtering
        manager
            .create_index(
                Index::create()
                    .table(RawMessageDispatch::Table)
                    .name("raw_message_dispatch_destination_domain_idx")
                    .col(RawMessageDispatch::DestinationDomain)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        // Create an index on origin_tx_hash for Offchain Lookup Server queries
        manager
            .create_index(
                Index::create()
                    .table(RawMessageDispatch::Table)
                    .name("raw_message_dispatch_origin_tx_hash_idx")
                    .col(RawMessageDispatch::OriginTxHash)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(RawMessageDispatch::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum RawMessageDispatch {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Message ID (keccak256 hash of message)
    MsgId,
    /// Origin transaction hash (from LogMeta - no RPC required!)
    OriginTxHash,
    /// Origin block hash
    OriginBlockHash,
    /// Origin block height
    OriginBlockHeight,
    /// Message nonce
    Nonce,
    /// Origin domain ID
    OriginDomain,
    /// Destination domain ID
    DestinationDomain,
    /// Sender address
    Sender,
    /// Recipient address
    Recipient,
    /// Origin mailbox address
    OriginMailbox,
}
