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
            .retrieve_pinned(&self.prefixed_key(prefix.as_ref(), key.as_ref()))?
            .map(|v| V::read_from_slice(v.as_ref()))
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
            .map(|value| V::read_from_slice(&value).map_err(Into::into))
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

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::{HyperlaneMessage, KnownHyperlaneDomain, MerkleTreeInsertion, H256};

    #[test]
    fn pinned_typed_read_dispatches_slice_override() {
        #[derive(Debug, PartialEq)]
        struct SliceDecoded(u32);
        impl Decode for SliceDecoded {
            fn read_from<R: std::io::Read>(
                _: &mut R,
            ) -> std::result::Result<Self, hyperlane_core::HyperlaneProtocolError> {
                panic!("typed read must dispatch the slice override");
            }
            fn read_from_slice(
                bytes: &[u8],
            ) -> std::result::Result<Self, hyperlane_core::HyperlaneProtocolError> {
                u32::read_from_slice(bytes).map(Self)
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let db = DB::from_path(directory.path()).unwrap();
        let typed = TypedDB::new(&HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum), db);
        typed.store_encodable(b"slice_", b"key", &42u32).unwrap();
        assert_eq!(
            typed
                .retrieve_decodable::<SliceDecoded>(b"slice_", b"key")
                .unwrap(),
            Some(SliceDecoded(42))
        );
        assert_eq!(
            typed
                .retrieve_decodables_by_prefix::<SliceDecoded>(b"slice_")
                .unwrap(),
            vec![SliceDecoded(42)]
        );
    }

    #[test]
    fn prefix_reads_preserve_order_errors_and_owned_results() {
        let directory = tempfile::tempdir().unwrap();
        let db = DB::from_path(directory.path()).unwrap();
        let typed = TypedDB::new(
            &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            db.clone(),
        );
        for key in [3u32, 1, 2] {
            typed
                .store_keyed_encodable(b"ordered_", &key, &vec![key; 4])
                .unwrap();
        }
        typed
            .store_keyed_encodable(b"other_", &0u32, &vec![9u32])
            .unwrap();
        let values = typed
            .retrieve_decodables_by_prefix::<Vec<u32>>(b"ordered_")
            .unwrap();
        assert_eq!(values, vec![vec![1; 4], vec![2; 4], vec![3; 4]]);
        let malformed_key = typed.prefixed_key(b"ordered_", &2u32.to_vec());
        db.store(&malformed_key, &[0]).unwrap();
        assert!(typed
            .retrieve_decodables_by_prefix::<Vec<u32>>(b"ordered_")
            .is_err());
        typed
            .store_keyed_encodable(b"ordered_", &2u32, &vec![2u32; 4])
            .unwrap();
        assert_eq!(
            typed
                .retrieve_decodables_by_prefix::<Vec<u32>>(b"ordered_")
                .unwrap(),
            values
        );
        drop(typed);
        drop(db);
        assert_eq!(values[1], vec![2; 4]);
    }

    #[test]
    fn pinned_typed_reads_preserve_values_and_domain_isolation() {
        let directory = tempfile::tempdir().unwrap();
        let db = DB::from_path(directory.path()).unwrap();
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
        let typed = TypedDB::new(&domain, db.clone());
        let other = TypedDB::new(
            &HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
            db.clone(),
        );
        let insertion = MerkleTreeInsertion::new(42, H256::repeat_byte(0x12));
        typed
            .store_keyed_encodable(b"leaf_", &42u32, &insertion)
            .unwrap();
        assert_eq!(
            typed
                .retrieve_keyed_decodable::<_, MerkleTreeInsertion>(b"leaf_", &42u32)
                .unwrap(),
            Some(insertion)
        );
        assert!(other
            .retrieve_keyed_decodable::<_, MerkleTreeInsertion>(b"leaf_", &42u32)
            .unwrap()
            .is_none());
        for length in [0, 1, 4096] {
            let message = HyperlaneMessage {
                body: vec![0xab; length],
                ..Default::default()
            };
            typed
                .store_encodable(b"message_", b"key", &message)
                .unwrap();
            let encoded = db
                .retrieve(&typed.prefixed_key(b"message_", b"key"))
                .unwrap()
                .unwrap();
            let legacy = HyperlaneMessage::read_from(&mut encoded.as_slice()).unwrap();
            let pinned: HyperlaneMessage = typed
                .retrieve_decodable(b"message_", b"key")
                .unwrap()
                .unwrap();
            assert_eq!(pinned, legacy);
            assert_eq!(pinned, message);
        }
    }

    #[test]
    fn pinned_typed_reads_propagate_decode_errors_and_release_the_value() {
        let directory = tempfile::tempdir().unwrap();
        let db = DB::from_path(directory.path()).unwrap();
        let typed = TypedDB::new(
            &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            db.clone(),
        );
        assert!(typed
            .retrieve_decodable::<HyperlaneMessage>(b"message_", b"key")
            .unwrap()
            .is_none());
        let key = typed.prefixed_key(b"message_", b"key");
        db.store(&key, &[1, 2]).unwrap();
        let error = typed
            .retrieve_decodable::<HyperlaneMessage>(b"message_", b"key")
            .unwrap_err();
        assert!(matches!(error, DbError::HyperlaneError(_)));

        let message = HyperlaneMessage {
            body: vec![0xab; 4096],
            ..Default::default()
        };
        typed
            .store_encodable(b"message_", b"key", &message)
            .unwrap();
        let decoded: HyperlaneMessage = typed
            .retrieve_decodable(b"message_", b"key")
            .unwrap()
            .unwrap();
        let replacement = HyperlaneMessage {
            body: vec![0xcd; 32],
            ..Default::default()
        };
        typed
            .store_encodable(b"message_", b"key", &replacement)
            .unwrap();
        assert_eq!(
            typed
                .retrieve_decodable::<HyperlaneMessage>(b"message_", b"key")
                .unwrap(),
            Some(replacement)
        );
        drop(typed);
        drop(db);
        // The decoded object owns its body; no native database pin escapes.
        assert_eq!(decoded, message);
        let reopened = DB::from_path(directory.path()).unwrap();
        assert!(reopened.retrieve(&key).unwrap().is_some());
    }
}
