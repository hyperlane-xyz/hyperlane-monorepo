use std::sync::Arc;
use std::time::Duration;

use ethers::abi::Function;
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{Block, Eip1559TransactionRequest, H160};
use ethers_core::types::U256 as EthersU256;

use hyperlane_core::{FixedPointNumber, HyperlaneDomain, KnownHyperlaneDomain, U256};
use hyperlane_ethereum::TransactionOverrides;

use crate::adapter::chains::ethereum::tests::MockEvmProvider;
use crate::adapter::chains::ethereum::{
    EthereumAdapter, EthereumAdapterMetrics, NonceDb, NonceManager, NonceManagerState, NonceUpdater,
};
use crate::adapter::AdaptsChain;
use crate::dispatcher::PayloadDb;
use crate::tests::test_utils::tmp_dbs;
use crate::FullPayload;

fn create_test_adapter(
    provider: MockEvmProvider,
    domain: HyperlaneDomain,
    transaction_overrides: TransactionOverrides,
) -> EthereumAdapter {
    let (payload_db, tx_db, nonce_db) = tmp_dbs();
    let provider = Arc::new(provider);
    let signer = H160::random();
    let reorg_period = hyperlane_ethereum::EthereumReorgPeriod::Blocks(1);
    let metrics = EthereumAdapterMetrics::dummy_instance();

    let state = Arc::new(NonceManagerState::new(
        nonce_db,
        tx_db,
        signer,
        metrics.clone(),
    ));

    let nonce_updater = NonceUpdater::new(
        signer,
        reorg_period,
        Duration::from_secs(12),
        provider.clone(),
        state.clone(),
    );

    let nonce_manager = NonceManager {
        address: signer,
        state,
        nonce_updater,
    };

    let op_submission_config = hyperlane_core::config::OpSubmissionConfig::default();
    let batch_contract_address = op_submission_config
        .batch_contract_address
        .unwrap_or_default();

    EthereumAdapter {
        estimated_block_time: Duration::from_secs(12),
        domain,
        transaction_overrides,
        submission_config: op_submission_config,
        provider,
        reorg_period,
        nonce_manager,
        batch_cache: Default::default(),
        batch_contract_address,
        payload_db,
        signer,
        minimum_time_between_resubmissions: Duration::from_secs(1),
        metrics,
    }
}

fn create_test_payload() -> FullPayload {
    let tx = TypedTransaction::Eip1559(Eip1559TransactionRequest {
        to: Some(ethers::types::NameOrAddress::Address(H160::random())),
        data: Some(vec![1, 2, 3, 4].into()),
        ..Default::default()
    });

    #[allow(deprecated)]
    let function = Function {
        name: "test".to_string(),
        inputs: vec![],
        outputs: vec![],
        constant: None,
        state_mutability: ethers::abi::StateMutability::NonPayable,
    };

    let data = serde_json::to_vec(&(tx, function)).unwrap();

    FullPayload::new(
        hyperlane_core::identifiers::UniqueIdentifier::random(),
        "test-payload",
        data,
        None,
        hyperlane_core::H256::random(),
    )
}

#[tokio::test]
async fn test_estimate_gas_limit_basic() {
    let mut provider = MockEvmProvider::new();

    // Mock the provider responses
    provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(U256::from(21000)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(Block {
            gas_limit: EthersU256::from(30_000_000),
            base_fee_per_gas: Some(EthersU256::from(100)),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![100.into()],
            gas_used_ratio: vec![0.5],
        })
    });

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let adapter = create_test_adapter(provider, domain, TransactionOverrides::default());
    let payload = create_test_payload();

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(result.is_ok(), "Gas limit estimation should succeed");
    let estimate = result.unwrap();

    // Gas limit should be 21000 + 75000 (buffer) = 96000
    assert_eq!(estimate.gas_limit, U256::from(96_000));
    assert!(estimate.gas_price > FixedPointNumber::zero());
    assert!(
        estimate.l2_gas_limit.is_none(),
        "Non-Arbitrum chain should not have L2 gas"
    );
}

