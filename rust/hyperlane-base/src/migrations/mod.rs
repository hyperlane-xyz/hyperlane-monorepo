mod m1;

use std::{collections::HashMap, fmt::Display};

use eyre::Result;
use hyperlane_core::HyperlaneDomain;
use rocksdb::WriteBatchWithTransaction;

use crate::db::{iterator::RawPrefixIterator, HyperlaneRocksDB, TypedDB};

pub trait Migration: Display {
    /// takes the old key and value and returns the new key and value, using raw formats
    fn migrate(&self, key: Vec<u8>, value: Vec<u8>) -> Result<(Vec<u8>, Vec<u8>)>;

    fn prefix_key(&self) -> String;
}

pub fn migrate(dbs: &HashMap<HyperlaneDomain, HyperlaneRocksDB>) -> Result<()> {
    let migrations: Vec<Box<dyn Migration>> =
        vec![Box::new(m1::InterchainGasPaymentMetaMigrationV0)];

    for migration in migrations {
        println!("Running migration {}", migration.prefix_key());
        for (domain, db) in dbs {
            println!("Migrating domain: {:?}", domain);
            let typed_db: &TypedDB = db.as_ref();
            let rocksdb = typed_db.as_ref();
            let raw_db_iterator = rocksdb.iterator();
            let prefix = db.prefixed_key(migration.prefix_key().as_ref(), &[]);

            let raw_iterator = RawPrefixIterator::new(raw_db_iterator, &prefix);
            if let Some(updates) = batch_updates(&migration, raw_iterator) {
                rocksdb.write(updates)?;
                println!("Succesfully migrated domain: {:?}", domain);
            }
        }
    }
    Ok(())
}

pub fn batch_updates<'a>(
    migration: &Box<dyn Migration>,
    raw_iterator: RawPrefixIterator<'a>,
) -> Option<WriteBatchWithTransaction<false>> {
    let mut migration_updates = WriteBatchWithTransaction::<false>::default();
    for (k, v) in raw_iterator {
        println!("Migrating key: {:?}, value: {:?}", k, v);
        match migration.migrate(k, v) {
            Ok((new_key, new_value)) => {
                migration_updates.put(new_key, new_value);
            }
            Err(e) => {
                println!("Error migrating: {}", e);
                return None;
            }
        }
        // let Ok((new_key, new_value)) = migration.migrate(k, v)
        //     else {
        //         return None;
        //     };
        // migration_updates.put(new_key, new_value);
    }
    Some(migration_updates)
}
