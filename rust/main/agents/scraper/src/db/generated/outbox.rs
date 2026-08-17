//! `SeaORM` Entity for websocket outbox rows.

use sea_orm::entity::prelude::*;

#[derive(Copy, Clone, Default, Debug, DeriveEntity)]
pub struct Entity;

impl EntityName for Entity {
    fn table_name(&self) -> &str {
        "outbox"
    }
}

#[derive(Clone, Debug, PartialEq, DeriveModel, DeriveActiveModel)]
pub struct Model {
    pub id: i64,
    pub domain: i32,
    pub position: i64,
    pub event_type: String,
    pub source_table: String,
    pub source_id: i64,
    pub time_created: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
pub enum Column {
    Id,
    Domain,
    Position,
    EventType,
    SourceTable,
    SourceId,
    TimeCreated,
}

#[derive(Copy, Clone, Debug, EnumIter, DerivePrimaryKey)]
pub enum PrimaryKey {
    Id,
}

impl PrimaryKeyTrait for PrimaryKey {
    type ValueType = i64;
    fn auto_increment() -> bool {
        true
    }
}

#[derive(Copy, Clone, Debug, EnumIter)]
pub enum Relation {
    Domain,
}

impl ColumnTrait for Column {
    type EntityName = Entity;
    fn def(&self) -> ColumnDef {
        match self {
            Self::Id => ColumnType::BigInteger.def(),
            Self::Domain => ColumnType::Integer.def(),
            Self::Position => ColumnType::BigInteger.def(),
            Self::EventType => ColumnType::String(StringLen::N(64)).def(),
            Self::SourceTable => ColumnType::String(StringLen::N(64)).def(),
            Self::SourceId => ColumnType::BigInteger.def(),
            Self::TimeCreated => ColumnType::DateTime.def(),
        }
    }
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::Domain => Entity::belongs_to(super::domain::Entity)
                .from(Column::Domain)
                .to(super::domain::Column::Id)
                .into(),
        }
    }
}

impl Related<super::domain::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Domain.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
