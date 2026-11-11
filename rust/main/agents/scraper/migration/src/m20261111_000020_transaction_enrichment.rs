use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(include_str!("transaction_enrichment.sql"))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "DROP TRIGGER transaction_dispatch_enriched ON \"transaction\";\n\
                 DROP FUNCTION notify_transaction_dispatch_enriched();",
            )
            .await?;
        // Preserve DELETE grants: a role may have held them before this migration.
        Ok(())
    }
}
