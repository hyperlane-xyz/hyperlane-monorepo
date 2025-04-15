use std::{sync::Arc, time::Duration};

use derive_new::new;
use hyperlane_core::{
    rpc_clients::{DEFAULT_MAX_RPC_RETRIES, RPC_RETRY_SLEEP_DURATION},
    total_estimated_cost, BatchResult, ChainCommunicationError, ChainResult, ConfirmReason,
    HyperlaneDomain, Mailbox, PendingOperation, PendingOperationStatus, QueueOperation, TxOutcome,
};
use itertools::{Either, Itertools};
use tokio::time::sleep;
use tracing::{info, instrument, warn};

use super::{
    op_queue::OpQueue,
    op_submitter::{submit_single_operation, SerialSubmitterMetrics},
    pending_message::CONFIRM_DELAY,
};

#[derive(new, Debug)]
pub(crate) struct OperationBatch {
    operations: Vec<QueueOperation>,
    #[allow(dead_code)]
    domain: HyperlaneDomain,
}

impl OperationBatch {
    #[instrument(skip_all, fields(domain=%self.domain, batch_size=self.operations.len()))]
    pub async fn submit(
        self,
        prepare_queue: &mut OpQueue,
        confirm_queue: &mut OpQueue,
        metrics: &SerialSubmitterMetrics,
    ) {
        let excluded_ops = match self.try_submit_as_batch(metrics).await {
            Ok(batch_result) => {
                Self::handle_batch_result(self.operations, batch_result, confirm_queue).await
            }
            Err(e) => {
                warn!(error=?e, batch=?self.operations, "Error when submitting batch");
                self.operations
            }
        };

        if !excluded_ops.is_empty() {
            warn!(excluded_ops=?excluded_ops, "Either operations reverted in the batch or the txid wasn't included. Falling back to serial submission.");
            OperationBatch::new(excluded_ops, self.domain)
                .submit_serially(prepare_queue, confirm_queue, metrics)
                .await;
        }
    }

    #[instrument(skip(metrics), ret, level = "debug")]
    async fn try_submit_as_batch(
        &self,
        metrics: &SerialSubmitterMetrics,
    ) -> ChainResult<BatchResult> {
        // We already assume that the relayer submits to a single mailbox per destination.
        // So it's fine to use the first item in the batch to get the mailbox.
        let Some(first_item) = self.operations.first() else {
            return Err(ChainCommunicationError::BatchIsEmpty);
        };
        let Some(mailbox) = first_item.try_get_mailbox() else {
            // no need to update the metrics since all operations are excluded
            return Ok(BatchResult::failed(self.operations.len()));
        };
        let outcome = self
            .submit_batch_with_retry(mailbox, DEFAULT_MAX_RPC_RETRIES, RPC_RETRY_SLEEP_DURATION)
            .await?;
        let ops_submitted = self.operations.len() - outcome.failed_indexes.len();
        metrics.ops_submitted.inc_by(ops_submitted as u64);
        Ok(outcome)
    }

    async fn submit_batch_with_retry(
        &self,
        mailbox: Arc<dyn Mailbox>,
        max_retries: usize,
        sleep_period: Duration,
    ) -> ChainResult<BatchResult> {
        if !mailbox.supports_batching() {
            return Ok(BatchResult::failed(self.operations.len()));
        }
        let mut last_error = None;
        let ops = self.operations.iter().collect_vec();
        let op_ids = ops.iter().map(|op| op.id()).collect_vec();
        for retry_number in 1..DEFAULT_MAX_RPC_RETRIES {
            match mailbox.process_batch(ops.clone()).await {
                Ok(res) => return Ok(res),
                Err(err) => {
                    warn!(retries=retry_number, ?max_retries, error=?err, ids=?op_ids, "Retrying batch submission");
                    last_error = Some(err);
                    sleep(sleep_period).await;
                }
            }
        }
        let error = last_error.unwrap_or(ChainCommunicationError::BatchingFailed);
        Err(error)
    }

    /// Process the operations sent by a batch.
    /// Returns the operations that were not sent
    async fn handle_batch_result(
        operations: Vec<QueueOperation>,
        batch_result: BatchResult,
        confirm_queue: &mut OpQueue,
    ) -> Vec<Box<dyn PendingOperation>> {
        let (sent_ops, excluded_ops): (Vec<_>, Vec<_>) =
            operations.into_iter().enumerate().partition_map(|(i, op)| {
                if !batch_result.failed_indexes.contains(&i) {
                    Either::Left(op)
                } else {
                    Either::Right(op)
                }
            });

        if let Some(outcome) = batch_result.outcome {
            info!(batch_size=sent_ops.len(), outcome=?outcome, batch=?sent_ops, ?excluded_ops, "Submitted transaction batch");
            Self::update_sent_ops_state(sent_ops, outcome, confirm_queue).await;
        }
        excluded_ops
    }

    async fn update_sent_ops_state(
        sent_ops: Vec<Box<dyn PendingOperation>>,
        outcome: TxOutcome,
        confirm_queue: &mut OpQueue,
    ) {
        let total_estimated_cost = total_estimated_cost(sent_ops.as_slice());
        for mut op in sent_ops {
            op.set_operation_outcome(outcome.clone(), total_estimated_cost);
            op.set_next_attempt_after(CONFIRM_DELAY);
            confirm_queue
                .push(
                    op,
                    Some(PendingOperationStatus::Confirm(
                        ConfirmReason::SubmittedBySelf,
                    )),
                )
                .await;
        }
    }

