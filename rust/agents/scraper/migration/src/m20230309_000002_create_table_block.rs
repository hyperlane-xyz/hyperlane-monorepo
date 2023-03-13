use sea_orm::ConnectionTrait;
use sea_orm_migration::prelude::*;

use crate::l20230309_types::*;
use crate::m20230309_000001_create_table_domain::Domain;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Block::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Block::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Block::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(ColumnDef::new(Block::Domain).unsigned().not_null())
                    .col(
                        ColumnDef::new_with_type(Block::Hash, Hash)
                            .unique_key()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Block::Height).big_unsigned().not_null())
                    .col(ColumnDef::new(Block::Timestamp).timestamp().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Block::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .index(
                        Index::create()
                            .col(Block::Domain)
                            .col(Block::Height)
                            .unique(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(Block::Table)
                    .name("block_hash_idx")
                    .col(Block::Hash)
                    .index_type(IndexType::Hash)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .table(Block::Table)
                    .name("block_timestamp_idx")
                    .col(Block::Timestamp)
                    .index_type(IndexType::BTree)
                    .to_owned(),
            )
            .await?;

        // manager.get_connection().execute_unprepared(&format!(
        //     r#"
        //         CREATE VIEW "{block_table}_view" AS
        //         SELECT
        //             "{block_table}"."{block_id}" AS "id",
        //             "{block_table}"."{block_time_created}" AS "time_created",
        //             "{block_table}"."{block_domain}" as "domain_id",
        //             "{domain_table}"."{domain_name}" AS "domain",
        //             "{domain_table}"."{domain_chain_id}" AS "chain_id",
        //             concat('0x', encode("{block_table}"."{block_hash}"::bytea, 'hex')) AS "hash",
        //             "{block_table}"."{block_height}" AS "height",
        //             "{block_table}"."{block_timestamp}" AS "timestamp"
        //         FROM "{block_table}"
        //             INNER JOIN "{domain_table}"
        //                 ON "{domain_table}"."{domain_id}" = "{block_table}"."{block_domain}"
        //     "#,
        //     block_table=Block::Table.to_string(),
        //     block_id=Block::Id.to_string(),
        //     block_time_created=Block::TimeCreated.to_string(),
        //     block_domain=Block::Domain.to_string(),
        //     block_hash=Block::Hash.to_string(),
        //     block_height=Block::Height.to_string(),
        //     block_timestamp=Block::Timestamp.to_string(),
        //
        //     domain_table=Domain::Table.to_string(),
        //     domain_id=Domain::Id.to_string(),
        //     domain_name=Domain::Name.to_string(),
        //     domain_chain_id=Domain::ChainId.to_string(),
        // )).await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // manager
        //     .get_connection()
        //     .execute_unprepared(&format!(
        //         r#"DROP VIEW IF EXISTS "{}_view""#,
        //         Block::Table.to_string()
        //     ))
        //     .await?;
        manager
            .drop_table(Table::drop().table(Block::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum Block {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Domain id the block is on
    Domain,
    /// Block hash
    Hash,
    /// Block height
    Height,
    /// Time the block was created at
    Timestamp,
}
