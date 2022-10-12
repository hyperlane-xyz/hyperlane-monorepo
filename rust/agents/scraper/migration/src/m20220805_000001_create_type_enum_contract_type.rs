use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::strum::{EnumIter, IntoEnumIterator as _};

use crate::extension::postgres::Type;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_type(
                Type::create()
                    .as_enum(ContractType::Table)
                    .values(ContractType::iter().skip(1))
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_type(Type::drop().name(ContractType::Table).to_owned())
            .await
    }
}

#[derive(EnumIter, Iden)]
pub enum ContractType {
    Table,
    Outbox,
    Inbox,
    InterchainGasPaymaster,
    ValidatorManager,
}
