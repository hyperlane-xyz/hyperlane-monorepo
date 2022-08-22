use sea_orm_migration::prelude::*;

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
                            .enumeration("CheckpointUpdateType", &["Premature", "Fraudulent"])
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(CheckpointUpdate::TxId)
                            .big_integer()
                            .not_null(),
                    )
                    .index(
                        Index::create()
                            .name("idx-checkpoint")
                            .col(CheckpointUpdate::CheckpointId),
                    )
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
enum CheckpointUpdate {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    CheckpointId,
    UpdateType,
    TxId,
}
