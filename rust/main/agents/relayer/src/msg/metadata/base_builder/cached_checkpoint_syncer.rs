use std::{fmt::Debug, sync::Arc, time::Duration};

use eyre::{eyre, Result};
use moka::future::Cache;
use serde::{Deserialize, Serialize};
use tracing::debug;

use hyperlane_base::{
    cache::{ExpirationType, FunctionCallCache},
    CheckpointSyncer,
};
use hyperlane_core::{
    ReorgEvent, ReorgEventResponse, SignedAnnouncement, SignedCheckpointWithMessageId, H256,
};

const FETCH_CHECKPOINT_METHOD: &str = "fetch_checkpoint";
const LATEST_INDEX_METHOD: &str = "latest_index";
// Kept short so that on the merkle-root multisig path (where `latest_index`
// gates the highest quorum index we search from) a freshly-advanced validator
// is picked up within ~1 retry cycle, while still absorbing the bulk of
// per-validator `latest_index` RPC/S3 load. The message-id multisig path only
// uses `latest_index` for metrics, so it is unaffected by this TTL.
const LATEST_INDEX_CACHE_TTL: Duration = Duration::from_secs(2);
const MAX_INFLIGHT_CHECKPOINTS: u64 = 1024;
// Normally each completed flight is invalidated immediately. This short TTL is
// a cancellation-safety backstop if a caller is dropped between completion and
// the asynchronous invalidation.
const INFLIGHT_RESULT_TTL: Duration = Duration::from_millis(100);

type InflightResult<T> = std::result::Result<T, Arc<str>>;

#[derive(Debug, Serialize, Deserialize)]
struct CachedLatestIndexKey {
    validator: H256,
    storage_location: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedCheckpointKey {
    validator: H256,
    storage_location: String,
    index: u32,
}

#[derive(Debug)]
pub struct CachedCheckpointSyncer<C> {
    inner: Arc<dyn CheckpointSyncer>,
    cache: C,
    origin_domain_name: String,
    validator: H256,
    storage_location: String,
    inflight_latest_index: Cache<(), Arc<InflightResult<Option<u32>>>>,
    inflight_checkpoints: Cache<u32, Arc<InflightResult<Option<SignedCheckpointWithMessageId>>>>,
}

impl<C> CachedCheckpointSyncer<C> {
    pub fn new(
        inner: Box<dyn CheckpointSyncer>,
        cache: C,
        origin_domain_name: String,
        validator: H256,
        storage_location: String,
    ) -> Self {
        Self {
            inner: inner.into(),
            cache,
            origin_domain_name,
            validator,
            storage_location,
            inflight_latest_index: Cache::builder()
                .max_capacity(1)
                .time_to_live(INFLIGHT_RESULT_TTL)
                .build(),
            inflight_checkpoints: Cache::builder()
                .max_capacity(MAX_INFLIGHT_CHECKPOINTS)
                .time_to_live(INFLIGHT_RESULT_TTL)
                .build(),
        }
    }

    fn cache_key(&self, index: u32) -> CachedCheckpointKey {
        CachedCheckpointKey {
            validator: self.validator,
            storage_location: self.storage_location.clone(),
            index,
        }
    }

    fn latest_index_cache_key(&self) -> CachedLatestIndexKey {
        CachedLatestIndexKey {
            validator: self.validator,
            storage_location: self.storage_location.clone(),
        }
    }

