use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Keep only one current cursor row per `(domain, event_type)`.
///
/// Older scraper versions appended cursor samples and restored the latest row by
/// scanning for the max height. This migration collapses that history while
/// keeping the schema rollback-compatible with the old append-only writer.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                DELETE FROM "cursor" stale
                USING "cursor" latest
                WHERE stale.domain = latest.domain
                  AND stale.event_type = latest.event_type
                  AND (
                    latest.height,
                    latest.time_created,
                    latest.id
                  ) > (
                    stale.height,
                    stale.time_created,
                    stale.id
                  )
                "#,
            )
            .await?;

        manager
            .drop_index(
                Index::drop()
                    .table(Cursor::Table)
                    .name("cursor_domain_height_idx")
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(Cursor::Table)
                    .name("cursor_domain_idx")
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // The deleted cursor history rows cannot be recovered. Down only
        // restores the old non-unique indexes.
        manager
            .create_index(
                Index::create()
                    .table(Cursor::Table)
                    .name("cursor_domain_idx")
                    .col(Cursor::Domain)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Cursor::Table)
                    .name("cursor_domain_height_idx")
                    .col(Cursor::Domain)
                    .col(Cursor::Height)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(Iden)]
enum Cursor {
    Table,
    Domain,
    Height,
}
