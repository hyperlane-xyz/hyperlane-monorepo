use hyperlane_core::{Decode, Encode, HyperlaneDomain};

use crate::db::{DbError, DB};

type Result<T> = std::result::Result<T, DbError>;

/// DB handle for storing data tied to a specific type/entity.
///
/// Key structure: ```<domain_prefix>_<additional_prefix(es)>_<key>```
#[derive(Debug, Clone)]
pub struct TypedDB {
    domain_prefix: Vec<u8>,
    db: DB,
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
            .chain(&domain.id().to_be_bytes())
            .chain(b"_")
            .copied()
            .collect();
        Self { domain_prefix, db }
    }

    fn full_key(&self, prefix: &[u8], key: &[u8]) -> Vec<u8> {
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
            &self.full_key(prefix.as_ref(), key.as_ref()),
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
            .retrieve(&self.full_key(prefix.as_ref(), key.as_ref()))?
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
        self.store_encodable(prefix, &key.to_vec(), value)
    }

    /// Retrieve decodable value given encodable key
    pub fn retrieve_keyed_decodable<K: Encode, V: Decode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: &K,
    ) -> Result<Option<V>> {
        self.retrieve_decodable(prefix, &key.to_vec())
    }
}
