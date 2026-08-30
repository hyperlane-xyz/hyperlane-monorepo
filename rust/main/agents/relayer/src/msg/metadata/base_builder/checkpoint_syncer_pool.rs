use std::{fmt, sync::Arc, time::Duration};

use hyperlane_base::{
    cache::{LocalCache, MeteredCache, OptionalCache},
    settings::{CheckpointSyncerBuildError, CheckpointSyncerConf},
};
use hyperlane_core::H256;
use moka::future::Cache;
use tokio::sync::OnceCell;

use super::cached_checkpoint_syncer::CachedCheckpointSyncer;

const MAX_POOLED_CHECKPOINT_SYNCERS: u64 = 1024;
const POOLED_CHECKPOINT_SYNCER_TTL: Duration = Duration::from_secs(10 * 60);

type RelayerCache = OptionalCache<MeteredCache<LocalCache>>;
type PooledCheckpointSyncer = Arc<CachedCheckpointSyncer<RelayerCache>>;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CheckpointSyncerPoolKey {
    origin_domain_name: String,
    validator: H256,
    storage_location: String,
    config: String,
}

/// Shares checkpoint storage clients and their in-flight reads across metadata builders.
#[derive(Clone)]
pub(crate) struct CheckpointSyncerPool {
    syncers: Cache<CheckpointSyncerPoolKey, Arc<OnceCell<PooledCheckpointSyncer>>>,
}

impl fmt::Debug for CheckpointSyncerPool {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CheckpointSyncerPool")
            .field("entry_count", &self.syncers.entry_count())
            .finish()
    }
}

impl Default for CheckpointSyncerPool {
    fn default() -> Self {
        Self::with_ttl(POOLED_CHECKPOINT_SYNCER_TTL)
    }
}

impl CheckpointSyncerPool {
    fn with_ttl(ttl: Duration) -> Self {
        Self {
            syncers: Cache::builder()
                .max_capacity(MAX_POOLED_CHECKPOINT_SYNCERS)
                // Absolute expiry allows same-path credential rotation to rebuild
                // even when the client remains hot.
                .time_to_live(ttl)
                .build(),
        }
    }

    pub(crate) async fn get_or_build(
        &self,
        config: &CheckpointSyncerConf,
        cache: RelayerCache,
        origin_domain_name: String,
        validator: H256,
        storage_location: String,
    ) -> Result<PooledCheckpointSyncer, CheckpointSyncerBuildError> {
        let key = CheckpointSyncerPoolKey {
            origin_domain_name: origin_domain_name.clone(),
            validator,
            storage_location: storage_location.clone(),
            config: format!("{config:?}"),
        };
        let cell = self
            .syncers
            .get_with(key, async { Arc::new(OnceCell::new()) })
            .await;

        cell.get_or_try_init(|| async {
            let inner = config.build_and_validate(None).await?;
            Ok(Arc::new(CachedCheckpointSyncer::new(
                inner,
                cache,
                origin_domain_name,
                validator,
                storage_location,
            )))
        })
        .await
        .map(Arc::clone)
    }
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, str::FromStr};

    use super::*;

    #[tokio::test]
    async fn pools_concurrent_duplicate_builds() {
        let first_dir = tempfile::tempdir().unwrap();
        let first_location = format!("file://{}", first_dir.path().display());
        let first_config = CheckpointSyncerConf::from_str(&first_location).unwrap();
        let pool = CheckpointSyncerPool::default();
        let validator = H256::from_low_u64_be(1);

        let (first, duplicate) = tokio::join!(
            pool.get_or_build(
                &first_config,
                OptionalCache::new(None),
                "origin".to_string(),
                validator,
                first_location.clone(),
            ),
            pool.get_or_build(
                &first_config,
                OptionalCache::new(None),
                "origin".to_string(),
                validator,
                first_location.clone(),
            ),
        );
        let first = first.unwrap();
        let duplicate = duplicate.unwrap();
        assert!(Arc::ptr_eq(&first, &duplicate));
    }

    #[tokio::test]
    async fn isolates_pool_entries_by_origin_validator_and_location() {
        let first_dir = tempfile::tempdir().unwrap();
        let second_dir = tempfile::tempdir().unwrap();
        let first_location = format!("file://{}", first_dir.path().display());
        let second_location = format!("file://{}", second_dir.path().display());
        let first_config = CheckpointSyncerConf::from_str(&first_location).unwrap();
        let second_config = CheckpointSyncerConf::from_str(&second_location).unwrap();
        let pool = CheckpointSyncerPool::default();
        let validator = H256::from_low_u64_be(1);
        let first = pool
            .get_or_build(
                &first_config,
                OptionalCache::new(None),
                "origin".to_string(),
                validator,
                first_location.clone(),
            )
            .await
            .unwrap();

        let other_origin = pool
            .get_or_build(
                &first_config,
                OptionalCache::new(None),
                "other-origin".to_string(),
                validator,
                first_location.clone(),
            )
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &other_origin));

        let other_location = pool
            .get_or_build(
                &second_config,
                OptionalCache::new(None),
                "origin".to_string(),
                validator,
                second_location,
            )
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &other_location));

        let other_validator = pool
            .get_or_build(
                &first_config,
                OptionalCache::new(None),
                "origin".to_string(),
                H256::from_low_u64_be(2),
                first_location,
            )
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &other_validator));
    }

    #[tokio::test]
    async fn isolates_pool_entries_by_config() {
        let first_dir = tempfile::tempdir().unwrap();
        let second_dir = tempfile::tempdir().unwrap();
        let storage_location = format!("file://{}", first_dir.path().display());
        let first_config = CheckpointSyncerConf::from_str(&storage_location).unwrap();
        let different_config = CheckpointSyncerConf::LocalStorage {
            path: PathBuf::from(second_dir.path()),
        };
        let pool = CheckpointSyncerPool::default();
        let validator = H256::from_low_u64_be(1);
        let first = pool
            .get_or_build(
                &first_config,
                OptionalCache::new(None),
                "origin".to_string(),
                validator,
                storage_location.clone(),
            )
            .await
            .unwrap();
        let other_config = pool
            .get_or_build(
                &different_config,
                OptionalCache::new(None),
                "origin".to_string(),
                validator,
                storage_location,
            )
            .await
            .unwrap();

        assert!(!Arc::ptr_eq(&first, &other_config));
    }

    #[tokio::test]
    async fn rebuilds_client_after_absolute_ttl() {
        let checkpoint_dir = tempfile::tempdir().unwrap();
        let storage_location = format!("file://{}", checkpoint_dir.path().display());
        let config = CheckpointSyncerConf::from_str(&storage_location).unwrap();
        let pool = CheckpointSyncerPool::with_ttl(Duration::from_millis(10));
        let validator = H256::from_low_u64_be(1);
        let first = pool
            .get_or_build(
                &config,
                OptionalCache::new(None),
                "origin".to_string(),
                validator,
                storage_location.clone(),
            )
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(50)).await;
        let rebuilt = pool
            .get_or_build(
                &config,
                OptionalCache::new(None),
                "origin".to_string(),
                validator,
                storage_location,
            )
            .await
            .unwrap();

        assert!(!Arc::ptr_eq(&first, &rebuilt));
    }
}