    fn is_cacheable_checkpoint(
        &self,
        index: u32,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> bool {
        if signed_checkpoint.value.index != index {
            debug!(
                validator = ?self.validator,
                index,
                checkpoint_index = signed_checkpoint.value.index,
                "Not caching signed checkpoint with mismatched index"
            );
            return false;
        }

        match signed_checkpoint.recover() {
            Ok(signer) if H256::from(signer) == self.validator => true,
            Ok(signer) => {
                debug!(
                    validator = ?self.validator,
                    signer = ?signer,
                    index,
                    "Not caching signed checkpoint with unexpected signer"
                );
                false
            }
            Err(err) => {
                debug!(
                    error = ?err,
                    validator = ?self.validator,
                    index,
                    "Not caching signed checkpoint with unrecoverable signature"
                );
                false
            }
        }
    }

    async fn cached_latest_index(&self) -> Option<u32>
    where
        C: FunctionCallCache + Debug,
    {
        let cache_key = self.latest_index_cache_key();
        match self
            .cache
            .get_cached_call_result::<u32>(
                &self.origin_domain_name,
                LATEST_INDEX_METHOD,
                &cache_key,
            )
            .await
        {
            Ok(value) => value,
            Err(err) => {
                debug!(
                    error = %err,
                    validator = ?self.validator,
                    "Failed to fetch latest checkpoint index from cache"
                );
                None
            }
        }
    }

    async fn cached_checkpoint(&self, index: u32) -> Option<SignedCheckpointWithMessageId>
    where
        C: FunctionCallCache + Debug,
    {
        let cache_key = self.cache_key(index);
        match self
            .cache
            .get_cached_call_result::<SignedCheckpointWithMessageId>(
                &self.origin_domain_name,
                FETCH_CHECKPOINT_METHOD,
                &cache_key,
            )
            .await
        {
            Ok(value) => value,
            Err(err) => {
                debug!(
                    error = %err,
                    validator = ?self.validator,
                    index,
                    "Failed to fetch signed checkpoint from cache"
                );
                None
            }
        }
    }

    fn clone_inflight_result<T: Clone>(result: &InflightResult<T>) -> Result<T> {
        match result {
            Ok(value) => Ok(value.clone()),
            Err(err) => Err(eyre!(err.to_string())),
        }
    }
}

#[async_trait::async_trait]
impl<C> CheckpointSyncer for CachedCheckpointSyncer<C>
where
    C: FunctionCallCache + Debug,
{
    async fn latest_index(&self) -> Result<Option<u32>> {
        if let Some(latest_index) = self.cached_latest_index().await {
            return Ok(Some(latest_index));
        }

        let result = self
            .inflight_latest_index
            .get_with((), async {
                if let Some(latest_index) = self.cached_latest_index().await {
                    return Arc::new(Ok(Some(latest_index)));
                }

                match self.inner.latest_index().await {
                    Ok(result) => {
                        if let Some(latest_index) = &result {
                            let cache_key = self.latest_index_cache_key();
                            if let Err(err) = self
                                .cache
                                .cache_call_result_with_expiration(
                                    &self.origin_domain_name,
                                    LATEST_INDEX_METHOD,
                                    &cache_key,
                                    latest_index,
                                    ExpirationType::AfterDuration(LATEST_INDEX_CACHE_TTL),
                                )
                                .await
                            {
                                debug!(
                                    error = %err,
                                    validator = ?self.validator,
                                    latest_index,
                                    "Failed to cache latest checkpoint index"
                                );
                            }
                        }
                        Arc::new(Ok(result))
                    }
                    Err(err) => Arc::new(Err(Arc::from(format!("{err:#}")))),
                }
            })
            .await;
        self.inflight_latest_index.invalidate(&()).await;

        Self::clone_inflight_result(&result)
    }

    async fn write_latest_index(&self, index: u32) -> Result<()> {
        self.inner.write_latest_index(index).await
    }

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        if let Some(signed_checkpoint) = self.cached_checkpoint(index).await {
            return Ok(Some(signed_checkpoint));
        }

        let result = self
            .inflight_checkpoints
            .get_with(index, async {
                if let Some(signed_checkpoint) = self.cached_checkpoint(index).await {
                    return Arc::new(Ok(Some(signed_checkpoint)));
                }

                match self.inner.fetch_checkpoint(index).await {
                    Ok(result) => {
                        if let Some(signed_checkpoint) = &result {
                            if !self.is_cacheable_checkpoint(index, signed_checkpoint) {
                                return Arc::new(Ok(result));
                            }

                            let cache_key = self.cache_key(index);
                            if let Err(err) = self
                                .cache
                                .cache_call_result(
                                    &self.origin_domain_name,
                                    FETCH_CHECKPOINT_METHOD,
                                    &cache_key,
                                    signed_checkpoint,
                                )
                                .await
                            {
                                debug!(
                                    error = %err,
                                    validator = ?self.validator,
                                    index,
                                    "Failed to cache signed checkpoint"
                                );
                            }
                        }
                        Arc::new(Ok(result))
                    }
                    Err(err) => Arc::new(Err(Arc::from(format!("{err:#}")))),
                }
            })
            .await;
        self.inflight_checkpoints.invalidate(&index).await;

        Self::clone_inflight_result(&result)
    }

