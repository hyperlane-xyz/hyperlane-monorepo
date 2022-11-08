use std::time;
use std::time::UNIX_EPOCH;

use sea_orm::prelude::DateTime;
use sea_orm_migration::prelude::*;

/// List of domain data we want to initialize the database with.
///
/// This needs to be immutable because once we create the tables, we need to
/// make additional migrations to make changes, otherwise we have to rollback
/// everything to apply the new version of this migration again. Admittedly we
/// will reset the database every so often so it isn't as big of a deal, but I
/// want to try and support not having to do that.
///
/// This is why it does not use the domain id lookup tools in the library which
/// are subject to change as we deprecate and add new ones.
const DOMAINS: &[RawDomain] = &[
    RawDomain {
        name: "alfajores",
        token: "CELO",
        domain: 1000,
        chain_id: 44787,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "arbitrum",
        token: "ETH",
        domain: 6386274,
        chain_id: 42161,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "arbitrumgoerli",
        token: "ETH",
        domain: 421613,
        chain_id: 421613,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "arbitrumrinkeby",
        token: "ETH",
        domain: 0x61722d72,
        chain_id: 421611,
        is_test_net: true,
        is_deprecated: true,
    },
    RawDomain {
        name: "auroratestnet",
        token: "ETH",
        domain: 0x61752d74,
        chain_id: 1313161555,
        is_test_net: true,
        is_deprecated: true,
    },
    RawDomain {
        name: "avalanche",
        token: "AVAX",
        domain: 0x61766178,
        chain_id: 43114,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "bsc",
        token: "BNB",
        domain: 6452067,
        chain_id: 56,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "bsctestnet",
        token: "tBNB",
        domain: 0x62732d74,
        chain_id: 97,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "celo",
        token: "CELO",
        domain: 0x63656c6f,
        chain_id: 42220,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "ethereum",
        token: "ETH",
        domain: 0x657468,
        chain_id: 1,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "fuji",
        token: "AVAX",
        domain: 43113,
        chain_id: 43113,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "goerli",
        token: "ETH",
        domain: 5,
        chain_id: 5,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "kovan",
        token: "ETH",
        domain: 3000,
        chain_id: 42,
        is_test_net: true,
        is_deprecated: true,
    },
    RawDomain {
        name: "moonbasealpha",
        token: "DEV",
        domain: 0x6d6f2d61,
        chain_id: 1287,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "moonbeam",
        token: "GLMR",
        domain: 0x6d6f2d6d,
        chain_id: 1284,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "mumbai",
        token: "MATIC",
        domain: 80001,
        chain_id: 80001,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "optimism",
        token: "ETH",
        domain: 28528,
        chain_id: 10,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "optimismgoerli",
        token: "ETH",
        domain: 420,
        chain_id: 420,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "optimismkovan",
        token: "ETH",
        domain: 0x6f702d6b,
        chain_id: 69,
        is_test_net: true,
        is_deprecated: true,
    },
    RawDomain {
        name: "polygon",
        token: "MATIC",
        domain: 0x706f6c79,
        chain_id: 137,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "test1",
        token: "ETH",
        domain: 13371,
        chain_id: 0,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "test2",
        token: "ETH",
        domain: 13372,
        chain_id: 0,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "test3",
        token: "ETH",
        domain: 13373,
        chain_id: 0,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "zksync2testnet",
        token: "ETH",
        domain: 280,
        chain_id: 280,
        is_test_net: true,
        is_deprecated: false,
    },
];

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
                    .col(
                        ColumnDef::new(Domain::TimeCreated)
                            .timestamp()
                            .not_null()
                            .default("NOW()"),
                    )
                    .col(ColumnDef::new(Domain::TimeUpdated).timestamp().not_null())
                    .col(ColumnDef::new(Domain::Name).text().not_null())
                    .col(ColumnDef::new(Domain::NativeToken).text().not_null())
                    .col(ColumnDef::new(Domain::ChainId).big_unsigned().unique_key())
                    .col(ColumnDef::new(Domain::IsTestNet).boolean().not_null())
                    .col(ColumnDef::new(Domain::IsDeprecated).boolean().not_null())
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

            EntityTrait::insert(domain::ActiveModel {
                id: Set(domain.domain),
                time_created: Set(now),
                time_updated: Set(now),
                name: Set(domain.name.to_owned()),
                native_token: Set(domain.token.to_owned()),
                chain_id: if domain.chain_id == 0 {
                    // this is to support testnets and maybe in the future chains without chain ids.
                    NotSet
                } else {
                    Set(domain.chain_id)
                },
                is_test_net: Set(domain.is_test_net),
                is_deprecated: Set(domain.is_deprecated),
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
    /// Whether this domain has been decommissioned from active use.
    IsDeprecated,
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
        is_deprecated: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

struct RawDomain {
    name: &'static str,
    token: &'static str,
    domain: u32,
    chain_id: u64,
    is_test_net: bool,
    is_deprecated: bool,
}
