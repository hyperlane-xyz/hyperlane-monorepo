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
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new_with_type(DeliveredMessage::InboxAddress, Address)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DeliveredMessage::MsgId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DeliveredMessage::TxId)
                            .big_integer()
                            .not_null(),
                    )
                    .index(Index::create().name("idx-tx").col(DeliveredMessage::TxId))
                    .index(
                        Index::create()
                            .name("idx-msg")
                            .col(DeliveredMessage::MsgId)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await
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
    /// Address of the inbox contract the message was received by
    InboxAddress,
    /// Message which was delivered
    MsgId,
    /// Transaction the delivery was included in
    TxId,
}
