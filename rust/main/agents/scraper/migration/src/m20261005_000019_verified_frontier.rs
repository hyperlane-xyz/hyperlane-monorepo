use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "ALTER TABLE scraper_head ADD COLUMN verified_height bigint; ALTER TABLE scraper_head ADD CONSTRAINT scraper_head_verified_height_check CHECK(verified_height IS NULL OR (verified_height>=confirmed_height AND verified_height<=indexed_height))",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("ALTER TABLE scraper_head DROP CONSTRAINT scraper_head_verified_height_check, DROP COLUMN verified_height")
            .await?;
        Ok(())
    }
}
