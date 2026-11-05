//! Migrations for the separate relayer diagnostics database.
pub use sea_orm_migration::prelude::*;

mod m20261104_000001_create_message_activity;
mod m20261105_000002_activity_retention_index;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261104_000001_create_message_activity::Migration),
            Box::new(m20261105_000002_activity_retention_index::Migration),
        ]
    }
}
