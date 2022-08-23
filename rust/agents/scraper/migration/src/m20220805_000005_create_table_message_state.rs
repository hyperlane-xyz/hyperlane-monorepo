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
                    .table(MessageState::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(MessageState::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(MessageState::TimeCreated)
                            .timestamp()
                            .not_null(),
                    )
                    .col(ColumnDef::new(MessageState::MsgId).big_integer().not_null())
                    .col(
                        ColumnDef::new(MessageState::BlockHeight)
                            .big_unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(MessageState::BlockTimestamp)
                            .timestamp()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(MessageState::Processable)
                            .boolean()
                            .not_null(),
                    )
                    .col(&mut ColumnDef::new_with_type(
                        MessageState::EstimatedGasCost,
                        CryptoCurrency,
                    ))
                    .col(ColumnDef::new(MessageState::ErrorMsg).text())
                    .index(
                        Index::create()
                            .name("idx-msg-height")
                            .col(MessageState::MsgId)
                            .col(MessageState::BlockHeight)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(MessageState::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum MessageState {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Message this state was calculated for
    MsgId,
    /// Height of the block this state was calculated with
    BlockHeight,
    /// Timestamp of the block this was calculated for
    BlockTimestamp,
    /// Whether or not gas estimation on handle succeeds
    Processable,
    /// How much gas we expect it would cost to deliver the message; null if we
    /// could not estimate
    EstimatedGasCost,
    /// Error message when running estimateGas if there was an error; null if
    /// there was no error
    ErrorMsg,
}
