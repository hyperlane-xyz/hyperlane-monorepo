mod m1;

use std::{collections::HashMap, fmt::Display};

use eyre::Result;
use hyperlane_core::HyperlaneDomain;
use rocksdb::WriteBatchWithTransaction;

use crate::db::{domain_name_to_prefix, iterator::RawPrefixIterator, HyperlaneRocksDB, TypedDB};

pub trait Migration: Display {
    /// takes the old key and value and returns the new key and value, using raw formats
    fn migrate(
        &self,
        key: Vec<u8>,
        value: Vec<u8>,
        domain: &HyperlaneDomain,
    ) -> Result<(Vec<u8>, Vec<u8>)>;

    fn prefix_key(&self) -> String;
}

pub fn migrate(dbs: &HashMap<HyperlaneDomain, HyperlaneRocksDB>) -> Result<()> {
    let migrations: Vec<Box<dyn Migration>> =
        vec![Box::new(m1::InterchainGasPaymentMetaMigrationV0)];

    for migration in migrations {
        println!("Running migration {}", migration.prefix_key());
        for (domain, db) in dbs {
            println!("Trying to migrate domain: {:?}", domain);
            let typed_db: &TypedDB = db.as_ref();
            let rocksdb = typed_db.as_ref();
            let raw_db_iterator = rocksdb.iterator();
            let prefix = db.prefixed_key(migration.prefix_key().as_ref(), &[]);

            let raw_iterator = RawPrefixIterator::new(raw_db_iterator, &prefix);
            if let Some(updates) = batch_updates(&migration, raw_iterator, domain) {
                let update_count = updates.len();
                rocksdb.write(updates)?;
                println!(
                    "Succesfully migrated {} records (including deletions) from domain: {:?}",
                    update_count, domain
                );
            }
        }
    }
    Ok(())
}

pub fn batch_updates<'a>(
    migration: &Box<dyn Migration>,
    raw_iterator: RawPrefixIterator<'a>,
    domain: &HyperlaneDomain,
) -> Option<WriteBatchWithTransaction<false>> {
    let mut migration_updates = WriteBatchWithTransaction::<false>::default();
    for (k, v) in raw_iterator {
        match migration.migrate(k.clone(), v.clone(), domain) {
            Ok((new_key, new_value)) => {
                // In case the migration changes the key, we need to delete the old key
                migration_updates.delete(k.clone());
                migration_updates.put(new_key.clone(), new_value.clone());
                println!(
                    "Migrating key: {:?}, value: {:?}, new key: {:?}, new value: {:?}",
                    k, v, new_key, new_value
                );
            }
            Err(e) => {
                println!("Error migrating: {}", e);
            }
        }
    }
    if migration_updates.len() > 0 {
        Some(migration_updates)
    } else {
        None
    }
}
