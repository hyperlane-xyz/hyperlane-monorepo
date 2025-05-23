//! `SeaORM` Entity, @generated by sea-orm-codegen 1.1.1

use sea_orm::entity::prelude::*;

#[derive(Copy, Clone, Default, Debug, DeriveEntity)]
pub struct Entity;

impl EntityName for Entity {
    fn table_name(&self) -> &str {
        "domain"
    }
}

#[derive(Clone, Debug, PartialEq, DeriveModel, DeriveActiveModel, Eq)]
pub struct Model {
    pub id: i32,
    pub time_created: TimeDateTime,
    pub time_updated: TimeDateTime,
    pub name: String,
    pub native_token: String,
    pub chain_id: Option<i64>,
    pub is_test_net: bool,
    pub is_deprecated: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
pub enum Column {
    Id,
    TimeCreated,
    TimeUpdated,
    Name,
    NativeToken,
    ChainId,
    IsTestNet,
    IsDeprecated,
}

#[derive(Copy, Clone, Debug, EnumIter, DerivePrimaryKey)]
pub enum PrimaryKey {
    Id,
}

impl PrimaryKeyTrait for PrimaryKey {
    type ValueType = i32;
    fn auto_increment() -> bool {
        false
    }
}

#[derive(Copy, Clone, Debug, EnumIter)]
pub enum Relation {
    Block,
    Cursor,
    DeliveredMessage,
    Message,
}

impl ColumnTrait for Column {
    type EntityName = Entity;
    fn def(&self) -> ColumnDef {
        match self {
            Self::Id => ColumnType::Integer.def(),
            Self::TimeCreated => ColumnType::DateTime.def(),
            Self::TimeUpdated => ColumnType::DateTime.def(),
            Self::Name => ColumnType::Text.def(),
            Self::NativeToken => ColumnType::Text.def(),
            Self::ChainId => ColumnType::BigInteger.def().null(),
            Self::IsTestNet => ColumnType::Boolean.def(),
            Self::IsDeprecated => ColumnType::Boolean.def(),
        }
    }
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::Block => Entity::has_many(super::block::Entity).into(),
            Self::Cursor => Entity::has_many(super::cursor::Entity).into(),
            Self::DeliveredMessage => Entity::has_many(super::delivered_message::Entity).into(),
            Self::Message => Entity::has_many(super::message::Entity).into(),
        }
    }
}

impl Related<super::block::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Block.def()
    }
}

impl Related<super::cursor::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Cursor.def()
    }
}

impl Related<super::delivered_message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::DeliveredMessage.def()
    }
}

impl Related<super::message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Message.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
