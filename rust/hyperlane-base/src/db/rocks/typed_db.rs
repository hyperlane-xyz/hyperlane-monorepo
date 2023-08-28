use core::fmt::Debug;
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

pub fn domain_name_to_prefix(domain: &HyperlaneDomain) -> Vec<u8> {
    domain
        .name()
        .as_bytes()
        .iter()
        .chain(b"_")
        .copied()
        .collect()
}

impl TypedDB {
    /// Create a new TypedDB instance scoped to a given domain.
    pub fn new(domain: &HyperlaneDomain, db: DB) -> Self {
        Self {
            domain_prefix: domain_name_to_prefix(domain),
            db,
        }
    }

    pub fn prefixed_key(&self, prefix: &[u8], key: &[u8]) -> Vec<u8> {
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
        let prefixed_key = self.prefixed_key(prefix.as_ref(), key.as_ref());
        println!("Storing prefixed key: {:?}", prefixed_key);
        println!("prefix as bytes: {:?}", prefix.as_ref());
        println!("key as bytes: {:?}", key.as_ref());
        println!(
            "prefix: {}",
            String::from_utf8(prefix.as_ref().to_vec()).unwrap()
        );
        self.db.store(&prefixed_key, &value.to_vec())
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
    pub fn store_keyed_encodable<K: Encode + Debug, V: Encode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: &K,
        value: &V,
    ) -> Result<()> {
        println!("key: {:?}", key);
        println!("key as bytes: {:?}", key.to_vec());
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
}
