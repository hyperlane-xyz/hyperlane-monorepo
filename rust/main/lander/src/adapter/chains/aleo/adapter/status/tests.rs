use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use hyperlane_aleo::{
    AleoConfirmedTransaction, AleoProviderForLander, AleoUnconfirmedTransaction, CurrentNetwork,
};
use hyperlane_core::{ChainResult, H512};

use crate::{TransactionDropReason, TransactionStatus};

use super::get_tx_hash_status;

// ============================================================================
// Integration tests with real ConfirmedTransaction objects from JSON fixtures
// ============================================================================

/// Mock provider that can return pre-loaded transaction objects
#[derive(Clone)]
struct MockProviderWithFixtures {
    confirmed_transactions: Arc<Mutex<HashMap<H512, AleoConfirmedTransaction<CurrentNetwork>>>>,
    unconfirmed_transactions: Arc<Mutex<HashMap<H512, AleoUnconfirmedTransaction<CurrentNetwork>>>>,
}

impl MockProviderWithFixtures {
    fn new() -> Self {
        Self {
            confirmed_transactions: Arc::new(Mutex::new(HashMap::new())),
            unconfirmed_transactions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Load a confirmed transaction from JSON fixture and associate it with a hash
    fn load_confirmed_fixture(&self, hash: H512, fixture_name: &str) -> ChainResult<()> {
        let base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/adapter/chains/aleo/adapter/status/test_fixtures");
        let fixture_path = base_path.join(fixture_name);

        let json_str = std::fs::read_to_string(&fixture_path).map_err(|e| {
            hyperlane_core::ChainCommunicationError::from_other_str(&format!(
                "Failed to read fixture {}: {}",
                fixture_path.display(),
                e
            ))
        })?;

        let tx: AleoConfirmedTransaction<CurrentNetwork> = serde_json::from_str(&json_str)
            .map_err(|e| {
                hyperlane_core::ChainCommunicationError::from_other_str(&format!(
                    "Failed to deserialize fixture {}: {}",
                    fixture_name, e
                ))
            })?;

        self.confirmed_transactions.lock().unwrap().insert(hash, tx);
        Ok(())
    }

    /// Load an unconfirmed transaction from JSON fixture and associate it with a hash
    fn load_unconfirmed_fixture(&self, hash: H512, fixture_name: &str) -> ChainResult<()> {
        let base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/adapter/chains/aleo/adapter/status/test_fixtures");
        let fixture_path = base_path.join(fixture_name);

        let json_str = std::fs::read_to_string(&fixture_path).map_err(|e| {
            hyperlane_core::ChainCommunicationError::from_other_str(&format!(
                "Failed to read fixture {}: {}",
                fixture_path.display(),
                e
            ))
        })?;

        let tx: AleoUnconfirmedTransaction<CurrentNetwork> = serde_json::from_str(&json_str)
            .map_err(|e| {
                hyperlane_core::ChainCommunicationError::from_other_str(&format!(
                    "Failed to deserialize fixture {}: {}",
                    fixture_name, e
                ))
            })?;

        self.unconfirmed_transactions
            .lock()
            .unwrap()
            .insert(hash, tx);
        Ok(())
    }
}

#[async_trait]
impl AleoProviderForLander for MockProviderWithFixtures {
    async fn submit_tx<I>(
        &self,
        _program_id: &str,
        _function_name: &str,
        _input: I,
    ) -> ChainResult<H512>
    where
        I: IntoIterator<Item = String> + Send,
        I::IntoIter: ExactSizeIterator,
    {
        Ok(H512::random())
    }

    async fn get_confirmed_transaction(
        &self,
        transaction_id: H512,
    ) -> ChainResult<AleoConfirmedTransaction<CurrentNetwork>> {
        self.confirmed_transactions
            .lock()
            .unwrap()
            .get(&transaction_id)
            .cloned()
            .ok_or_else(|| {
                hyperlane_core::ChainCommunicationError::from_other_str("Transaction not found")
            })
    }

    async fn get_unconfirmed_transaction(
        &self,
        transaction_id: H512,
    ) -> ChainResult<AleoUnconfirmedTransaction<CurrentNetwork>> {
        self.unconfirmed_transactions
            .lock()
            .unwrap()
            .get(&transaction_id)
            .cloned()
            .ok_or_else(|| {
                hyperlane_core::ChainCommunicationError::from_other_str(
                    "Transaction not found in mempool",
                )
            })
    }
}

#[tokio::test]
async fn test_status_finalized_accepted() {
    let provider = Arc::new(MockProviderWithFixtures::new());
    let hash = H512::random();

    // Load the accepted transaction fixture
    provider
        .load_confirmed_fixture(hash, "confirmed_accepted.json")
        .unwrap();

    let result = get_tx_hash_status(&provider, hash).await;

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::Finalized);
}

#[tokio::test]
async fn test_status_finalized_rejected() {
    let provider = Arc::new(MockProviderWithFixtures::new());
    let hash = H512::random();

    // Load the rejected transaction fixture
    // Note: Currently, rejected transactions are reported as Finalized
    // Payload success criteria will be used to determine if payloads were reverted
    provider
        .load_confirmed_fixture(hash, "confirmed_rejected.json")
        .unwrap();

    let result = get_tx_hash_status(&provider, hash).await;

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::Finalized);
}

