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
                CREATE TEMP TABLE cursor_survivors ON COMMIT DROP AS
                SELECT DISTINCT ON (domain, event_type)
                  id,
                  domain,
                  time_created,
                  height,
                  event_type
                FROM "cursor"
                ORDER BY domain, event_type, height DESC, time_created DESC, id DESC;

                TRUNCATE TABLE "cursor";

                INSERT INTO "cursor" (id, domain, time_created, height, event_type)
                SELECT id, domain, time_created, height, event_type
                FROM cursor_survivors;
                "#,
            )
            .await?;

        manager
            .drop_index(
                Index::drop()
                    .table(Cursor::Table)
                    .name("cursor_domain_height_idx")
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(Cursor::Table)
                    .name("cursor_domain_idx")
                    .to_owned(),
            )
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .table(Cursor::Table)
                    .name("cursor_domain_event_type_idx")
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Cursor::Table)
                    .name("cursor_domain_event_type_idx")
                    .col(Cursor::Domain)
                    .col(Cursor::EventType)
                    .unique()
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
                    .name("cursor_domain_event_type_idx")
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Cursor::Table)
                    .name("cursor_domain_event_type_idx")
                    .col(Cursor::Domain)
                    .col(Cursor::EventType)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Cursor::Table)
                    .name("cursor_domain_idx")
                    .col(Cursor::Domain)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Cursor::Table)
                    .name("cursor_domain_height_idx")
                    .col(Cursor::Domain)
                    .col(Cursor::Height)
                    .index_type(IndexType::BTree)
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
    EventType,
    Height,
}
