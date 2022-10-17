use sea_orm_migration::prelude::*;

use crate::m20220805_000001_create_type_enum_checkpoint_update::CheckpointUpdateType;
use crate::m20220805_000003_create_table_checkpoint::Checkpoint;
use crate::m20220805_000003_create_table_transaction::Transaction;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(CheckpointUpdate::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(CheckpointUpdate::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(CheckpointUpdate::TimeCreated)
                            .timestamp()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CheckpointUpdate::CheckpointId)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CheckpointUpdate::UpdateType)
                            .custom(CheckpointUpdateType::Table)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CheckpointUpdate::TxId)
                            .big_integer()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(CheckpointUpdate::CheckpointId)
                            .to(Checkpoint::Table, Checkpoint::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(CheckpointUpdate::TxId)
                            .to(Transaction::Table, Transaction::Id),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("checkpoint_update_checkpoint_idx")
                    .table(CheckpointUpdate::Table)
                    .col(CheckpointUpdate::CheckpointId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(CheckpointUpdate::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum CheckpointUpdate {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Checkpoint this is an update for.
    CheckpointId,
    /// What this update is.
    UpdateType,
    /// Transaction the update was made in.
    TxId,
}
