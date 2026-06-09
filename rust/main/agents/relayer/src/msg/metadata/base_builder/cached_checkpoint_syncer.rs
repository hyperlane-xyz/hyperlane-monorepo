use std::fmt::Debug;

use eyre::Result;
use serde::{Deserialize, Serialize};
use tracing::debug;

use hyperlane_base::{cache::FunctionCallCache, CheckpointSyncer};
use hyperlane_core::{
    ReorgEvent, ReorgEventResponse, SignedAnnouncement, SignedCheckpointWithMessageId, H256,
};

const FETCH_CHECKPOINT_METHOD: &str = "fetch_checkpoint";

#[derive(Debug, Serialize, Deserialize)]
struct CachedCheckpointKey {
    validator: H256,
    storage_location: String,
    index: u32,
}

#[derive(Debug)]
pub struct CachedCheckpointSyncer<C> {
    inner: Box<dyn CheckpointSyncer>,
    cache: C,
    origin_domain_name: String,
    validator: H256,
    storage_location: String,
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
            inner,
            cache,
            origin_domain_name,
            validator,
            storage_location,
        }
    }

    fn cache_key(&self, index: u32) -> CachedCheckpointKey {
        CachedCheckpointKey {
            validator: self.validator,
            storage_location: self.storage_location.clone(),
            index,
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
}

#[async_trait::async_trait]
impl<C> CheckpointSyncer for CachedCheckpointSyncer<C>
where
    C: FunctionCallCache + Debug,
{
    async fn latest_index(&self) -> Result<Option<u32>> {
        self.inner.latest_index().await
    }

    async fn write_latest_index(&self, index: u32) -> Result<()> {
        self.inner.write_latest_index(index).await
    }

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
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
            Ok(Some(signed_checkpoint)) => return Ok(Some(signed_checkpoint)),
            Ok(None) => {}
            Err(err) => {
                debug!(
                    error = %err,
                    validator = ?self.validator,
                    index,
                    "Failed to fetch signed checkpoint from cache"
                );
            }
        }

        let result = self.inner.fetch_checkpoint(index).await;
        if let Ok(Some(signed_checkpoint)) = &result {
            if !self.is_cacheable_checkpoint(index, signed_checkpoint) {
                return result;
            }

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
        result
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

    use super::*;

    #[derive(Debug)]
    struct CountingCheckpointSyncer {
        fetch_count: Arc<AtomicUsize>,
        responses: Mutex<VecDeque<Result<Option<SignedCheckpointWithMessageId>>>>,
    }

    impl CountingCheckpointSyncer {
        fn new(
            responses: Vec<Result<Option<SignedCheckpointWithMessageId>>>,
        ) -> (Self, Arc<AtomicUsize>) {
            let fetch_count = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    fetch_count: fetch_count.clone(),
                    responses: Mutex::new(responses.into()),
                },
                fetch_count,
            )
        }
    }

    #[async_trait::async_trait]
    impl CheckpointSyncer for CountingCheckpointSyncer {
        async fn latest_index(&self) -> Result<Option<u32>> {
            Ok(Some(0))
        }

        async fn write_latest_index(&self, _index: u32) -> Result<()> {
            Ok(())
        }

        async fn fetch_checkpoint(
            &self,
            _index: u32,
        ) -> Result<Option<SignedCheckpointWithMessageId>> {
            self.fetch_count.fetch_add(1, Ordering::Relaxed);
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
}
