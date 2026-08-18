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
            .await?;

        // Preserve explicitly keyed cursors and fan the legacy shared cursor
        // out to each event-specific watermark.
        manager
            .get_connection()
            .execute_unprepared(
                r#"
                INSERT INTO indexing_checkpoint
                    (domain, event_type, height, time_created, time_updated)
                SELECT domain, event_type, height, time_created, time_created
                FROM cursor
                WHERE event_type <> ''
                ON CONFLICT (domain, event_type) DO NOTHING;

                INSERT INTO indexing_checkpoint
                    (domain, event_type, height, time_created, time_updated)
                SELECT domain, 'ccr_swap_outbox', height, time_created, time_created
                FROM cursor
                WHERE event_type = 'ccr_swap'
                ON CONFLICT (domain, event_type) DO NOTHING;

                INSERT INTO indexing_checkpoint
                    (domain, event_type, height, time_created, time_updated)
                SELECT cursor.domain, event_type.name, cursor.height,
                       cursor.time_created, cursor.time_created
                FROM cursor
                CROSS JOIN (VALUES
                    ('hyperlane_message'),
                    ('hyperlane_message_outbox'),
                    ('delivery'),
                    ('delivery_outbox'),
                    ('interchain_gas_payment'),
                    ('interchain_gas_payment_outbox'),
                    ('merkle_tree_insertion'),
                    ('merkle_tree_insertion_outbox')
                ) AS event_type(name)
                WHERE cursor.event_type = ''
                ON CONFLICT (domain, event_type) DO NOTHING
                "#,
            )
            .await?;

        Ok(())
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
