use crate::l20220805_types::Address;
use sea_orm_migration::prelude::*;

use crate::m20220805_000001_create_table_domain::Domain;
use crate::m20220805_000001_create_type_enum_contract_type::ContractType;

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
                    .col(ColumnDef::new(Cursor::TimeUpdated).timestamp().not_null())
                    .col(ColumnDef::new_with_type(Cursor::ContractAddress, Address).not_null())
                    .col(
                        ColumnDef::new(Cursor::ContractType)
                            .custom(ContractType::Table)
                            .not_null(),
                    )
                    .col(ColumnDef::new(Cursor::Height).big_unsigned().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from_col(Cursor::Domain)
                            .to(Domain::Table, Domain::Id),
                    )
                    .to_owned(),
            )
            .await
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
    /// Abacus domain ID the cursor is for
    Domain,
    /// Address of the contract which is being scraped
    ContractAddress,
    /// Type of contract: Inbox/outbox/...
    ContractType,
    /// Time of the last record update
    TimeUpdated,
    /// Height of the last block read for finality
    Height,
}
