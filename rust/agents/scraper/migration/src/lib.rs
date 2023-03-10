#![deny(dead_code)]

extern crate core;

pub use sea_orm_migration::prelude::*;

mod l20230309_types;
mod m20230309_000001_create_table_domain;
mod m20230309_000002_create_table_block;

mod m20230309_000003_create_table_cursor;
mod m20230309_000003_create_table_transaction;
mod m20230309_000004_create_table_gas_payment;
mod m20230309_000004_create_table_message;
mod m20230309_000005_create_table_delivered_message;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        // This order is important, grouped by a topological sort, within each group
        // should not matter what order it is. (topology group defined by the
        // last number)
        vec![
            Box::new(m20230309_000001_create_table_domain::Migration),
            Box::new(m20230309_000002_create_table_block::Migration),
            Box::new(m20230309_000003_create_table_cursor::Migration),
            Box::new(m20230309_000003_create_table_transaction::Migration),
            Box::new(m20230309_000004_create_table_gas_payment::Migration),
            Box::new(m20230309_000004_create_table_message::Migration),
            Box::new(m20230309_000005_create_table_delivered_message::Migration),
        ]
    }
}
