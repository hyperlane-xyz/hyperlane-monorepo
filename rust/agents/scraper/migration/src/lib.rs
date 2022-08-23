#![deny(dead_code)]

extern crate core;

pub use sea_orm_migration::prelude::*;

mod l20220805_types;
mod m20220805_000001_create_table_domain;
mod m20220805_000001_create_type_enum_checkpoint_update;
mod m20220805_000002_create_table_block;

mod m20220805_000003_create_table_checkpoint;
mod m20220805_000003_create_table_cursor;
mod m20220805_000003_create_table_transaction;
mod m20220805_000004_create_table_checkpoint_update;
mod m20220805_000004_create_table_gas_payment;
mod m20220805_000004_create_table_message;
mod m20220805_000005_create_table_delivered_message;
mod m20220805_000005_create_table_message_state;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        // This order is important, grouped by a topological sort, within each group
        // should not matter what order it is. (topology group defined by the
        // last number)
        vec![
            Box::new(m20220805_000001_create_table_domain::Migration),
            Box::new(m20220805_000001_create_type_enum_checkpoint_update::Migration),
            Box::new(m20220805_000002_create_table_block::Migration),
            Box::new(m20220805_000003_create_table_checkpoint::Migration),
            Box::new(m20220805_000003_create_table_cursor::Migration),
            Box::new(m20220805_000003_create_table_transaction::Migration),
            Box::new(m20220805_000004_create_table_checkpoint_update::Migration),
            // Box::new(m20220805_000004_create_table_gas_payment::Migration),
            // Box::new(m20220805_000004_create_table_message::Migration),
            // Box::new(m20220805_000005_create_table_delivered_message::Migration),
            // Box::new(m20220805_000005_create_table_message_state::Migration),
        ]
    }
}
