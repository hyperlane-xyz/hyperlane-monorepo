use std::{sync::Arc, time::Duration};

use derive_new::new;
use hyperlane_core::{
    rpc_clients::DEFAULT_MAX_RPC_RETRIES, total_estimated_cost, BatchResult,
    ChainCommunicationError, ChainResult, ConfirmReason, HyperlaneDomain, Mailbox,
    PendingOperation, PendingOperationStatus, QueueOperation, TxOutcome,
};
use itertools::{Either, Itertools};
use tokio::time::sleep;
use tracing::{info, instrument, warn};

use super::{
    op_queue::OpQueue,
    op_submitter::{submit_single_operation, SerialSubmitterMetrics},
    pending_message::CONFIRM_DELAY,
};

const BATCH_RETRY_SLEEP_DURATION: Duration = Duration::from_millis(100);

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

    #[instrument(skip(self, metrics), ret, level = "debug")]
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
            .submit_batch_with_retry(mailbox, DEFAULT_MAX_RPC_RETRIES, BATCH_RETRY_SLEEP_DURATION)
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
        for retry_number in 1..=max_retries {
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

    use std::{str::FromStr, sync::Arc};

    use crate::{
        merkle_tree::builder::MerkleTreeBuilder,
        msg::{
            gas_payment::GasPaymentEnforcer,
            metadata::{
                BaseMetadataBuilder, DefaultIsmCache, IsmAwareAppContextClassifier,
                IsmCachePolicyClassifier,
            },
            op_queue::test::MockPendingOperation,
            pending_message::{MessageContext, PendingMessage},
            processor::test::{dummy_cache_metrics, DummyApplicationOperationVerifier},
        },
        settings::{
            matching_list::MatchingList, GasPaymentEnforcementConf, GasPaymentEnforcementPolicy,
        },
        test_utils::dummy_data::dummy_submission_metrics,
    };
    use ethers::utils::hex;
    use hyperlane_base::{
        cache::{LocalCache, MeteredCache, MeteredCacheConfig, OptionalCache},
        db::{HyperlaneRocksDB, DB},
        settings::{ChainConf, ChainConnectionConf, CoreContractAddresses},
        CoreMetrics,
    };
    use hyperlane_core::{
        config::OpSubmissionConfig, Decode, HyperlaneMessage, KnownHyperlaneDomain,
        MessageSubmissionData, ReorgPeriod, SubmitterType, H160, U256,
    };
    use hyperlane_ethereum::{ConnectionConf, RpcConnectionConf};
    use hyperlane_test::mocks::{MockMailboxContract, MockValidatorAnnounceContract};
    use tokio::sync::RwLock;

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

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_handle_batch_succeeds_eventually() {
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
            .submit_batch_with_retry(mock_mailbox, 10, Duration::from_secs(0))
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

    #[tracing_test::traced_test]
    #[tokio::test]
    #[ignore]
    async fn benchmarking_with_real_rpcs() {
        let arb_chain_conf = ChainConf {
            domain: HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum),
            // TODO
            signer: None,
            submitter: SubmitterType::Classic,
            estimated_block_time: Duration::from_secs(1),
            reorg_period: ReorgPeriod::from_blocks(10),
            addresses: CoreContractAddresses {
                mailbox: H160::from_str("0x979Ca5202784112f4738403dBec5D0F3B9daabB9")
                    .unwrap()
                    .into(),
                validator_announce: H160::from_str("0x1df063280C4166AF9a725e3828b4dAC6c7113B08")
                    .unwrap()
                    .into(),
                ..Default::default()
            },
            connection: ChainConnectionConf::Ethereum(ConnectionConf {
                rpc_connection: RpcConnectionConf::HttpFallback {
                    urls: vec![
                        "https://arbitrum.drpc.org".parse().unwrap(),
                        "https://endpoints.omniatech.io/v1/arbitrum/one/public"
                            .parse()
                            .unwrap(),
                    ],
                },
                transaction_overrides: Default::default(),
                op_submission_config: OpSubmissionConfig {
                    batch_contract_address: None,
                    max_batch_size: 32,
                    bypass_batch_simulation: false,
                    ..Default::default()
                },
            }),
            metrics_conf: Default::default(),
            index: Default::default(),
        };

        // https://explorer.hyperlane.xyz/message/0x29160a18c6e27c2f14ebe021207ac3f90664507b9c5aacffd802b2afcc15788a
        // Base -> Arbitrum, uses the default ISM
        let message_bytes = hex::decode("0300139ebf000021050000000000000000000000005454cf5584939f7f884e95dba33fecd6d40b8fe20000a4b1000000000000000000000000fd34afdfbac1e47afc539235420e4be4a206f26d0000000000000000000000008650ee37ba2b0a8ac5954a04b46ee07093eab7f90000000000000000000000000000000000000000000000004563918244f40000").unwrap();
        let message = HyperlaneMessage::read_from(&mut &message_bytes[..]).unwrap();
        let base_domain = HyperlaneDomain::new_test_domain("base");
        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let base_db = HyperlaneRocksDB::new(&base_domain, db);

        let core_metrics = CoreMetrics::new("test", 9090, Default::default()).unwrap();
        let arb_mailbox: Arc<dyn Mailbox> = arb_chain_conf
            .build_mailbox(&core_metrics)
            .await
            .unwrap()
            .into();

        let cache = OptionalCache::new(Some(MeteredCache::new(
            LocalCache::new("test-cache"),
            dummy_cache_metrics(),
            MeteredCacheConfig {
                cache_name: "test-cache".to_owned(),
            },
        )));
        let base_va = Arc::new(MockValidatorAnnounceContract::default());
        let default_ism_getter = DefaultIsmCache::new(arb_mailbox.clone());
        let core_metrics = Arc::new(core_metrics);
        let metadata_builder = BaseMetadataBuilder::new(
            base_domain.clone(),
            arb_chain_conf.clone(),
            Arc::new(RwLock::new(MerkleTreeBuilder::new())),
            base_va,
            false,
            core_metrics.clone(),
            cache.clone(),
            base_db.clone(),
            IsmAwareAppContextClassifier::new(default_ism_getter.clone(), vec![]),
            IsmCachePolicyClassifier::new(default_ism_getter, Default::default()),
        );
        let message_context = Arc::new(MessageContext {
            destination_mailbox: arb_mailbox,
            origin_db: Arc::new(base_db.clone()),
            cache: cache.clone(),
            metadata_builder: Arc::new(metadata_builder),
            origin_gas_payment_enforcer: Arc::new(GasPaymentEnforcer::new(
                vec![GasPaymentEnforcementConf {
                    policy: GasPaymentEnforcementPolicy::None,
                    matching_list: MatchingList::default(),
                }],
                base_db.clone(),
            )),
            transaction_gas_limit: Default::default(),
            metrics: dummy_submission_metrics(),
            application_operation_verifier: Some(Arc::new(DummyApplicationOperationVerifier {})),
        });

        let attempts = 2;
        let batch_size = 32;

        let mut pending_messages = vec![];
        // Message found here https://basescan.org/tx/0x65345812a1f7df6236292d52d50418a090c84e2c901912bede6cadb9810a9882#eventlog
        let metadata =
        "0x000000100000001000000010000001680000000000000000000000100000015800000000000000000000000019dc38aeae620380430c200a6e990d5af5480117dbd3d5e656de9dcf604fcc90b52a3b97d9f3573b4a0733e824f1358e515698cf00139eaa5452e030aa937f6b14162a44ec3327f6832bbf16e4b0d6df452524af1c1a04e875b4ce7ac0da92aa08838a89f2a126eef23f6b6a08b6cdbe9e9e804b321088b91b034f9466eed2da1dcc36cb220b887b15f3e111a179142c27e4a0b6d6b7a291e22577d6296d82b7c3f29e8989ec1161d853aba0982b2db28b9a9917226c2c27111c41c99e6a84e7717740f901528062385e659b4330e7227593a334be532d27bcf24f3f13bf4fc1a860e96f8d6937984ea83ef61c8ea30d48cc903f6ff725406a4d1ce73f46064b3403ea4c720b770f4389d7259b275f085c6a98cef9a04880a249b42c382ba34a63031debbfb5b9b232ffd9ee45ff63a7249e83c7e9720f9e978a431b".as_bytes().to_vec();

        for b in 0..batch_size {
            let mut pending_message = PendingMessage::new(
                message.clone(),
                message_context.clone(),
                PendingOperationStatus::FirstPrepareAttempt,
                Some(format!("test-{}", b)),
                attempts,
            );
            pending_message.submission_data = Some(Box::new(MessageSubmissionData {
                metadata: metadata.clone(),
                gas_limit: U256::from(615293),
            }));
            pending_messages.push(pending_message);
        }

        let arb_domain = HyperlaneDomain::new_test_domain("arbitrum");
        let serial_submitter_metrics =
            SerialSubmitterMetrics::new(core_metrics.clone(), &arb_domain);

        let operation_batch = OperationBatch::new(
            pending_messages
                .into_iter()
                .map(|msg| Box::new(msg) as Box<dyn PendingOperation>)
                .collect(),
            arb_domain,
        );
        operation_batch
            .try_submit_as_batch(&serial_submitter_metrics)
            .await
            .unwrap();
    }
}
