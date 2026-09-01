use hyperlane_core::{Decode, Encode, HyperlaneDomain};

use crate::db::{error::DbError, DbBatch, DB};

type Result<T> = std::result::Result<T, DbError>;

/// DB handle for storing data tied to a specific type/entity.
///
/// Key structure: ```<domain_prefix>_<additional_prefix(es)>_<key>```
#[derive(Debug, Clone)]
pub struct TypedDB {
    domain_prefix: Vec<u8>,
    db: DB,
}

/// An atomic write batch scoped to a domain.
pub struct TypedDbBatch {
    domain_prefix: Vec<u8>,
    batch: DbBatch,
}

impl AsRef<DB> for TypedDB {
    fn as_ref(&self) -> &DB {
        &self.db
    }
}

impl TypedDB {
    /// Create a new TypedDB instance scoped to a given domain.
    pub fn new(domain: &HyperlaneDomain, db: DB) -> Self {
        let domain_prefix = domain
            .name()
            .as_bytes()
            .iter()
            .chain(b"_")
            .copied()
            .collect();
        Self { domain_prefix, db }
    }

    fn prefixed_key(&self, prefix: &[u8], key: &[u8]) -> Vec<u8> {
        self.domain_prefix
            .iter()
            .chain(prefix)
            .chain(key)
            .copied()
            .collect()
    }

    /// Store encodable value
    pub fn store_encodable<V: Encode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: impl AsRef<[u8]>,
        value: &V,
    ) -> Result<()> {
        self.db.store(
            &self.prefixed_key(prefix.as_ref(), key.as_ref()),
            &value.to_vec(),
        )
    }

    /// Retrieve decodable value
    pub fn retrieve_decodable<V: Decode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: impl AsRef<[u8]>,
    ) -> Result<Option<V>> {
        self.db
            .retrieve(&self.prefixed_key(prefix.as_ref(), key.as_ref()))?
            .map(|v| V::read_from(&mut v.as_slice()))
            .transpose()
            .map_err(Into::into)
    }

    /// Store encodable kv pair
    pub fn store_keyed_encodable<K: Encode, V: Encode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: &K,
        value: &V,
    ) -> Result<()> {
        self.store_encodable(prefix, key.to_vec(), value)
    }

    /// Retrieve decodable value given encodable key
    pub fn retrieve_keyed_decodable<K: Encode, V: Decode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: &K,
    ) -> Result<Option<V>> {
        self.retrieve_decodable(prefix, key.to_vec())
    }

    /// Retrieve and decode every value stored under a prefix.
    pub fn retrieve_decodables_by_prefix<V: Decode>(
        &self,
        prefix: impl AsRef<[u8]>,
    ) -> Result<Vec<V>> {
        let prefix = self.prefixed_key(prefix.as_ref(), &[]);
        self.db
            .retrieve_values_by_prefix(&prefix)?
            .into_iter()
            .map(|value| V::read_from(&mut value.as_slice()).map_err(Into::into))
            .collect()
    }

    /// Return the latest sequence number for the underlying RocksDB.
    pub fn latest_sequence_number(&self) -> u64 {
        self.db.latest_sequence_number()
    }

    /// Detect domain-scoped source writes which were not paired with a marker
    /// write in the same atomic batch.
    pub fn has_unmarked_writes_since(
        &self,
        sequence: u64,
        source_prefix: impl AsRef<[u8]>,
        marker_prefix: impl AsRef<[u8]>,
    ) -> Result<bool> {
        self.db.has_unmarked_writes_since(
            sequence,
            &self.prefixed_key(source_prefix.as_ref(), &[]),
            &self.prefixed_key(marker_prefix.as_ref(), &[]),
        )
    }

    /// Start an atomic write batch scoped to this domain.
    pub fn batch(&self) -> TypedDbBatch {
        TypedDbBatch {
            domain_prefix: self.domain_prefix.clone(),
            batch: self.db.batch(),
        }
    }
}

impl TypedDbBatch {
    fn prefixed_key(&self, prefix: &[u8], key: &[u8]) -> Vec<u8> {
        self.domain_prefix
            .iter()
            .chain(prefix)
            .chain(key)
            .copied()
            .collect()
    }

    /// Store an encoded key/value pair in this batch.
    pub fn store_keyed_encodable<K: Encode, V: Encode>(
        &mut self,
        prefix: impl AsRef<[u8]>,
        key: &K,
        value: &V,
    ) {
        self.batch.store(
            &self.prefixed_key(prefix.as_ref(), &key.to_vec()),
            &value.to_vec(),
        );
    }

    /// Delete an encoded key from this batch.
    pub fn delete_keyed<K: Encode>(&mut self, prefix: impl AsRef<[u8]>, key: &K) {
        self.batch
            .delete(&self.prefixed_key(prefix.as_ref(), &key.to_vec()));
    }

    /// Delete every key under a prefix.
    pub fn delete_prefix(&mut self, prefix: impl AsRef<[u8]>) -> Result<()> {
        let start = self.prefixed_key(prefix.as_ref(), &[]);
        let mut end = start.clone();
        let Some(last_non_max) = end.iter().rposition(|byte| *byte != u8::MAX) else {
            return Err(DbError::Other(
                "Cannot construct an upper bound for an all-0xff prefix".to_string(),
            ));
        };
        end[last_non_max] = end[last_non_max].saturating_add(1);
        end.truncate(last_non_max.saturating_add(1));
        self.batch.delete_range(&start, &end);
        Ok(())
    }

    /// Atomically commit this batch.
    pub fn commit(self) -> Result<()> {
        self.batch.commit()
    }
}
