use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(include_str!("near_head.sql"))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Restore the original trigger definitions before dropping their columns.
        // All steps share the migration transaction; a failed guard rolls back.
        super::m20260819_000012_notify_scraper_events::Migration
            .up(manager)
            .await?;
        manager
            .get_connection()
            .execute_unprepared(include_str!("near_head_down.sql"))
            .await?;
        Ok(())
    }
}
