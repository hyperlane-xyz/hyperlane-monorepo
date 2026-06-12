use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

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
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
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
