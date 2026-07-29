use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Add an `event_type` column to the `cursor` table so that different indexers
/// (messages, CCR swaps, etc.) can maintain independent watermarks per domain.
/// Existing rows are backfilled with '' (the implicit value for the message indexer).
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Cursor::Table)
                    .add_column(
                        ColumnDef::new(Cursor::EventType)
                            .string_len(64)
                            .not_null()
                            .default(""),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(Cursor::Table)
                    .name("cursor_domain_event_type_idx")
                    .col(Cursor::Domain)
                    .col(Cursor::EventType)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .table(Cursor::Table)
                    .name("cursor_domain_event_type_idx")
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Cursor::Table)
                    .drop_column(Cursor::EventType)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum Cursor {
    Table,
    Domain,
    EventType,
}