#[tokio::test]
async fn test_estimate_gas_limit_arbitrum_with_multiplier() {
    let mut provider = MockEvmProvider::new();

    provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(U256::from(100_000)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(Block {
            gas_limit: EthersU256::from(30_000_000),
            base_fee_per_gas: Some(EthersU256::from(100)),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![100.into()],
            gas_used_ratio: vec![0.5],
        })
    });

    // Mock Arbitrum L2 gas estimation
    provider
        .expect_arbitrum_estimate_l2_gas()
        .returning(|_, _| Ok(Some(U256::from(50_000))));

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
    let adapter = create_test_adapter(provider, domain, TransactionOverrides::default());
    let payload = create_test_payload();

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(
        result.is_ok(),
        "Gas limit estimation should succeed for Arbitrum"
    );
    let estimate = result.unwrap();

    // For Arbitrum: (100_000 * 11 / 10) + 75_000 = 110_000 + 75_000 = 185_000
    assert_eq!(estimate.gas_limit, U256::from(185_000));
    assert!(estimate.gas_price > FixedPointNumber::zero());
    assert_eq!(
        estimate.l2_gas_limit,
        Some(U256::from(50_000)),
        "Arbitrum should have L2 gas estimate"
    );
}

#[tokio::test]
async fn test_estimate_gas_limit_with_cap() {
    let mut provider = MockEvmProvider::new();

    provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(U256::from(1_000_000)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(Block {
            gas_limit: EthersU256::from(30_000_000),
            base_fee_per_gas: Some(EthersU256::from(100)),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![100.into()],
            gas_used_ratio: vec![0.5],
        })
    });

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let transaction_overrides = TransactionOverrides {
        gas_limit_cap: Some(U256::from(500_000)),
        ..Default::default()
    };
    let adapter = create_test_adapter(provider, domain, transaction_overrides);
    let payload = create_test_payload();

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(result.is_ok(), "Gas limit estimation should succeed");
    let estimate = result.unwrap();

    // Gas limit should be capped at 500_000 even though estimate + buffer would be higher
    assert_eq!(estimate.gas_limit, U256::from(500_000));
}

#[tokio::test]
async fn test_estimate_gas_limit_with_override() {
    let mut provider = MockEvmProvider::new();

    provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(U256::from(21_000)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(Block {
            gas_limit: EthersU256::from(30_000_000),
            base_fee_per_gas: Some(EthersU256::from(100)),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![100.into()],
            gas_used_ratio: vec![0.5],
        })
    });

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let transaction_overrides = TransactionOverrides {
        gas_limit: Some(U256::from(200_000)),
        ..Default::default()
    };
    let adapter = create_test_adapter(provider, domain, transaction_overrides);
    let payload = create_test_payload();

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(result.is_ok(), "Gas limit estimation should succeed");
    let estimate = result.unwrap();

    // Gas limit override should take max of estimate+buffer (96_000) and override (200_000)
    assert_eq!(estimate.gas_limit, U256::from(200_000));
}

#[tokio::test]
async fn test_estimate_gas_limit_capped_by_block_gas_limit() {
    let mut provider = MockEvmProvider::new();

    provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(U256::from(50_000_000))); // Very high estimate

    provider.expect_get_block().returning(|_| {
        Ok(Some(Block {
            gas_limit: EthersU256::from(30_000_000), // Block gas limit
            base_fee_per_gas: Some(EthersU256::from(100)),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![100.into()],
            gas_used_ratio: vec![0.5],
        })
    });

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let adapter = create_test_adapter(provider, domain, TransactionOverrides::default());
    let payload = create_test_payload();

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(result.is_ok(), "Gas limit estimation should succeed");
    let estimate = result.unwrap();

    // Gas limit should be capped at block gas limit
    assert_eq!(estimate.gas_limit, U256::from(30_000_000));
}

#[tokio::test]
async fn test_estimate_gas_limit_provider_error() {
    let mut provider = MockEvmProvider::new();

    provider.expect_estimate_gas_limit().returning(|_, _| {
        Err(hyperlane_core::ChainCommunicationError::from_other_str(
            "estimation failed",
        ))
    });

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let adapter = create_test_adapter(provider, domain, TransactionOverrides::default());
    let payload = create_test_payload();

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(
        result.is_err(),
        "Gas limit estimation should fail when provider errors"
    );
}

