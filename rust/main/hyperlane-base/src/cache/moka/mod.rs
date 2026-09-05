/// Moka expiry trait implementation for dynamic lifetimes
mod dynamic_expiry;
mod local_cache;

use std::{
    hash::RandomState,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use moka::{future::Cache, notification::RemovalCause, policy::EvictionPolicy};
use serde::{de::DeserializeOwned, Serialize};

pub use dynamic_expiry::{DynamicExpiry, Expiration, ExpirationType};
pub use local_cache::LocalCache;

use crate::cache::{CacheError, CacheMetricsSnapshot};

/// A simple generic cache that stores serializable values.
/// Supports dynamic expiration times
///
/// ## Type Parameters
///
/// - `String`: The type of the keys stored in the cache.
/// - `(String, Expiration)`: The type of the values stored in the cache. The tuple includes
///   a `String` value and an `Expiration` to track the TTL (Time to Live) for each entry.
/// - `RandomState`: The type of the hasher used for hashing keys in the cache.
#[derive(Debug, Clone)]
pub struct BaseCache {
    cache: Cache<String, (String, Expiration), RandomState>,
    eviction_counts: Arc<EvictionCounts>,
}

/// Serialized key and value byte budget. Moka's bookkeeping overhead is not included.
const MAX_CACHE_WEIGHT_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Default)]
struct EvictionCounts {
    expired: AtomicU64,
    size: AtomicU64,
}

impl EvictionCounts {
    fn record(&self, cause: RemovalCause) {
        let counter = match cause {
            RemovalCause::Expired => &self.expired,
            RemovalCause::Size => &self.size,
            RemovalCause::Explicit | RemovalCause::Replaced => return,
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }

    fn snapshot(&self, entry_count: u64, weighted_size: u64) -> CacheMetricsSnapshot {
        CacheMetricsSnapshot {
            entry_count: Some(entry_count),
            weighted_size: Some(weighted_size),
            expired_evictions: self.expired.swap(0, Ordering::Relaxed),
            size_evictions: self.size.swap(0, Ordering::Relaxed),
        }
    }
}

/// The result type for cache operations, which can return a `CacheError`
pub type CacheResult<T> = std::result::Result<T, CacheError>;

impl BaseCache {
    /// Create a new cache with the given name
    pub fn new(name: &str) -> Self {
        Self::with_capacity(name, MAX_CACHE_WEIGHT_BYTES)
    }

    fn with_capacity(name: &str, max_weight: u64) -> Self {
        let eviction_counts = Arc::new(EvictionCounts::default());
        let listener_counts = eviction_counts.clone();
        let cache = Cache::builder()
            .name(name)
            .expire_after(DynamicExpiry {})
            .eviction_policy(EvictionPolicy::lru())
            .weigher(|key: &String, (value, _): &(String, Expiration)| {
                let serialized_bytes = key.len().saturating_add(value.len()).max(1);
                u32::try_from(serialized_bytes).unwrap_or(u32::MAX)
            })
            .eviction_listener(move |_, _, cause| listener_counts.record(cause))
            .max_capacity(max_weight)
            .build();
        Self {
            cache,
            eviction_counts,
        }
    }

    fn entry_count(&self) -> u64 {
        self.cache.entry_count()
    }

    fn weighted_size(&self) -> u64 {
        self.cache.weighted_size()
    }

    fn metrics_snapshot(&self) -> CacheMetricsSnapshot {
        self.eviction_counts
            .snapshot(self.entry_count(), self.weighted_size())
    }

    /// Get the value for the given key
    pub async fn get<T: DeserializeOwned>(
        &self,
        key: &impl Serialize,
    ) -> CacheResult<Option<(T, Expiration)>> {
        let key = self.serialize(key)?;

        match self.cache.get(&key).await {
            Some((json_value, expiry)) => {
                let value = self.deserialize(json_value)?;
                Ok(Some((value, expiry)))
            }
            None => Ok(None),
        }
    }

    /// Set the value for the given key and return the expiration time
    pub async fn set(
        &self,
        key: &impl Serialize,
        value: &impl Serialize,
        ttl: ExpirationType,
    ) -> CacheResult<Expiration> {
        let key = self.serialize(key)?;
        let value = self.serialize(value)?;

        let ttl = Expiration::from(ttl);
        self.cache.insert(key, (value, ttl.clone())).await;
        Ok(ttl)
    }

    fn serialize(&self, value: &impl Serialize) -> CacheResult<String> {
        serde_json::to_string(value).map_err(CacheError::FailedToSerializeInput)
    }