    async fn write_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        self.inner.write_checkpoint(signed_checkpoint).await
    }

    async fn write_metadata(&self, serialized_metadata: &str) -> Result<()> {
        self.inner.write_metadata(serialized_metadata).await
    }

    async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()> {
        self.inner.write_announcement(signed_announcement).await
    }

    fn announcement_location(&self) -> String {
        self.inner.announcement_location()
    }

    async fn write_reorg_status(&self, reorg_event: &ReorgEvent) -> Result<()> {
        self.inner.write_reorg_status(reorg_event).await
    }

    async fn write_reorg_rpc_responses(&self, log: String) -> Result<()> {
        self.inner.write_reorg_rpc_responses(log).await
    }

    async fn reorg_status(&self) -> Result<ReorgEventResponse> {
        self.inner.reorg_status().await
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        future::pending,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use eyre::{bail, Result};
    use hyperlane_base::cache::LocalCache;
    use hyperlane_core::HyperlaneSigner;
    use hyperlane_core::HyperlaneSignerExt;
    use hyperlane_core::{
        Checkpoint, CheckpointWithMessageId, ReorgEvent, ReorgEventResponse, SignedAnnouncement,
        SignedCheckpointWithMessageId,
    };
    use hyperlane_ethereum::Signers;
    use tokio::{
        sync::{Barrier, Notify},
        time::timeout,
    };

    use super::*;

    #[derive(Debug)]
    struct CountingCheckpointSyncer {
        fetch_count: Arc<AtomicUsize>,
        latest_index_count: Arc<AtomicUsize>,
        responses: Mutex<VecDeque<Result<Option<SignedCheckpointWithMessageId>>>>,
        latest_index_responses: Mutex<VecDeque<Result<Option<u32>>>>,
        fetch_gate: Option<CallGate>,
        latest_index_gate: Option<CallGate>,
        cancel_first_fetch: bool,
    }

    #[derive(Debug)]
    struct CallGate {
        started: Arc<Notify>,
        release: Arc<Notify>,
    }

    impl CountingCheckpointSyncer {
        fn new(
            responses: Vec<Result<Option<SignedCheckpointWithMessageId>>>,
        ) -> (Self, Arc<AtomicUsize>) {
            let fetch_count = Arc::new(AtomicUsize::new(0));
            let latest_index_count = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    fetch_count: fetch_count.clone(),
                    latest_index_count,
                    responses: Mutex::new(responses.into()),
                    latest_index_responses: Mutex::new(VecDeque::new()),
                    fetch_gate: None,
                    latest_index_gate: None,
                    cancel_first_fetch: false,
                },
                fetch_count,
            )
        }

