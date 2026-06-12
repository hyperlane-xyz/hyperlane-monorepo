use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Add `msg_body` to raw dispatches so the scraper can reconcile raw rows into
/// complete message rows without re-reading historical logs. Also adds the
/// index used by the reconciliation anti-join scan.
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

        manager
            .get_connection()
            .execute_unprepared(
                r#"
                CREATE INDEX raw_message_dispatch_reconciliation_idx
                ON raw_message_dispatch (origin_domain, origin_mailbox, id)
                WHERE msg_body IS NOT NULL
                "#,
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .table(RawMessageDispatch::Table)
                    .name("raw_message_dispatch_reconciliation_idx")
                    .to_owned(),
            )
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