#[tokio::test]
async fn test_estimate_gas_limit_with_legacy_transaction() {
    let mut provider = MockEvmProvider::new();

    provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(U256::from(30_000)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(Block {
            gas_limit: EthersU256::from(30_000_000),
            base_fee_per_gas: Some(EthersU256::from(100)),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![100.into()],
            gas_used_ratio: vec![0.5],
        })
    });

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let adapter = create_test_adapter(provider, domain, TransactionOverrides::default());

    // Create a legacy transaction payload
    let tx = TypedTransaction::Legacy(ethers_core::types::TransactionRequest {
        to: Some(ethers::types::NameOrAddress::Address(H160::random())),
        data: Some(vec![1, 2, 3, 4].into()),
        gas_price: Some(EthersU256::from(100)),
        ..Default::default()
    });

    #[allow(deprecated)]
    let function = Function {
        name: "test".to_string(),
        inputs: vec![],
        outputs: vec![],
        constant: None,
        state_mutability: ethers::abi::StateMutability::NonPayable,
    };

    let data = serde_json::to_vec(&(tx, function)).unwrap();

    let payload = FullPayload::new(
        hyperlane_core::identifiers::UniqueIdentifier::random(),
        "test-legacy-payload",
        data,
        None,
        hyperlane_core::H256::random(),
    );

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(
        result.is_ok(),
        "Gas limit estimation should succeed for legacy transactions"
    );
    let estimate = result.unwrap();

    // Gas limit should be 30_000 + 75_000 (buffer) = 105_000
    assert_eq!(estimate.gas_limit, U256::from(105_000));
    assert!(estimate.gas_price > FixedPointNumber::zero());
}

#[tokio::test]
async fn test_estimate_gas_limit_arbitrum_without_l2_gas() {
    let mut provider = MockEvmProvider::new();

    provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(U256::from(100_000)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(Block {
            gas_limit: EthersU256::from(30_000_000),
            base_fee_per_gas: Some(EthersU256::from(100)),
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![10.into()]],
            base_fee_per_gas: vec![100.into()],
            gas_used_ratio: vec![0.5],
        })
    });

    // Mock Arbitrum L2 gas estimation returning None (estimation not available)
    provider
        .expect_arbitrum_estimate_l2_gas()
        .returning(|_, _| Ok(None));

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
    let adapter = create_test_adapter(provider, domain, TransactionOverrides::default());
    let payload = create_test_payload();

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(
        result.is_ok(),
        "Gas limit estimation should succeed even without L2 gas"
    );
    let estimate = result.unwrap();

    assert_eq!(
        estimate.l2_gas_limit, None,
        "L2 gas should be None when not available"
    );
}

#[tokio::test]
async fn test_estimate_gas_limit_gas_price_eip1559() {
    let mut provider = MockEvmProvider::new();

    provider
        .expect_estimate_gas_limit()
        .returning(|_, _| Ok(U256::from(21_000)));

    provider.expect_get_block().returning(|_| {
        Ok(Some(Block {
            gas_limit: EthersU256::from(30_000_000),
            base_fee_per_gas: Some(EthersU256::from(50_000_000_000u64)), // 50 gwei
            ..Default::default()
        }))
    });

    provider.expect_fee_history().returning(|_, _, _| {
        Ok(ethers::types::FeeHistory {
            oldest_block: 0.into(),
            reward: vec![vec![2_000_000_000u64.into()]], // 2 gwei priority
            base_fee_per_gas: vec![50_000_000_000u64.into()], // 50 gwei base
            gas_used_ratio: vec![0.5],
        })
    });

    let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let adapter = create_test_adapter(provider, domain, TransactionOverrides::default());
    let payload = create_test_payload();

    let result = adapter.estimate_gas_limit(&payload).await;

    assert!(result.is_ok(), "Gas limit estimation should succeed");
    let estimate = result.unwrap();

    // Gas price should be properly estimated (should be > 0)
    assert!(
        estimate.gas_price > FixedPointNumber::zero(),
        "Gas price should be estimated"
    );
}
