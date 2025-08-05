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
                    .table(DeliveredMessage::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(DeliveredMessage::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(DeliveredMessage::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(
                        ColumnDef::new_with_type(DeliveredMessage::MsgId, Hash)
                            .not_null()
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(DeliveredMessage::Domain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(DeliveredMessage::DestinationMailbox, Address)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DeliveredMessage::DestinationTxId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(DeliveredMessage::Sequence).big_integer())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(DeliveredMessage::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(DeliveredMessage::DestinationTxId)
                            .to(Transaction::Table, Transaction::Id),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(DeliveredMessage::Table)
                    .name("delivered_message_domain_destination_mailbox_idx")
                    .col(DeliveredMessage::Domain)
                    .col(DeliveredMessage::DestinationMailbox)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(DeliveredMessage::Table)
                    .name("delivered_message_domain_destination_mailbox_sequence_idx")
                    .col(DeliveredMessage::Domain)
                    .col(DeliveredMessage::DestinationMailbox)
                    .col(DeliveredMessage::Sequence)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(DeliveredMessage::Table)
                    .name("delivered_message_tx_idx")
                    .col(DeliveredMessage::DestinationTxId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(DeliveredMessage::Table)
                    .name("delivered_message_msg_id_idx")
                    .col(DeliveredMessage::MsgId)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(DeliveredMessage::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum DeliveredMessage {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Unique id of the message on the blockchain which was delivered
    MsgId,
    /// Domain the message was received on
    Domain,
    /// Address of the mailbox contract the message was received by
    DestinationMailbox,
    /// Transaction the delivery was included in
    DestinationTxId,
    /// Sequence when message was delivered
    Sequence,
}
