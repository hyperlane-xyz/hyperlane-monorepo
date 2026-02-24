use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Cursor::Table)
                    .add_column(
                        ColumnDef::new(Cursor::Stage)
                            .text()
                            .not_null()
                            .default("finalized"),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(Cursor::Table)
                    .name("cursor_domain_type_height_idx")
                    .col(Cursor::Domain)
                    .col(Cursor::Stage)
                    .col(Cursor::Height)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .table(Cursor::Table)
                    .name("cursor_domain_type_height_idx")
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Cursor::Table)
                    .drop_column(Cursor::Stage)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }
}

#[derive(Iden)]
enum Cursor {
    Table,
    Domain,
    Height,
    #[iden = "cursor_type"]
    Stage,
}
