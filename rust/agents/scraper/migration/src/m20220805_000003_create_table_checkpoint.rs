use sea_orm_migration::prelude::*;

use crate::l20220805_types::*;
use crate::m20220805_000001_create_table_domain::Domain;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Checkpoint::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Checkpoint::Id)
                            .big_integer()
                            .not_null()
                            .auto_increment()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Checkpoint::TimeCreated)
                            .timestamp()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Checkpoint::Timestamp).timestamp().not_null())
                    .col(ColumnDef::new(Checkpoint::Signature).binary().not_null())
                    .col(ColumnDef::new_with_type(Checkpoint::Validator, Address).not_null())
                    .col(ColumnDef::new_with_type(Checkpoint::Root, Hash).not_null())
                    .col(ColumnDef::new(Checkpoint::Index).unsigned().not_null())
                    .col(
                        ColumnDef::new(Checkpoint::OriginDomain)
                            .unsigned()
                            .not_null(),
                    )
                    .col(ColumnDef::new_with_type(Checkpoint::OutboxAddress, Address).not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Checkpoint::OriginDomain)
                            .to(Domain::Table, Domain::DomainId),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(Checkpoint::Table)
                    .name("idx-outbox-domain-index")
                    .col(Checkpoint::OutboxAddress)
                    .col(Checkpoint::OriginDomain)
                    .col(Checkpoint::Index)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Checkpoint::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
pub enum Checkpoint {
    Table,
    /// Unique database ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Time the checkpoint was made
    Timestamp,
    /// Validator's signature that this is a valid checkpoint
    Signature,
    /// Address of the validator
    Validator,
    /// Merkle tree root hash
    Root,
    /// Highest leaf index this checkpoint includes
    Index,
    /// Domain of the origin chain this checkpoint was made for.
    OriginDomain,
    /// Address of the outbox this checkpoint was made for
    OutboxAddress,
}
