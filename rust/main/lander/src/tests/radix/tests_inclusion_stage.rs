use std::{collections::HashMap, sync::Arc, time::Duration};

use hyperlane_core::{ChainCommunicationError, KnownHyperlaneDomain};
use hyperlane_sealevel::{SealevelKeypair, SealevelTxCostEstimate, TransactionSubmitter};
use tokio::{select, sync::mpsc};
use tracing::info;
use tracing_test::traced_test;

use crate::adapter::chains::radix::tests::MockRadixProvider;

const TEST_BLOCK_TIME: Duration = Duration::from_nanos(0);
const TEST_MINIMUM_TIME_BETWEEN_RESUBMISSIONS: Duration = Duration::from_nanos(0);

fn mocked_radix_provider() -> MockRadixProvider {
    let mock_provider = MockRadixProvider::new();
    mock_provider
}

async fn run_and_expect_successful_inclusion(
    mut expected_tx_states: Vec<()>,
    mock_evm_provider: MockRadixProvider,
    block_time: Duration,
    minimum_time_between_resubmissions: Duration,
) {
}

#[tokio::test]
#[traced_test]
async fn test_radix_inclusion_happy_path() {
    let block_time = TEST_BLOCK_TIME;
    let mock_provider = mocked_radix_provider();

    let expected_tx_states: Vec<()> = vec![];
    run_and_expect_successful_inclusion(
        expected_tx_states,
        mock_provider,
        block_time,
        TEST_MINIMUM_TIME_BETWEEN_RESUBMISSIONS,
    )
    .await;
}