    async fn submit_serially(
        self,
        prepare_queue: &mut OpQueue,
        confirm_queue: &mut OpQueue,
        metrics: &SerialSubmitterMetrics,
    ) {
        for op in self.operations.into_iter() {
            submit_single_operation(op, prepare_queue, confirm_queue, metrics).await;
        }
    }
}

#[cfg(test)]
mod tests {

    use std::sync::Arc;

    use crate::msg::op_queue::test::MockPendingOperation;
    use hyperlane_core::KnownHyperlaneDomain;
    use hyperlane_test::mocks::MockMailboxContract;

    use super::*;

    fn dummy_pending_operation(
        mailbox: Arc<dyn Mailbox>,
        domain: HyperlaneDomain,
    ) -> Box<dyn PendingOperation> {
        let seconds_to_next_attempt = 10;
        let mut mock_pending_operation =
            MockPendingOperation::new(seconds_to_next_attempt, domain.clone());
        mock_pending_operation.mailbox = Some(mailbox);
        Box::new(mock_pending_operation) as Box<dyn PendingOperation>
    }

    #[tokio::test]
    async fn test_handle_batch_result_succeeds() {
        let mut mock_mailbox = MockMailboxContract::new();
        let dummy_domain: HyperlaneDomain = KnownHyperlaneDomain::Alfajores.into();

        mock_mailbox.expect_supports_batching().return_const(true);
        mock_mailbox.expect_process_batch().returning(move |_ops| {
            let batch_result = BatchResult::new(None, vec![]);
            Ok(batch_result)
        });
        let mock_mailbox = Arc::new(mock_mailbox) as Arc<dyn Mailbox>;
        let operation = dummy_pending_operation(mock_mailbox.clone(), dummy_domain.clone());

        let operations = vec![operation];
        let op_batch = OperationBatch::new(operations, dummy_domain);
        let batch_result = op_batch
            .submit_batch_with_retry(mock_mailbox, 1, Duration::from_secs(0))
            .await
            .unwrap();
        assert!(
            batch_result.failed_indexes.is_empty(),
            "Batch result should not have failed indexes"
        )
    }

    #[tokio::test]
    async fn test_handle_batch_result_fails() {
        let mut mock_mailbox = MockMailboxContract::new();
        let dummy_domain: HyperlaneDomain = KnownHyperlaneDomain::Alfajores.into();

        mock_mailbox.expect_supports_batching().return_const(true);
        mock_mailbox
            .expect_process_batch()
            .returning(move |_ops| Err(ChainCommunicationError::BatchingFailed));
        let mock_mailbox = Arc::new(mock_mailbox) as Arc<dyn Mailbox>;
        let operation = dummy_pending_operation(mock_mailbox.clone(), dummy_domain.clone());

        let operations = vec![operation];
        let op_batch = OperationBatch::new(operations, dummy_domain);
        let result = op_batch
            .submit_batch_with_retry(mock_mailbox, 1, Duration::from_secs(0))
            .await;
        assert!(matches!(
            result,
            Err(ChainCommunicationError::BatchingFailed)
        ));
    }

    #[tokio::test]
    async fn test_handle_batch_succeeds_eventually() {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .try_init();
        let mut mock_mailbox = MockMailboxContract::new();
        let dummy_domain: HyperlaneDomain = KnownHyperlaneDomain::Alfajores.into();

        let mut counter = 0;
        mock_mailbox.expect_supports_batching().return_const(true);
        mock_mailbox.expect_process_batch().returning(move |_ops| {
            counter += 1;
            if counter < 5 {
                return Err(ChainCommunicationError::BatchingFailed);
            }
            let batch_result = BatchResult::new(None, vec![]);
            Ok(batch_result)
        });
        let mock_mailbox = Arc::new(mock_mailbox) as Arc<dyn Mailbox>;
        let operation = dummy_pending_operation(mock_mailbox.clone(), dummy_domain.clone());

        let operations = vec![operation];
        let op_batch = OperationBatch::new(operations, dummy_domain);
        let batch_result = op_batch
            .submit_batch_with_retry(mock_mailbox, 1, Duration::from_secs(0))
            .await
            .unwrap();
        assert!(
            batch_result.failed_indexes.is_empty(),
            "Batch result should not have failed indexes"
        );
    }

    #[tokio::test]
    async fn test_handle_batch_result_fails_if_not_supported() {
        let mut mock_mailbox = MockMailboxContract::new();
        let dummy_domain: HyperlaneDomain = KnownHyperlaneDomain::Alfajores.into();

        mock_mailbox.expect_supports_batching().return_const(false);
        mock_mailbox.expect_process_batch().returning(move |_ops| {
            let batch_result = BatchResult::new(None, vec![]);
            Ok(batch_result)
        });
        let mock_mailbox = Arc::new(mock_mailbox) as Arc<dyn Mailbox>;
        let operation = dummy_pending_operation(mock_mailbox.clone(), dummy_domain.clone());

        let operations = vec![operation];
        let op_batch = OperationBatch::new(operations, dummy_domain);
        let batch_result = op_batch
            .submit_batch_with_retry(mock_mailbox, 1, Duration::from_secs(0))
            .await
            .unwrap();
        assert!(
            batch_result.failed_indexes.len() == 1,
            "Batching should fail if not supported"
        )
    }
}