    fn deserialize<T: DeserializeOwned>(&self, json_value: String) -> CacheResult<T> {
        serde_json::from_str(&json_value).map_err(CacheError::FailedToDeserializeOutput)
    }
}

#[cfg(test)]
impl BaseCache {
    /// Get the number of entries in the cache
    /// This will run any pending tasks before returning the entry count
    /// which ensures that the count is accurate.
    pub async fn entries(&self) -> u64 {
        self.cache.run_pending_tasks().await;
        self.entry_count()
    }

    /// Get the weighted size of the cache after running pending maintenance.
    pub async fn weight(&self) -> u64 {
        self.cache.run_pending_tasks().await;
        self.weighted_size()
    }

    /// Check if the cache contains a value for the given key
    pub fn contains_key(&self, key: &impl Serialize) -> CacheResult<bool> {
        let key = self.serialize(key)?;
        Ok(self.cache.contains_key(&key))
    }

    /// Remove the value for the given key
    pub async fn remove(&self, key: &impl Serialize) -> CacheResult<()> {
        let key = self.serialize(key)?;
        self.cache.invalidate(&key).await;
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use std::time::Duration;

    use chrono::Utc;
    use serde::Deserialize;

    use hyperlane_core::{H256, U256};

    use crate::cache::moka::dynamic_expiry::default_expiration;

    use super::*;

    #[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
    struct TestStruct {
        a: String,
        b: i32,
        c: H256,
    }

    async fn sleep(secs: u64) {
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
    }

    #[tokio::test]
    async fn basic_set_and_get() {
        let cache = BaseCache::new("test-cache");

        let key = "key".to_owned();
        let value = 123;
        let ttl = ExpirationType::Default;

        cache.set(&key.clone(), &value, ttl).await.unwrap();

        let entries = cache.entries().await;
        assert_eq!(entries, 1);

        let cached_value = cache.get::<i32>(&key).await.unwrap();
        assert!(cached_value.is_some_and(|(v, _)| v == value));
    }

    #[tokio::test]
    async fn serialized_values_obey_byte_capacity() {
        let max_weight = 700;
        let cache = BaseCache::with_capacity("weighted-test-cache", max_weight);

        for key in 0..3 {
            cache
                .set(&key, &"x".repeat(512), ExpirationType::Never)
                .await
                .unwrap();
        }

        assert!(cache.weight().await <= max_weight);
        assert!(cache.entries().await <= 1);
        assert!(cache.metrics_snapshot().size_evictions >= 2);
    }

    #[tokio::test]
    async fn str_set_and_get() {
        let cache = BaseCache::new("test-cache");

        let key = "key";
        let value = "value";
        let ttl = ExpirationType::Default;

        cache.set(&key, &value, ttl).await.unwrap();

        let entries = cache.entries().await;
        assert_eq!(entries, 1);

        let cached_value = cache.get::<String>(&key).await.unwrap();
        assert!(cached_value.is_some_and(|(v, _)| v == value));
    }

    #[tokio::test]
    async fn tuple_set_and_get() {
        let cache = BaseCache::new("test-cache");

        let key = ("key".to_owned(), 1, H256::zero());
        let value = ("value".to_owned(), 2, U256::zero());
        let ttl = ExpirationType::Default;

        cache.set(&key.clone(), &value, ttl).await.unwrap();

        let entries = cache.entries().await;
        assert_eq!(entries, 1);

        let cached_value = cache.get::<(String, i32, U256)>(&key).await.unwrap();
        assert!(cached_value.is_some_and(|(v, _)| v == value));
    }

    #[tokio::test]
    async fn struct_set_and_get() {
        let cache = BaseCache::new("test-cache");

        let key = TestStruct {
            a: "key".to_owned(),
            b: 1,
            c: H256::zero(),
        };
        let value = TestStruct {
            a: "value".to_owned(),
            b: 2,
            c: H256::zero(),
        };
        let ttl = ExpirationType::Default;

        cache.set(&key.clone(), &value, ttl).await.unwrap();

        let entries = cache.entries().await;
        assert_eq!(entries, 1);

        let cached_value = cache.get::<TestStruct>(&key).await.unwrap();
        assert!(cached_value.is_some_and(|(v, _)| v == value));
    }

    #[tokio::test]
    async fn get_non_existent() {
        let cache = BaseCache::new("test-cache");

        let key = "key".to_owned();

        let cached_value = cache.get::<i32>(&key).await.unwrap();
        assert!(cached_value.is_none());
    }

    #[tokio::test]
    async fn get_with_wrong_type() {
        let cache = BaseCache::new("test-cache");

        let key = "key".to_owned();
        let value = 123;
        let ttl = ExpirationType::Default;

        cache.set(&key.clone(), &value, ttl).await.unwrap();

        let cached_value = cache.get::<TestStruct>(&key).await;
        assert!(cached_value.is_err());
    }

    #[tokio::test]
    async fn insert_with_invalid_expiry_timestamp() {
        let cache = BaseCache::new("test-cache");

        let key = "key".to_owned();
        let value = 123;
        let invalid_timestamp = 946684800; // 2000-01-01 00:00:00
        let ttl = ExpirationType::AfterTimestamp(invalid_timestamp as u64);

        let result = cache.set(&key, &value, ttl).await;
        assert!(result.is_ok());

        // If timestamp is in the past, the entry should be immediately expired
        let entry = cache.get::<i32>(&key).await.unwrap();
        assert!(entry.is_none());
    }

    #[tokio::test]
    async fn different_ttls() {
        let cache = BaseCache::new("test-cache");

        let value = 123;
        let timestamp_in_10_seconds = Utc::now().timestamp() + 10;

        // Use a different ExpirationType for each key
        let keys_with_ttl = vec![
            (
                "5sec".to_owned(),
                ExpirationType::AfterDuration(Duration::from_secs(5)),
            ),
            (
                "10sec".to_owned(),
                ExpirationType::AfterTimestamp(timestamp_in_10_seconds as u64),
            ),
            ("default".to_owned(), ExpirationType::Default),
            ("never".to_owned(), ExpirationType::Never),
        ];

        // Set each key with its respective TTL
        for (key, ttl) in keys_with_ttl.clone() {
            cache.set(&key, &value, ttl).await.unwrap();
        }

        let entries = cache.entries().await;
        assert_eq!(entries, keys_with_ttl.len() as u64);

        // Pull each key from the cache and check the value, expiration and TTL
        for (i, (key, expiry_type)) in keys_with_ttl.iter().enumerate() {
            let cached_value = cache.get::<i32>(&key).await.unwrap();

            assert!(cached_value.is_some_and(|(v, e)| {
                assert!(v == value);
                assert!(&e.variant == expiry_type);
                assert!(cache.contains_key(&key).unwrap());

                let ttl = e.time_to_live();

                println!("{i}: {ttl:?}");

                match i {
                    0 => ttl
                        // The first entry should have a TTL between 1 and 5 seconds
                        .is_some_and(|duration| {
                            duration.as_millis() > 1 && duration.as_secs() <= 5
                        }),
                    1 => ttl
                        // The second entry should have a TTL between 5 and 10 seconds
                        .is_some_and(|duration| duration.as_secs() > 5 && duration.as_secs() <= 10),
                    2 => ttl.is_some_and(|duration| {
                        let default_secs = default_expiration().as_secs();
                        // The third entry should have a TTL of > 90% of the default
                        duration.as_secs() > ((default_secs * 9) / 10)
                            && duration.as_secs() <= default_secs
                    }),
                    // The fourth entry should never expire
                    3 => ttl.is_none(),
                    _ => panic!("Unexpected index"),
                }
            }));
        }

        // Ensure the first entry expires
        sleep(5).await;
        let entries = cache.entries().await;
        assert_eq!(entries, keys_with_ttl.len() as u64 - 1);
        assert!(!cache.contains_key(&keys_with_ttl[0].0).unwrap());
        assert!(cache.contains_key(&keys_with_ttl[1].0).unwrap());
        assert!(cache.contains_key(&keys_with_ttl[2].0).unwrap());
        assert!(cache.contains_key(&keys_with_ttl[3].0).unwrap());

        // Ensure the second entry expires
        sleep(5).await;
        let entries = cache.entries().await;
        assert_eq!(entries, keys_with_ttl.len() as u64 - 2);
        assert!(!cache.contains_key(&keys_with_ttl[0].0).unwrap());
        assert!(!cache.contains_key(&keys_with_ttl[1].0).unwrap());
        assert!(cache.contains_key(&keys_with_ttl[2].0).unwrap());
        assert!(cache.contains_key(&keys_with_ttl[3].0).unwrap());

        // Expire the last two entries
        cache.remove(&keys_with_ttl[2].0).await.unwrap();
        cache.remove(&keys_with_ttl[3].0).await.unwrap();

        // Ensure the last two entries are removed
        let entries = cache.entries().await;
        assert_eq!(entries, 0);
        assert!(!cache.contains_key(&keys_with_ttl[0].0).unwrap());
        assert!(!cache.contains_key(&keys_with_ttl[1].0).unwrap());
        assert!(!cache.contains_key(&keys_with_ttl[2].0).unwrap());
        assert!(!cache.contains_key(&keys_with_ttl[3].0).unwrap());
    }
}
