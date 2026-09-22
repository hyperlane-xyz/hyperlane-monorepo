use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(include_str!("batch_gas_payment_cursors.sql"))
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                SET LOCAL lock_timeout = '5s';
                SET LOCAL statement_timeout = '2min';
                LOCK TABLE gas_payment IN SHARE ROW EXCLUSIVE MODE;
                DROP TRIGGER gas_payment_stream_cursor_assign ON gas_payment;
                DROP TRIGGER gas_payment_stream_cursor_confirm ON gas_payment;
                DROP FUNCTION assign_inserted_gas_payment_stream_cursors();
                DROP FUNCTION assign_confirmed_gas_payment_stream_cursors();
                CREATE TRIGGER gas_payment_stream_cursor_assign AFTER INSERT ON gas_payment
                  FOR EACH ROW WHEN (NEW.confirmed)
                  EXECUTE FUNCTION assign_gas_payment_stream_cursor();
                CREATE TRIGGER gas_payment_stream_cursor_confirm AFTER UPDATE OF confirmed ON gas_payment
                  FOR EACH ROW WHEN (NEW.confirmed AND NOT OLD.confirmed)
                  EXECUTE FUNCTION assign_gas_payment_stream_cursor();
                "#,
            )
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
