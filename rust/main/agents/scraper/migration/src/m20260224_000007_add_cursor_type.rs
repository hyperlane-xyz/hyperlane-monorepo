use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let table = Cursor::Table.to_string();
        let cursor_type = Cursor::Stage.to_string();
        let domain = Cursor::Domain.to_string();
        let height = Cursor::Height.to_string();
        let index_name = "cursor_domain_type_height_idx";

        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"
                ALTER TABLE "{table}"
                ADD COLUMN IF NOT EXISTS "{cursor_type}" TEXT NOT NULL DEFAULT 'finalized'
                "#
            ))
            .await?;

        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"
                CREATE INDEX IF NOT EXISTS "{index_name}"
                ON "{table}" ("{domain}", "{cursor_type}", "{height}")
                "#
            ))
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let table = Cursor::Table.to_string();
        let cursor_type = Cursor::Stage.to_string();
        let index_name = "cursor_domain_type_height_idx";

        manager
            .get_connection()
            .execute_unprepared(&format!(r#"DROP INDEX IF EXISTS "{index_name}""#))
            .await?;

        manager
            .get_connection()
            .execute_unprepared(&format!(
                r#"ALTER TABLE "{table}" DROP COLUMN IF EXISTS "{cursor_type}""#
            ))
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
