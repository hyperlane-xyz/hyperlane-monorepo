use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(IndexingCheckpoint::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(IndexingCheckpoint::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(IndexingCheckpoint::Domain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(IndexingCheckpoint::EventType)
                            .string_len(64)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(IndexingCheckpoint::Height)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(IndexingCheckpoint::TimeCreated)
                            .date_time()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(IndexingCheckpoint::TimeUpdated)
                            .date_time()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(IndexingCheckpoint::Table, IndexingCheckpoint::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(IndexingCheckpoint::Table)
                    .name("indexing_checkpoint_domain_event_type_idx")
                    .col(IndexingCheckpoint::Domain)
                    .col(IndexingCheckpoint::EventType)
                    .unique()
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(IndexingCheckpoint::Table).to_owned())
            .await
    }
}

#[derive(Iden)]
enum IndexingCheckpoint {
    Table,
    Id,
    Domain,
    EventType,
    Height,
    TimeCreated,
    TimeUpdated,
}

#[derive(Iden)]
enum Domain {
    Table,
    Id,
}