#[tokio::test]
async fn test_status_mempool() {
    let provider = Arc::new(MockProviderWithFixtures::new());
    let hash = H512::random();

    // Load the unconfirmed transaction fixture
    provider
        .load_unconfirmed_fixture(hash, "unconfirmed_mempool.json")
        .unwrap();

    let result = get_tx_hash_status(&provider, hash).await;

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::Mempool);
}

#[tokio::test]
async fn test_status_not_found() {
    let provider = Arc::new(MockProviderWithFixtures::new());
    let hash = H512::random();

    // Don't load any fixtures - transaction should not be found
    let result = get_tx_hash_status(&provider, hash).await;

    assert!(result.is_ok());
    assert_eq!(result.unwrap(), TransactionStatus::PendingInclusion);
}

#[tokio::test]
async fn test_status_with_different_hashes() {
    let provider = Arc::new(MockProviderWithFixtures::new());

    // Test with different hashes - all should return PendingInclusion when not found
    let hash1 = H512::random();
    let hash2 = H512::random();
    let hash3 = H512::zero();

    let result1 = get_tx_hash_status(&provider, hash1).await;
    let result2 = get_tx_hash_status(&provider, hash2).await;
    let result3 = get_tx_hash_status(&provider, hash3).await;

    assert!(result1.is_ok());
    assert!(result2.is_ok());
    assert!(result3.is_ok());
    assert_eq!(result1.unwrap(), TransactionStatus::PendingInclusion);
    assert_eq!(result2.unwrap(), TransactionStatus::PendingInclusion);
    assert_eq!(result3.unwrap(), TransactionStatus::PendingInclusion);
}

#[tokio::test]
async fn test_status_multiple_sequential_checks() {
    let provider = Arc::new(MockProviderWithFixtures::new());
    let hash = H512::random();

    // First check - not found
    let result1 = get_tx_hash_status(&provider, hash).await;
    assert!(result1.is_ok());
    assert_eq!(result1.unwrap(), TransactionStatus::PendingInclusion);

    // Second check with same hash - still not found
    let result2 = get_tx_hash_status(&provider, hash).await;
    assert!(result2.is_ok());
    assert_eq!(result2.unwrap(), TransactionStatus::PendingInclusion);

    // Third check with different hash - also not found
    let different_hash = H512::random();
    let result3 = get_tx_hash_status(&provider, different_hash).await;
    assert!(result3.is_ok());
    assert_eq!(result3.unwrap(), TransactionStatus::PendingInclusion);
}
