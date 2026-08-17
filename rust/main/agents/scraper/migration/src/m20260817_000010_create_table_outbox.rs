use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Outbox::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Outbox::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Outbox::Domain).unsigned().not_null())
                    .col(ColumnDef::new(Outbox::Position).big_integer().not_null())
                    .col(ColumnDef::new(Outbox::EventType).string_len(64).not_null())
                    .col(
                        ColumnDef::new(Outbox::SourceTable)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(ColumnDef::new(Outbox::SourceId).big_integer().not_null())
                    .col(ColumnDef::new(Outbox::TimeCreated).date_time().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(Outbox::Table, Outbox::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(Outbox::Table)
                    .name("outbox_domain_position_idx")
                    .col(Outbox::Domain)
                    .col(Outbox::Position)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(Outbox::Table)
                    .name("outbox_domain_event_source_idx")
                    .col(Outbox::Domain)
                    .col(Outbox::EventType)
                    .col(Outbox::SourceId)
                    .unique()
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Outbox::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum Outbox {
    Table,
    Id,
    Domain,
    Position,
    EventType,
    SourceTable,
    SourceId,
    TimeCreated,
}

#[derive(Iden)]
enum Domain {
    Table,
    Id,
}
