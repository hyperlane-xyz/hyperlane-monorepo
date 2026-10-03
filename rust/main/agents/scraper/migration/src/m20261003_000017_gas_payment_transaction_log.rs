use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                SET LOCAL lock_timeout = '5s';
                DROP INDEX gas_payment_block_log;
                CREATE UNIQUE INDEX gas_payment_block_log
                  ON gas_payment(domain, block_hash, transaction_index, log_index)
                  WHERE block_hash IS NOT NULL;
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                SET LOCAL lock_timeout = '5s';
                DROP INDEX gas_payment_block_log;
                CREATE UNIQUE INDEX gas_payment_block_log
                  ON gas_payment(domain, block_hash, log_index)
                  WHERE block_hash IS NOT NULL;
                "#,
            )
            .await?;
        Ok(())
    }
}
