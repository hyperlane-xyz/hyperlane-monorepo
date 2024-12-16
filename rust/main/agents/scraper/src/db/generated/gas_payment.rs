//! `SeaORM` Entity, @generated by sea-orm-codegen 1.1.1

use sea_orm::entity::prelude::*;

#[derive(Copy, Clone, Default, Debug, DeriveEntity)]
pub struct Entity;

impl EntityName for Entity {
    fn table_name(&self) -> &str {
        "gas_payment"
    }
}

/// @NOTE: Replaced all occurrences of `Decimal` with `BigDecimal`
/// due to the following issue: https://github.com/SeaQL/sea-orm/issues/1530
#[derive(Clone, Debug, PartialEq, DeriveModel, DeriveActiveModel, Eq)]
pub struct Model {
    pub id: i64,
    pub time_created: TimeDateTime,
    pub domain: i32,
    pub msg_id: Vec<u8>,
    pub payment: BigDecimal,
    pub gas_amount: BigDecimal,
    pub tx_id: i64,
    pub log_index: i64,
    pub origin: i32,
    pub destination: i32,
    pub interchain_gas_paymaster: Vec<u8>,
    pub sequence: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
pub enum Column {
    Id,
    TimeCreated,
    Domain,
    MsgId,
    Payment,
    GasAmount,
    TxId,
    LogIndex,
    Origin,
    Destination,
    InterchainGasPaymaster,
    Sequence,
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
    Domain2,
    Domain1,
    Transaction,
}

impl ColumnTrait for Column {
    type EntityName = Entity;
    fn def(&self) -> ColumnDef {
        match self {
            Self::Id => ColumnType::BigInteger.def(),
            Self::TimeCreated => ColumnType::DateTime.def(),
            Self::Domain => ColumnType::Integer.def(),
            Self::MsgId => ColumnType::VarBinary(StringLen::None).def(),
            Self::Payment => ColumnType::Decimal(Some((78u32, 0u32))).def(),
            Self::GasAmount => ColumnType::Decimal(Some((78u32, 0u32))).def(),
            Self::TxId => ColumnType::BigInteger.def(),
            Self::LogIndex => ColumnType::BigInteger.def(),
            Self::Origin => ColumnType::Integer.def(),
            Self::Destination => ColumnType::Integer.def(),
            Self::InterchainGasPaymaster => ColumnType::VarBinary(StringLen::None).def(),
            Self::Sequence => ColumnType::BigInteger.def().null(),
        }
    }
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::Domain2 => Entity::belongs_to(super::domain::Entity)
                .from(Column::Domain)
                .to(super::domain::Column::Id)
                .into(),
            Self::Domain1 => Entity::belongs_to(super::domain::Entity)
                .from(Column::Origin)
                .to(super::domain::Column::Id)
                .into(),
            Self::Transaction => Entity::belongs_to(super::transaction::Entity)
                .from(Column::TxId)
                .to(super::transaction::Column::Id)
                .into(),
        }
    }
}

impl Related<super::transaction::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Transaction.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
