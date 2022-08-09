use crate::l20220805_000001_types::*;
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Domain::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Domain::Id)
                            .unsigned()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Domain::TimeCreated).timestamp().not_null())
                    .col(ColumnDef::new(Domain::TimeUpdated).timestamp().not_null())
                    .col(ColumnDef::new(Domain::Name).char().not_null())
                    .col(ColumnDef::new(Domain::NativeToken).char().not_null())
                    .col(ColumnDef::new(Domain::ChainId).big_unsigned())
                    .col(ColumnDef::new(Domain::IsTestNet).boolean().not_null())
                    .to_owned(),
            )
            .await?;
        let db = manager.get_connection();
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Domain::Table).to_owned())
            .await
    }
}

/// Learn more at https://docs.rs/sea-query#iden
#[derive(Iden)]
enum Domain {
    Table,
    /// Abacus domain ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Time of the last record update
    TimeUpdated,
    /// Human readable name of the domain
    Name,
    /// Name of the native token
    NativeToken,
    /// For EVM compatible chains, the official EVM chain ID
    ChainId,
    /// Whether this is a test network
    IsTestNet,
}

mod domain {
    use sea_orm_migration::sea_orm::entity::prelude::*;
    use sea_orm_migration::sea_orm::prelude::*;
    use sea_orm_migration::sea_orm::{DerivePrimaryKey, EnumIter};

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "domain")]
    struct Model {
        #[sea_orm(primary_key)]
        id: u32,
        time_created: DateTime,
        time_updated: DateTime,
        name: String,
        native_token: String,
        chain_id: u64,
        is_test_net: bool,
    }
}
