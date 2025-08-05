use sea_orm_migration::prelude::*;

use crate::m20230309_000001_create_table_domain::Domain;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Cursor::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Cursor::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Cursor::Domain).unsigned().not_null())
                    .col(
                        ColumnDef::new(Cursor::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(ColumnDef::new(Cursor::Height).big_unsigned().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Cursor::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
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

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Cursor::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum Cursor {
    Table,
    /// Unique database ID
    Id,
    /// Hyperlane domain ID the cursor is for
    Domain,
    /// Time when the record was created
    TimeCreated,
    /// Height of the last block read for finality
    Height,
}
