use std::time;
use std::time::UNIX_EPOCH;

use abacus_core::domain_id_from_name;
use sea_orm::prelude::DateTime;
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// Chain name, native currency symbol, chain id, is test net
const DOMAINS: &[(&str, &str, u64, bool)] = &[
    ("alfajores", "CELO", 44787, true),
    ("arbitrum", "ETH", 42161, false),
    ("arbitrumrinkeby", "ETH", 421611, true),
    ("avalanche", "AVAX", 43114, false),
    ("bsc", "BNB", 56, false),
    ("bsctestnet", "tBNB", 97, true),
    ("celo", "CELO", 42220, false),
    ("ethereum", "ETH", 1, false),
    ("fuji", "AVAX", 43113, true),
    ("goerli", "ETH", 5, true),
    ("kovan", "ETH", 42, true),
    ("moonbasealpha", "DEV", 1287, true),
    ("mumbai", "MATIC", 80001, true),
    ("optimism", "ETH", 10, false),
    ("optimismkovan", "ETH", 69, true),
    ("polygon", "MATIC", 137, false),
    ("test1", "ETH", 0, true),
    ("test2", "ETH", 0, true),
    ("test3", "ETH", 0, true),
];

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
                    .col(ColumnDef::new(Domain::Name).text().not_null())
                    .col(ColumnDef::new(Domain::NativeToken).text().not_null())
                    .col(ColumnDef::new(Domain::ChainId).big_unsigned().unique_key())
                    .col(ColumnDef::new(Domain::IsTestNet).boolean().not_null())
                    .to_owned(),
            )
            .await?;

        use sea_orm_migration::sea_orm::ActiveValue::{NotSet, Set};
        use sea_orm_migration::sea_orm::EntityTrait;

        let db = manager.get_connection();
        for domain in DOMAINS {
            let now = {
                let sys = time::SystemTime::now();
                let dur = sys.duration_since(UNIX_EPOCH).unwrap();
                DateTime::from_timestamp(dur.as_secs() as i64, dur.subsec_nanos())
            };

            let domain_id = domain_id_from_name(domain.0).ok_or_else(|| {
                DbErr::Custom(format!("Unable to get domain id for {}", domain.0))
            })?;
            EntityTrait::insert(domain::ActiveModel {
                id: Set(domain_id),
                time_created: Set(now),
                time_updated: Set(now),
                name: Set(domain.0.to_owned()),
                native_token: Set(domain.1.to_owned()),
                chain_id: if domain.2 == 0 { NotSet } else { Set(domain.2) },
                is_test_net: Set(domain.3),
            })
            .exec(db)
            .await?;
        }

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
pub enum Domain {
    Table,
    /// Abacus domain ID
    Id,
    /// Time of record creation
    TimeCreated,
    /// Time of the last record update
    TimeUpdated,
    /// Human readable name of the domain
    Name,
    /// Symbol for the native token
    NativeToken,
    /// For EVM compatible chains, the official EVM chain ID
    ChainId,
    /// Whether this is a test network
    IsTestNet,
}

mod domain {
    use sea_orm_migration::sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "domain")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        id: u32,
        time_created: DateTime,
        time_updated: DateTime,
        name: String,
        native_token: String,
        chain_id: u64,
        is_test_net: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
