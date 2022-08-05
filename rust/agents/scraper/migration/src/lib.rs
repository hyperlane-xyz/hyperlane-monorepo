#![deny(dead_code)]

pub use sea_orm_migration::prelude::*;

mod m20220805_000001_create_table_message;
mod m20220805_000001_create_table_delivered_message;
mod m20220805_000001_create_table_message_state;
mod m20220805_000001_create_table_gas_payment;
mod m20220805_000001_create_table_checkpoint;
mod m20220805_000001_create_table_checkpoint_update;
mod m20220805_000001_create_table_transaction;
mod m20220805_000001_create_table_block;
mod m20220805_000001_create_table_domain;
mod m20220805_000001_create_table_cursor;
mod l20220805_000001_types;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20220805_000001_create_table_message::Migration)]
    }
}
