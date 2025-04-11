use eyre::Context;
use tracing::debug;

use hyperlane_base::cache::FunctionCallCache;
use hyperlane_core::{ValidatorAnnounce, H256};

/// Helper function to fetch storage locations for validators.
/// This function is independent of `BaseMetadataBuilder` and can be tested separately.
pub async fn fetch_storage_locations_helper(
    validators: &[H256],
    cache: &impl FunctionCallCache,
    validator_announce: &dyn ValidatorAnnounce,
) -> eyre::Result<Vec<Vec<String>>> {
    const CTX: &str = "When fetching storage locations";
    const DOMAIN_NAME: &str = "";
    const METHOD_NAME: &str = "get_announced_storage_locations";

    let cache_key = format!("storage_locations:{:?}", validators);

    // Attempt to retrieve from cache
    if let Some(cached) = cache
        .get_cached_call_result::<Vec<Vec<String>>>(DOMAIN_NAME, METHOD_NAME, &cache_key)
        .await?
    {
        debug!(?validators, "Cache hit for storage locations");
        return Ok(cached);
    }

    // Fetch from validator_announce if not cached
    let storage_locations = validator_announce
        .get_announced_storage_locations(validators)
        .await
        .context(CTX)?;

    // Store in cache
    cache
        .cache_call_result(DOMAIN_NAME, METHOD_NAME, &cache_key, &storage_locations)
        .await?;

    Ok(storage_locations)
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use mockall::mock;

    use hyperlane_base::cache::LocalCache;
    use hyperlane_core::{
        Announcement, ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneContract,
        HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H256, U256,
    };

    use super::*;

    // Mock implementation for ValidatorAnnounce
    mock! {
        #[derive(Debug)]
        pub ValidatorAnnounceMock {}

        #[async_trait]
        impl ValidatorAnnounce for ValidatorAnnounceMock {
            async fn get_announced_storage_locations(
                &self,
                validators: &[H256],
            ) -> ChainResult<Vec<Vec<String>>>;

            async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome>;

            async fn announce_tokens_needed(&self, announcement: SignedType<Announcement>) -> Option<U256>;
        }

        impl HyperlaneContract for ValidatorAnnounceMock {
            fn address(&self) -> H256;
        }

        impl HyperlaneChain for ValidatorAnnounceMock {
            fn domain(&self) -> &HyperlaneDomain;
            fn provider(&self) -> Box<dyn HyperlaneProvider>;
        }
    }

    #[tokio::test]
    async fn test_fetch_storage_locations_helper_with_cache_hit() {
        let cache = LocalCache::new("test_cache");
        let validator_announce = MockValidatorAnnounceMock::new();
        let validators = vec![H256::from_low_u64_be(1), H256::from_low_u64_be(2)];
        let key = format!("storage_locations:{:?}", validators);

        // Prepopulate the cache with storage locations
        let cached_locations = vec![vec!["location1".to_string()], vec!["location2".to_string()]];
        cache
            .cache_call_result(
                "",
                "get_announced_storage_locations",
                &key,
                &cached_locations,
            )
            .await
            .unwrap();

        let result = fetch_storage_locations_helper(&validators, &cache, &validator_announce).await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap(), cached_locations);
    }

    #[tokio::test]
    async fn test_fetch_storage_locations_helper_with_cache_miss() {
        let cache = LocalCache::new("test_cache");
        let mut validator_announce = MockValidatorAnnounceMock::new();
        let validators = vec![H256::from_low_u64_be(1), H256::from_low_u64_be(2)];

        // Mock the response from the validator announce contract
        validator_announce
            .expect_get_announced_storage_locations()
            .returning(move |_| {
                Ok(vec![
                    vec!["location1".to_string()],
                    vec!["location2".to_string()],
                ])
            });

        let result = fetch_storage_locations_helper(&validators, &cache, &validator_announce).await;

        assert!(result.is_ok());
        assert_eq!(
            result.unwrap(),
            vec![vec!["location1".to_string()], vec!["location2".to_string()]]
        );
    }

    #[tokio::test]
    async fn test_fetch_storage_locations_helper_with_error() {
        let cache = LocalCache::new("test_cache");
        let mut validator_announce = MockValidatorAnnounceMock::new();
        let validators = vec![H256::from_low_u64_be(1), H256::from_low_u64_be(2)];

        // Mock an error response from the validator announce contract
        validator_announce
            .expect_get_announced_storage_locations()
            .returning(move |_| {
                Err(ChainCommunicationError::CustomError(
                    "Error fetching storage locations".to_string(),
                ))
            });

        let result = fetch_storage_locations_helper(&validators, &cache, &validator_announce).await;

        assert!(result.is_err());
    }
}