        fn new_with_latest_index_responses(
            latest_index_responses: Vec<Result<Option<u32>>>,
        ) -> (Self, Arc<AtomicUsize>) {
            let fetch_count = Arc::new(AtomicUsize::new(0));
            let latest_index_count = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    fetch_count,
                    latest_index_count: latest_index_count.clone(),
                    responses: Mutex::new(VecDeque::new()),
                    latest_index_responses: Mutex::new(latest_index_responses.into()),
                    fetch_gate: None,
                    latest_index_gate: None,
                    cancel_first_fetch: false,
                },
                latest_index_count,
            )
        }

        fn new_with_gated_fetches(
            responses: Vec<Result<Option<SignedCheckpointWithMessageId>>>,
            cancel_first_fetch: bool,
        ) -> (Self, Arc<AtomicUsize>, Arc<Notify>, Arc<Notify>) {
            let (mut syncer, fetch_count) = Self::new(responses);
            let started = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            syncer.fetch_gate = Some(CallGate {
                started: started.clone(),
                release: release.clone(),
            });
            syncer.cancel_first_fetch = cancel_first_fetch;
            (syncer, fetch_count, started, release)
        }

        fn new_with_gated_latest_index(
            responses: Vec<Result<Option<u32>>>,
        ) -> (Self, Arc<AtomicUsize>, Arc<Notify>, Arc<Notify>) {
            let (mut syncer, latest_index_count) = Self::new_with_latest_index_responses(responses);
            let started = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            syncer.latest_index_gate = Some(CallGate {
                started: started.clone(),
                release: release.clone(),
            });
            (syncer, latest_index_count, started, release)
        }
    }

    #[async_trait::async_trait]
    impl CheckpointSyncer for CountingCheckpointSyncer {
        async fn latest_index(&self) -> Result<Option<u32>> {
            let call = self.latest_index_count.fetch_add(1, Ordering::Relaxed);
            if call == 0 {
                if let Some(gate) = &self.latest_index_gate {
                    gate.started.notify_one();
                    gate.release.notified().await;
                }
            }
            self.latest_index_responses
                .lock()
                .map_err(|_| eyre::eyre!("Failed to lock latest index responses"))?
                .pop_front()
                .unwrap_or_else(|| bail!("No latest index response"))
        }

        async fn write_latest_index(&self, _index: u32) -> Result<()> {
            Ok(())
        }

        async fn fetch_checkpoint(
            &self,
            _index: u32,
        ) -> Result<Option<SignedCheckpointWithMessageId>> {
            let call = self.fetch_count.fetch_add(1, Ordering::Relaxed);
            if call == 0 {
                if let Some(gate) = &self.fetch_gate {
                    gate.started.notify_one();
                    if self.cancel_first_fetch {
                        pending::<()>().await;
                    } else {
                        gate.release.notified().await;
                    }
                }
            }
            self.responses
                .lock()
                .map_err(|_| eyre::eyre!("Failed to lock responses"))?
                .pop_front()
                .unwrap_or_else(|| bail!("No fetch checkpoint response"))
        }

        async fn write_checkpoint(
            &self,
            _signed_checkpoint: &SignedCheckpointWithMessageId,
        ) -> Result<()> {
            Ok(())
        }

        async fn write_metadata(&self, _serialized_metadata: &str) -> Result<()> {
            Ok(())
        }

        async fn write_announcement(
            &self,
            _signed_announcement: &SignedAnnouncement,
        ) -> Result<()> {
            Ok(())
        }

        fn announcement_location(&self) -> String {
            "test".to_string()
        }

        async fn write_reorg_status(&self, _reorg_event: &ReorgEvent) -> Result<()> {
            Ok(())
        }

        async fn reorg_status(&self) -> Result<ReorgEventResponse> {
            Ok(ReorgEventResponse {
                exists: false,
                event: None,
                content: None,
            })
        }
    }

    fn checkpoint(index: u32) -> CheckpointWithMessageId {
        CheckpointWithMessageId {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: H256::zero(),
                mailbox_domain: 1,
                root: H256::zero(),
                index,
            },
            message_id: H256::zero(),
        }
    }

    fn test_signer() -> Signers {
        ethers::signers::LocalWallet::new(&mut rand::thread_rng()).into()
    }

    async fn signed_checkpoint(index: u32, signer: &Signers) -> SignedCheckpointWithMessageId {
        signer
            .sign(checkpoint(index))
            .await
            .expect("Failed to sign checkpoint")
    }

    fn validator(signer: &Signers) -> H256 {
        H256::from(signer.eth_address())
    }

    #[tokio::test]
    async fn caches_successful_checkpoint_fetches() {
        let signer = test_signer();
        let signed_checkpoint = signed_checkpoint(10, &signer).await;
        let (inner, fetch_count) =
            CountingCheckpointSyncer::new(vec![Ok(Some(signed_checkpoint.clone()))]);
        let syncer = CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        );

        let first = syncer.fetch_checkpoint(10).await.expect("first fetch");
        let second = syncer.fetch_checkpoint(10).await.expect("second fetch");

        assert_eq!(first, Some(signed_checkpoint.clone()));
        assert_eq!(second, Some(signed_checkpoint));
        assert_eq!(fetch_count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn does_not_cache_missing_checkpoint_fetches() {
        let signer = test_signer();
        let signed_checkpoint = signed_checkpoint(10, &signer).await;
        let (inner, fetch_count) =
            CountingCheckpointSyncer::new(vec![Ok(None), Ok(Some(signed_checkpoint.clone()))]);
        let syncer = CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        );

        let first = syncer.fetch_checkpoint(10).await.expect("first fetch");
        let second = syncer.fetch_checkpoint(10).await.expect("second fetch");

        assert_eq!(first, None);
        assert_eq!(second, Some(signed_checkpoint));
        assert_eq!(fetch_count.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn caches_checkpoint_fetches_per_validator() {
        let signer_1 = test_signer();
        let signer_2 = test_signer();
        let signed_checkpoint_1 = signed_checkpoint(10, &signer_1).await;
        let signed_checkpoint_2 = signed_checkpoint(10, &signer_2).await;
        let cache = LocalCache::new("test-cache");
        let validator_a = validator(&signer_1);
        let validator_b = validator(&signer_2);

        let (inner_a, fetch_count_a) =
            CountingCheckpointSyncer::new(vec![Ok(Some(signed_checkpoint_1.clone()))]);
        let syncer_a = CachedCheckpointSyncer::new(
            Box::new(inner_a),
            cache.clone(),
            "testorigin".to_string(),
            validator_a,
            "test".to_string(),
        );
        syncer_a
            .fetch_checkpoint(10)
            .await
            .expect("validator a fetch");

        let (inner_b, fetch_count_b) =
            CountingCheckpointSyncer::new(vec![Ok(Some(signed_checkpoint_2.clone()))]);
        let syncer_b = CachedCheckpointSyncer::new(
            Box::new(inner_b),
            cache,
            "testorigin".to_string(),
            validator_b,
            "test".to_string(),
        );

        assert_eq!(
            syncer_b
                .fetch_checkpoint(10)
                .await
                .expect("validator b fetch"),
            Some(signed_checkpoint_2)
        );
        assert_eq!(fetch_count_a.load(Ordering::Relaxed), 1);
        assert_eq!(fetch_count_b.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn does_not_cache_checkpoint_with_unexpected_signer() {
        let signer = test_signer();
        let other_signer = test_signer();
        let signed_checkpoint = signed_checkpoint(10, &signer).await;
        let (inner, fetch_count) = CountingCheckpointSyncer::new(vec![
            Ok(Some(signed_checkpoint.clone())),
            Ok(Some(signed_checkpoint.clone())),
        ]);
        let syncer = CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&other_signer),
            "test".to_string(),
        );

        let first = syncer.fetch_checkpoint(10).await.expect("first fetch");
        let second = syncer.fetch_checkpoint(10).await.expect("second fetch");

        assert_eq!(first, Some(signed_checkpoint.clone()));
        assert_eq!(second, Some(signed_checkpoint));
        assert_eq!(fetch_count.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn does_not_cache_checkpoint_with_mismatched_index() {
        let signer = test_signer();
        let signed_checkpoint = signed_checkpoint(11, &signer).await;
        let (inner, fetch_count) = CountingCheckpointSyncer::new(vec![
            Ok(Some(signed_checkpoint.clone())),
            Ok(Some(signed_checkpoint.clone())),
        ]);
        let syncer = CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        );

        let first = syncer.fetch_checkpoint(10).await.expect("first fetch");
        let second = syncer.fetch_checkpoint(10).await.expect("second fetch");

        assert_eq!(first, Some(signed_checkpoint.clone()));
        assert_eq!(second, Some(signed_checkpoint));
        assert_eq!(fetch_count.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn cache_key_includes_storage_location() {
        let cache = LocalCache::new("test-cache");
        let signer = test_signer();
        let signed_checkpoint = signed_checkpoint(10, &signer).await;
        let (first_inner, first_fetch_count) =
            CountingCheckpointSyncer::new(vec![Ok(Some(signed_checkpoint.clone()))]);
        let (second_inner, second_fetch_count) =
            CountingCheckpointSyncer::new(vec![Ok(Some(signed_checkpoint.clone()))]);
        let first_syncer = CachedCheckpointSyncer::new(
            Box::new(first_inner),
            cache.clone(),
            "testorigin".to_string(),
            validator(&signer),
            "test-1".to_string(),
        );
        let second_syncer = CachedCheckpointSyncer::new(
            Box::new(second_inner),
            cache,
            "testorigin".to_string(),
            validator(&signer),
            "test-2".to_string(),
        );

        let first = first_syncer
            .fetch_checkpoint(10)
            .await
            .expect("first fetch");
        let second = second_syncer
            .fetch_checkpoint(10)
            .await
            .expect("second fetch");

        assert_eq!(first, Some(signed_checkpoint.clone()));
        assert_eq!(second, Some(signed_checkpoint));
        assert_eq!(first_fetch_count.load(Ordering::Relaxed), 1);
        assert_eq!(second_fetch_count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn caches_successful_latest_index_fetches() {
        let signer = test_signer();
        let (inner, latest_index_count) =
            CountingCheckpointSyncer::new_with_latest_index_responses(vec![Ok(Some(10))]);
        let syncer = CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        );

        let first = syncer.latest_index().await.expect("first fetch");
        let second = syncer.latest_index().await.expect("second fetch");

        assert_eq!(first, Some(10));
        assert_eq!(second, Some(10));
        assert_eq!(latest_index_count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn does_not_cache_missing_latest_index_fetches() {
        let signer = test_signer();
        let (inner, latest_index_count) =
            CountingCheckpointSyncer::new_with_latest_index_responses(vec![Ok(None), Ok(Some(10))]);
        let syncer = CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        );

        let first = syncer.latest_index().await.expect("first fetch");
        let second = syncer.latest_index().await.expect("second fetch");

        assert_eq!(first, None);
        assert_eq!(second, Some(10));
        assert_eq!(latest_index_count.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn expires_cached_latest_index_fetches() {
        let signer = test_signer();
        let (inner, latest_index_count) =
            CountingCheckpointSyncer::new_with_latest_index_responses(vec![
                Ok(Some(10)),
                Ok(Some(11)),
            ]);
        let syncer = CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        );

        let first = syncer.latest_index().await.expect("first fetch");
        tokio::time::sleep(LATEST_INDEX_CACHE_TTL + Duration::from_secs(1)).await;
        let second = syncer.latest_index().await.expect("second fetch");

        assert_eq!(first, Some(10));
        assert_eq!(second, Some(11));
        assert_eq!(latest_index_count.load(Ordering::Relaxed), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn singleflights_concurrent_checkpoint_misses() {
        const CALLS: usize = 8;

        let signer = test_signer();
        let signed_checkpoint = signed_checkpoint(10, &signer).await;
        let (inner, fetch_count, started, release) =
            CountingCheckpointSyncer::new_with_gated_fetches(
                vec![Ok(Some(signed_checkpoint.clone()))],
                false,
            );
        let syncer = Arc::new(CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        ));
        let barrier = Arc::new(Barrier::new(CALLS + 1));
        let tasks = (0..CALLS)
            .map(|_| {
                let syncer = syncer.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    syncer.fetch_checkpoint(10).await
                })
            })
            .collect::<Vec<_>>();

        barrier.wait().await;
        started.notified().await;
        tokio::task::yield_now().await;
        assert_eq!(fetch_count.load(Ordering::Relaxed), 1);
        release.notify_one();

        for task in tasks {
            assert_eq!(
                task.await.unwrap().unwrap(),
                Some(signed_checkpoint.clone())
            );
        }
        assert_eq!(fetch_count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn singleflights_concurrent_latest_index_misses() {
        const CALLS: usize = 8;

        let signer = test_signer();
        let (inner, latest_index_count, started, release) =
            CountingCheckpointSyncer::new_with_gated_latest_index(vec![Ok(Some(10))]);
        let syncer = Arc::new(CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        ));
        let barrier = Arc::new(Barrier::new(CALLS + 1));
        let tasks = (0..CALLS)
            .map(|_| {
                let syncer = syncer.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    syncer.latest_index().await
                })
            })
            .collect::<Vec<_>>();

        barrier.wait().await;
        started.notified().await;
        tokio::task::yield_now().await;
        assert_eq!(latest_index_count.load(Ordering::Relaxed), 1);
        release.notify_one();

        for task in tasks {
            assert_eq!(task.await.unwrap().unwrap(), Some(10));
        }
        assert_eq!(latest_index_count.load(Ordering::Relaxed), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn singleflight_errors_are_retried() {
        const CALLS: usize = 8;

        let signer = test_signer();
        let signed_checkpoint = signed_checkpoint(10, &signer).await;
        let (inner, fetch_count, started, release) =
            CountingCheckpointSyncer::new_with_gated_fetches(
                vec![
                    Err(eyre!("transient backend error")),
                    Ok(Some(signed_checkpoint.clone())),
                ],
                false,
            );
        let syncer = Arc::new(CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        ));
        let barrier = Arc::new(Barrier::new(CALLS + 1));
        let tasks = (0..CALLS)
            .map(|_| {
                let syncer = syncer.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    barrier.wait().await;
                    syncer.fetch_checkpoint(10).await
                })
            })
            .collect::<Vec<_>>();

        barrier.wait().await;
        started.notified().await;
        tokio::task::yield_now().await;
        assert_eq!(fetch_count.load(Ordering::Relaxed), 1);
        release.notify_one();

        for task in tasks {
            let error = task.await.unwrap().unwrap_err();
            assert!(error.to_string().contains("transient backend error"));
        }
        assert_eq!(fetch_count.load(Ordering::Relaxed), 1);

        assert_eq!(
            syncer.fetch_checkpoint(10).await.unwrap(),
            Some(signed_checkpoint)
        );
        assert_eq!(fetch_count.load(Ordering::Relaxed), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_singleflight_leader_does_not_strand_waiters() {
        let signer = test_signer();
        let signed_checkpoint = signed_checkpoint(10, &signer).await;
        let (inner, fetch_count, started, _release) =
            CountingCheckpointSyncer::new_with_gated_fetches(
                vec![Ok(Some(signed_checkpoint.clone()))],
                true,
            );
        let syncer = Arc::new(CachedCheckpointSyncer::new(
            Box::new(inner),
            LocalCache::new("test-cache"),
            "testorigin".to_string(),
            validator(&signer),
            "test".to_string(),
        ));

        let leader = {
            let syncer = syncer.clone();
            tokio::spawn(async move { syncer.fetch_checkpoint(10).await })
        };
        started.notified().await;
        let waiter = {
            let syncer = syncer.clone();
            tokio::spawn(async move { syncer.fetch_checkpoint(10).await })
        };
        tokio::task::yield_now().await;
        leader.abort();
        assert!(leader.await.unwrap_err().is_cancelled());

        assert_eq!(
            timeout(Duration::from_secs(1), waiter)
                .await
                .expect("waiter should not be stranded")
                .unwrap()
                .unwrap(),
            Some(signed_checkpoint)
        );
        assert_eq!(fetch_count.load(Ordering::Relaxed), 2);
    }
}
