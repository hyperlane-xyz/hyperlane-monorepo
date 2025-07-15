use std::time::Duration;

use hyperlane_core::H256;
use tracing_test::traced_test;

use crate::TransactionStatus;

const TEST_BLOCK_TIME: Duration = Duration::from_millis(50);

#[tokio::test]
#[traced_test]
async fn test_inclusion_happy_path() {
    let block_time = TEST_BLOCK_TIME;
    // let mock_svm_provider = mocked_svm_provider();

    let expected_tx_states = vec![
        ExpectedSvmTxState {
            compute_units: 100_000,
            compute_unit_price_micro_lamports: 1_000_000,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            recent_blockhash: None,
        },
        ExpectedSvmTxState {
            compute_units: 100_000,
            compute_unit_price_micro_lamports: 1_000_000,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            recent_blockhash: None,
        },
        ExpectedSvmTxState {
            compute_units: 100_000,
            compute_unit_price_micro_lamports: 1_000_000,
            status: TransactionStatus::PendingInclusion,
            retries: 0,
            recent_blockhash: None,
        },
    ];
    // run_and_expect_successful_inclusion(expected_tx_states, mock_svm_provider, block_time).await;
}

struct ExpectedSvmTxState {
    pub compute_units: u32,
    pub compute_unit_price_micro_lamports: u64,
    pub status: TransactionStatus,
    pub retries: u32,
    pub recent_blockhash: Option<H256>,
}

// async fn run_and_expect_successful_inclusion(
//     mut expected_tx_states: Vec<ExpectedSvmTxState>,
//     mock_svm_provider: MockSvmProvider,
//     block_time: Duration,
// ) {
// }

// fn mocked_svm_adapter() -> MockSvmProvider {
//     MockSvmProvider::new()
//         .with_block_time(TEST_BLOCK_TIME)
//         .with_compute_unit_price_micro_lamports(1_000_000)
//         .with_compute_units(100_000)
//         .with_transaction_status(TransactionStatus::PendingInclusion)
// }
