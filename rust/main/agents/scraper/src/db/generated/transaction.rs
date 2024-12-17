//! `SeaORM` Entity, @generated by sea-orm-codegen 1.1.1

use sea_orm::entity::prelude::*;

#[derive(Copy, Clone, Default, Debug, DeriveEntity)]
pub struct Entity;

impl EntityName for Entity {
    fn table_name(&self) -> &str {
        "transaction"
    }
}

/// @NOTE: Replaced all occurrences of `Decimal` with `BigDecimal`
/// due to the following issue: https://github.com/SeaQL/sea-orm/issues/1530
#[derive(Clone, Debug, PartialEq, DeriveModel, DeriveActiveModel, Eq)]
pub struct Model {
    pub id: i64,
    pub time_created: TimeDateTime,
    pub hash: Vec<u8>,
    pub block_id: i64,
    pub gas_limit: BigDecimal,
    pub max_priority_fee_per_gas: Option<BigDecimal>,
    pub max_fee_per_gas: Option<BigDecimal>,
    pub gas_price: Option<BigDecimal>,
    pub effective_gas_price: Option<BigDecimal>,
    pub nonce: i64,
    pub sender: Vec<u8>,
    pub recipient: Option<Vec<u8>>,
    pub gas_used: BigDecimal,
    pub cumulative_gas_used: BigDecimal,
    pub raw_input_data: Option<Vec<u8>>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveColumn)]
pub enum Column {
    Id,
    TimeCreated,
    Hash,
    BlockId,
    GasLimit,
    MaxPriorityFeePerGas,
    MaxFeePerGas,
    GasPrice,
    EffectiveGasPrice,
    Nonce,
    Sender,
    Recipient,
    GasUsed,
    CumulativeGasUsed,
    RawInputData,
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
    Block,
    DeliveredMessage,
    GasPayment,
    Message,
}

impl ColumnTrait for Column {
    type EntityName = Entity;
    fn def(&self) -> ColumnDef {
        match self {
            Self::Id => ColumnType::BigInteger.def(),
            Self::TimeCreated => ColumnType::DateTime.def(),
            Self::Hash => ColumnType::VarBinary(StringLen::None).def().unique(),
            Self::BlockId => ColumnType::BigInteger.def(),
            Self::GasLimit => ColumnType::Decimal(Some((78u32, 0u32))).def(),
            Self::MaxPriorityFeePerGas => ColumnType::Decimal(Some((78u32, 0u32))).def().null(),
            Self::MaxFeePerGas => ColumnType::Decimal(Some((78u32, 0u32))).def().null(),
            Self::GasPrice => ColumnType::Decimal(Some((78u32, 0u32))).def().null(),
            Self::EffectiveGasPrice => ColumnType::Decimal(Some((78u32, 0u32))).def().null(),
            Self::Nonce => ColumnType::BigInteger.def(),
            Self::Sender => ColumnType::VarBinary(StringLen::None).def(),
            Self::Recipient => ColumnType::VarBinary(StringLen::None).def().null(),
            Self::GasUsed => ColumnType::Decimal(Some((78u32, 0u32))).def(),
            Self::CumulativeGasUsed => ColumnType::Decimal(Some((78u32, 0u32))).def(),
            Self::RawInputData => ColumnType::VarBinary(StringLen::None).def().null(),
        }
    }
}

impl RelationTrait for Relation {
    fn def(&self) -> RelationDef {
        match self {
            Self::Block => Entity::belongs_to(super::block::Entity)
                .from(Column::BlockId)
                .to(super::block::Column::Id)
                .into(),
            Self::DeliveredMessage => Entity::has_many(super::delivered_message::Entity).into(),
            Self::GasPayment => Entity::has_many(super::gas_payment::Entity).into(),
            Self::Message => Entity::has_many(super::message::Entity).into(),
        }
    }
}

impl Related<super::block::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Block.def()
    }
}

impl Related<super::delivered_message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::DeliveredMessage.def()
    }
}

impl Related<super::gas_payment::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::GasPayment.def()
    }
}

impl Related<super::message::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Message.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
