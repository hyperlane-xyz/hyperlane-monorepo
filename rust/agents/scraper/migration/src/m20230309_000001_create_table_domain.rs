use sea_orm::prelude::TimeDateTime;
use time::OffsetDateTime;

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
        domain: 44787,
        chain_id: 44787,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "arbitrum",
        token: "ETH",
        domain: 42161,
        chain_id: 42161,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "avalanche",
        token: "AVAX",
        domain: 43114,
        chain_id: 43114,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "base",
        token: "ETH",
        domain: 8453,
        chain_id: 8453,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "bsc",
        token: "BNB",
        domain: 56,
        chain_id: 56,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "bsctestnet",
        token: "tBNB",
        domain: 97,
        chain_id: 97,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "celo",
        token: "CELO",
        domain: 42220,
        chain_id: 42220,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "ethereum",
        token: "ETH",
        domain: 1,
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
        name: "gnosis",
        token: "xDAI",
        domain: 100,
        chain_id: 100,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "mantapacific",
        token: "ETH",
        domain: 169,
        chain_id: 169,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "moonbasealpha",
        token: "DEV",
        domain: 1287,
        chain_id: 1287,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "moonbeam",
        token: "GLMR",
        domain: 1284,
        chain_id: 1284,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "optimism",
        token: "ETH",
        domain: 10,
        chain_id: 10,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "polygon",
        token: "MATIC",
        domain: 137,
        chain_id: 137,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "polygonzkevm",
        token: "ETH",
        domain: 1101,
        chain_id: 1101,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "scroll",
        token: "ETH",
        domain: 534352,
        chain_id: 534352,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "scrollsepolia",
        token: "ETH",
        domain: 534351,
        chain_id: 534351,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "sepolia",
        token: "ETH",
        domain: 11155111,
        chain_id: 11155111,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "viction",
        token: "VIC",
        domain: 88,
        chain_id: 88,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "inevm",
        token: "INJ",
        domain: 2525,
        chain_id: 2525,
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
                let offset = OffsetDateTime::now_utc();
                TimeDateTime::new(offset.date(), offset.time())
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
    /// Hyperlane domain ID
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
        time_created: TimeDateTime,
        time_updated: TimeDateTime,
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
