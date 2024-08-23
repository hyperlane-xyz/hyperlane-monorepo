use sea_orm::prelude::TimeDateTime;
use sea_orm::ActiveValue::Set;
use sea_orm::{ActiveModelTrait, DbErr, DeriveMigrationName, NotSet};
use sea_orm_migration::{MigrationTrait, SchemaManager};
use time::OffsetDateTime;

use crate::async_trait;
use crate::m20240823_000006_add_injective_neutron_osmosis::domain::ActiveModel;

/// List of domain data we want to add into database.
const DOMAINS: &[RawDomain] = &[
    RawDomain {
        name: "injective",
        token: "INJ",
        domain: 6909546,
        chain_id: 6909546,
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
        name: "osmosis",
        token: "OSMO",
        domain: 875,
        chain_id: 875,
        is_test_net: false,
        is_deprecated: false,
    },
];

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        use sea_orm_migration::sea_orm::ActiveValue::{NotSet, Set};
        use sea_orm_migration::sea_orm::EntityTrait;

        let db = manager.get_connection();
        for domain in DOMAINS {
            let now = {
                let offset = OffsetDateTime::now_utc();
                TimeDateTime::new(offset.date(), offset.time())
            };

            EntityTrait::insert(ActiveModel {
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
        let db = manager.get_connection();

        for domain in DOMAINS {
            let now = {
                let offset = OffsetDateTime::now_utc();
                TimeDateTime::new(offset.date(), offset.time())
            };

            let model = ActiveModel {
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
            };

            model.delete(db).await?;
        }

        Ok(())
    }
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
