use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Add `msg_body` to raw dispatches so the scraper can reconcile raw rows into
/// complete message rows without re-reading historical logs.
///
/// The reconciliation index is created by the
/// `create-raw-dispatch-reconciliation-index` bin because Postgres requires
/// `CREATE INDEX CONCURRENTLY` to run outside a transaction, while SeaORM wraps
/// Postgres migrations in one transaction.
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(RawMessageDispatch::Table)
                    .add_column(ColumnDef::new(RawMessageDispatch::MsgBody).binary())
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS raw_message_dispatch_reconciliation_idx")
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(RawMessageDispatch::Table)
                    .drop_column(RawMessageDispatch::MsgBody)
                    .to_owned(),
            )
            .await
    }
}

#[derive(Iden)]
enum RawMessageDispatch {
    Table,
    MsgBody,
}
