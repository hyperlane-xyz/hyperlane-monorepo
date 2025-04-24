use async_trait::async_trait;
use mockall::mock;

use hyperlane_base::cache::LocalCache;
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, KnownHyperlaneDomain, SignedType, TxOutcome,
    ValidatorAnnounce, H256, U256,
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

        async fn announce_tokens_needed(&self, announcement: SignedType<Announcement>, chain_signer: H256) -> Option<U256>;
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
    let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
    let cache = LocalCache::new("test_cache");
    let validators = vec![H256::from_low_u64_be(1), H256::from_low_u64_be(2)];

    let mut validator_announce = MockValidatorAnnounceMock::new();

    let key1 = generate_cache_key(&validators[0]);
    let key2 = generate_cache_key(&validators[1]);

    // Mock the response from the validator announce contract
    validator_announce
        .expect_domain()
        .return_const(origin.clone());

    // Prepopulate the cache with storage locations
    let location1 = vec!["location1".to_string()];
    let location2 = vec!["location2".to_string()];
    cache
        .cache_call_result(&origin.name(), METHOD_NAME, &key1, &location1)
        .await
        .unwrap();
    cache
        .cache_call_result(&origin.name(), METHOD_NAME, &key2, &location2)
        .await
        .unwrap();

    let result = fetch_storage_locations_helper(&validators, &cache, &validator_announce).await;

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), vec![location1, location2]);
}

#[tokio::test]
async fn test_fetch_storage_locations_helper_with_cache_miss() {
    let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
    let cache = LocalCache::new("test_cache");
    let validators = vec![H256::from_low_u64_be(1), H256::from_low_u64_be(2)];

    let mut validator_announce = MockValidatorAnnounceMock::new();

    // Mock the response from the validator announce contract
    validator_announce
        .expect_get_announced_storage_locations()
        .returning(move |_| {
            Ok(vec![
                vec!["location1".to_string()],
                vec!["location2".to_string()],
            ])
        });
    validator_announce
        .expect_domain()
        .return_const(origin.clone());

    let result = fetch_storage_locations_helper(&validators, &cache, &validator_announce).await;

    assert!(result.is_ok());
    assert_eq!(
        result.unwrap(),
        vec![vec!["location1".to_string()], vec!["location2".to_string()]]
    );
}

#[tokio::test]
async fn test_fetch_storage_locations_helper_with_error() {
    let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
    let cache = LocalCache::new("test_cache");
    let validators = vec![H256::from_low_u64_be(1), H256::from_low_u64_be(2)];

    let mut validator_announce = MockValidatorAnnounceMock::new();

    // Mock an error response from the validator announce contract
    validator_announce
        .expect_get_announced_storage_locations()
        .returning(move |_| {
            Err(ChainCommunicationError::CustomError(
                "Error fetching storage locations".to_string(),
            ))
        });
    validator_announce
        .expect_domain()
        .return_const(origin.clone());

    let result = fetch_storage_locations_helper(&validators, &cache, &validator_announce).await;

    assert!(result.is_err());
}

#[tokio::test]
async fn test_fetch_storage_locations_helper_with_partial_cache_hit() {
    let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
    let cache = LocalCache::new("test_cache");
    let validators = vec![
        H256::from_low_u64_be(1),
        H256::from_low_u64_be(2),
        H256::from_low_u64_be(3),
    ];

    let mut validator_announce = MockValidatorAnnounceMock::new();

    let key1 = generate_cache_key(&validators[0]);
    let key2 = generate_cache_key(&validators[1]);

    // Prepopulate the cache with storage locations for some validators
    let location1 = vec!["location1".to_string()];
    let location2 = vec!["location2".to_string()];
    cache
        .cache_call_result(&origin.name(), METHOD_NAME, &key1, &location1)
        .await
        .unwrap();
    cache
        .cache_call_result(&origin.name(), METHOD_NAME, &key2, &location2)
        .await
        .unwrap();

    // Mock the response from the validator announce contract for the missing validator
    let location3 = "location3";
    validator_announce
        .expect_get_announced_storage_locations()
        .returning(move |_| Ok(vec![vec![location3.to_string()]]));
    validator_announce
        .expect_domain()
        .return_const(origin.clone());

    let result = fetch_storage_locations_helper(&validators, &cache, &validator_announce).await;

    assert!(result.is_ok());
    assert_eq!(
        result.unwrap(),
        vec![location1, location2, vec!["location3".to_string()]]
    );
}

#[tokio::test]
async fn test_fetch_storage_locations_helper_with_different_domains() {
    let origin1 = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
    let origin2 = HyperlaneDomain::Known(KnownHyperlaneDomain::Optimism);
    let cache = LocalCache::new("test_cache");
    let validators = vec![H256::from_low_u64_be(1)];

    let mut validator_announce1 = MockValidatorAnnounceMock::new();
    let mut validator_announce2 = MockValidatorAnnounceMock::new();

    let key = generate_cache_key(&validators[0]);

    // Mock the response from the validator announce contracts
    validator_announce1
        .expect_domain()
        .return_const(origin1.clone());
    validator_announce2
        .expect_domain()
        .return_const(origin2.clone());

    // Prepopulate the cache with storage locations for origin1
    let location1 = vec!["location1_origin1".to_string()];
    cache
        .cache_call_result(&origin1.name(), METHOD_NAME, &key, &location1)
        .await
        .unwrap();

    // Prepopulate the cache with storage locations for origin2
    let location2 = vec!["location1_origin2".to_string()];
    cache
        .cache_call_result(&origin2.name(), METHOD_NAME, &key, &location2)
        .await
        .unwrap();

    // Fetch storage locations for origin1
    let result1 = fetch_storage_locations_helper(&validators, &cache, &validator_announce1).await;
    assert!(result1.is_ok());
    assert_eq!(result1.unwrap(), vec![location1]);

    // Fetch storage locations for origin2
    let result2 = fetch_storage_locations_helper(&validators, &cache, &validator_announce2).await;
    assert!(result2.is_ok());
    assert_eq!(result2.unwrap(), vec![location2]);
}
