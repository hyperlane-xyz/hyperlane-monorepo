use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "merkle_tree_insertion")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i64,
    pub domain: i32,
    pub merkle_tree_hook: Vec<u8>,
    pub leaf_index: i32,
    pub message_id: Vec<u8>,
    pub block_number: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::domain::Entity",
        from = "Column::Domain",
        to = "super::domain::Column::Id"
    )]
    Domain,
}

impl Related<super::domain::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Domain.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
