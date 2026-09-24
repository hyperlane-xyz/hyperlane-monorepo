use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(include_str!("near_head_checkpoints.sql"))
            .await?;
        manager
            .get_connection()
            .execute_unprepared(include_str!("frontier_publication.sql"))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(include_str!("frontier_publication_down.sql"))
            .await?;
        manager
            .get_connection()
            .execute_unprepared(include_str!("near_head_checkpoints_down.sql"))
            .await?;
        Ok(())
    }
}
