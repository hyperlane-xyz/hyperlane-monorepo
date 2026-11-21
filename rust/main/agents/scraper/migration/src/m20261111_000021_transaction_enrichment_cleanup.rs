use sea_orm_migration::prelude::*;

// Reapply idempotent cleanup/grants to databases that already recorded migration 20.
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

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // A role may have held DELETE before this migration; retain its grants.
        Ok(())
    }
}
