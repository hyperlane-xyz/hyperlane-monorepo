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
    // ---------- Begin: Mainnets and Testnets (alphabetically sorted) -------------
    RawDomain {
        name: "alfajores",
        token: "CELO",
        domain: 44787,
        chain_id: 44787,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "ancient8",
        token: "ETH",
        domain: 888888888,
        chain_id: 888888888,
        is_test_net: false,
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
        name: "arbitrumsepolia",
        token: "ETH",
        domain: 421614,
        chain_id: 421614,
        is_test_net: true,
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
        name: "basesepolia",
        token: "ETH",
        domain: 84532,
        chain_id: 84532,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "blast",
        token: "ETH",
        domain: 81457,
        chain_id: 81457,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "bob",
        token: "ETH",
        domain: 60808,
        chain_id: 60808,
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
        name: "cheesechain",
        token: "CHEESE",
        domain: 383353,
        chain_id: 383353,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "connextsepolia",
        token: "ETH",
        domain: 6398,
        chain_id: 6398,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "eclipsemainnet",
        token: "ETH",
        domain: 1408864445,
        chain_id: 1408864445,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "eclipsetestnet",
        token: "ETH",
        domain: 239092742,
        chain_id: 239092742,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "ecotestnet",
        token: "ETH",
        domain: 471923,
        chain_id: 471923,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "endurance",
        token: "ETH",
        domain: 648,
        chain_id: 648,
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
        name: "fraxtal",
        token: "frxETH",
        domain: 252,
        chain_id: 252,
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
        name: "fusemainnet",
        token: "ETH",
        domain: 122,
        chain_id: 122,
        is_test_net: false,
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
        name: "immutablezkevm",
        token: "IMX",
        domain: 13371,
        chain_id: 13371,
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
        name: "injective",
        token: "INJ",
        domain: 6909546,
        chain_id: 6909546,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "linea",
        token: "ETH",
        domain: 59144,
        chain_id: 59144,
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
        name: "mantle",
        token: "MNT",
        domain: 5000,
        chain_id: 5000,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "mode",
        token: "ETH",
        domain: 34443,
        chain_id: 34443,
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
        name: "neutron",
        token: "NTRN",
        domain: 1853125230,
        chain_id: 1853125230,
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
        name: "optimismsepolia",
        token: "ETH",
        domain: 11155420,
        chain_id: 11155420,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "osmosis",
        token: "OSMO",
        domain: 875,
        chain_id: 875,
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
        name: "polygonanoy",
        token: "MATIC",
        domain: 80002,
        chain_id: 80002,
        is_test_net: true,
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
        name: "sei",
        token: "SEI",
        domain: 1329,
        chain_id: 1329,
        is_test_net: false,
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
        name: "solanamainnet",
        token: "SOL",
        domain: 1399811149,
        chain_id: 1399811149,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "solanatestnet",
        token: "SOL",
        domain: 1399811150,
        chain_id: 1399811150,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "stride",
        token: "STRD",
        domain: 745,
        chain_id: 745,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "superpositiontestnet",
        token: "SPN",
        domain: 98985,
        chain_id: 98985,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "taiko",
        token: "ETH",
        domain: 167000,
        chain_id: 167000,
        is_test_net: false,
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
        name: "xlayer",
        token: "OKB",
        domain: 196,
        chain_id: 196,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "worldchain",
        token: "ETH",
        domain: 480,
        chain_id: 480,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "zircuit",
        token: "ETH",
        domain: 48900,
        chain_id: 48900,
        is_test_net: false,
        is_deprecated: false,
    },
    RawDomain {
        name: "zoramainnet",
        token: "ETH",
        domain: 7777777,
        chain_id: 7777777,
        is_test_net: false,
        is_deprecated: false,
    },
    // ---------- End: Mainnets and Testnets (alphabetically sorted) ---------------
    // ---------- Begin: E2E tests chains ------------------------------------------
    RawDomain {
        name: "test1",
        token: "ETH",
        domain: 9913371,
        chain_id: 0,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "test2",
        token: "ETH",
        domain: 9913372,
        chain_id: 0,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "test3",
        token: "ETH",
        domain: 9913373,
        chain_id: 0,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "cosmostest99990",
        token: "OSMO",
        domain: 99990,
        chain_id: 99990,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "cosmostest99991",
        token: "OSMO",
        domain: 99991,
        chain_id: 99991,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "sealeveltest1",
        token: "SOL",
        domain: 13375,
        chain_id: 13375,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "sealeveltest2",
        token: "SOL",
        domain: 13376,
        chain_id: 13376,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "cosmostestnative1",
        token: "KYVE",
        domain: 75898670,
        chain_id: 75898670,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "cosmostestnative2",
        token: "KYVE",
        domain: 75898671,
        chain_id: 75898671,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "starknettest23448593",
        token: "ETH",
        domain: 23448593,
        chain_id: 23448593,
        is_test_net: true,
        is_deprecated: false,
    },
    RawDomain {
        name: "starknettest23448594",
        token: "ETH",
        domain: 23448594,
        chain_id: 23448594,
        is_test_net: true,
        is_deprecated: false,
    },
    // ---------- End: E2E tests chains ----------------
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
                    .col(ColumnDef::new(Domain::ChainId).big_unsigned())
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
