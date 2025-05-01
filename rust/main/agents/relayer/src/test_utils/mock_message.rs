#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        fmt::Debug,
        str::FromStr,
        sync::Arc,
        time::{Duration, Instant},
    };

    use ethers::{types::H160, utils::hex};
    use futures::future::try_join_all;
    use hyperlane_base::db::*;
    use hyperlane_base::{
        cache::OptionalCache,
        settings::{ChainConf, ChainConnectionConf, CoreContractAddresses},
        CoreMetrics,
    };
    use hyperlane_ethereum::{ConnectionConf, RpcConnectionConf};
    use hyperlane_test::mocks::{MockMailboxContract, MockValidatorAnnounceContract};
    use prometheus::{
        histogram_opts, labels, opts, register_counter_vec_with_registry,
        register_gauge_vec_with_registry, register_histogram_vec_with_registry,
        register_int_counter_vec, register_int_counter_vec_with_registry, register_int_gauge_vec,
        register_int_gauge_vec_with_registry, CounterVec, Encoder, GaugeVec, HistogramVec,
        IntCounter, IntCounterVec, IntGauge, IntGaugeVec, Opts, Registry,
    };

    use hyperlane_core::{
        config::OpSubmissionConfig, identifiers::UniqueIdentifier, BatchItem, ChainResult, Decode,
        GasPaymentKey, HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack,
        HyperlaneDomainType, HyperlaneMessage, HyperlaneProvider, InterchainGasPayment,
        InterchainGasPaymentMeta, Mailbox, MerkleTreeInsertion, MessageSubmissionData,
        PendingOperation, PendingOperationResult, PendingOperationStatus, ReorgPeriod,
        ReprepareReason, SubmitterType, TryBatchAs, TxOutcome, H256, U256,
    };
    use serde::Serialize;
    use tokio::sync::{self, Mutex, RwLock};

    use crate::{
        merkle_tree::builder::MerkleTreeBuilder,
        metrics::message_submission::MessageSubmissionMetrics,
        msg::{
            gas_payment::GasPaymentEnforcer,
            metadata::{
                BaseMetadataBuilder, DefaultIsmCache, IsmAwareAppContextClassifier,
                IsmCachePolicyClassifier,
            },
            op_queue::OpQueue,
            op_submitter::{
                confirm_classic_task, prepare_classic_task, submit_classic_task,
                SerialSubmitterMetrics,
            },
            pending_message::{MessageContext, PendingMessage},
            processor::test::{dummy_submission_metrics, DummyApplicationOperationVerifier},
        },
        test_utils::mock_base_builder::MockBaseMetadataBuilder,
    };

    type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

    #[derive(Serialize)]
    pub struct MockMessage {
        pub message: PendingMessage,
        #[serde(skip)]
        pub prepare_responses: ResponseList<PendingOperationResult>,
    }

    impl Debug for MockMessage {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{:?}", self.message)
        }
    }

    #[async_trait::async_trait]
    #[typetag::serialize]
    impl PendingOperation for MockMessage {
        fn id(&self) -> H256 {
            self.message.id()
        }

        fn status(&self) -> PendingOperationStatus {
            self.message.status()
        }

        fn set_status(&mut self, status: PendingOperationStatus) {
            self.message.set_status(status)
        }

        fn priority(&self) -> u32 {
            self.message.priority()
        }

        fn origin_domain_id(&self) -> u32 {
            self.message.origin_domain_id()
        }

        fn destination_domain(&self) -> &HyperlaneDomain {
            self.message.destination_domain()
        }

        fn sender_address(&self) -> &H256 {
            self.message.sender_address()
        }

        fn recipient_address(&self) -> &H256 {
            self.message.recipient_address()
        }

        fn retrieve_status_from_db(&self) -> Option<PendingOperationStatus> {
            self.message.retrieve_status_from_db()
        }

        fn app_context(&self) -> Option<String> {
            self.message.app_context()
        }

        async fn prepare(&mut self) -> PendingOperationResult {
            self.prepare_responses
                .lock()
                .await
                .pop_front()
                .expect("No mock prepare response set")
        }

        async fn submit(&mut self) -> PendingOperationResult {
            self.message.submit().await
        }

        fn set_submission_outcome(&mut self, outcome: TxOutcome) {
            self.message.set_submission_outcome(outcome)
        }

        fn get_tx_cost_estimate(&self) -> Option<U256> {
            self.message.get_tx_cost_estimate()
        }

        async fn confirm(&mut self) -> PendingOperationResult {
            self.message.confirm().await
        }

        fn set_operation_outcome(
            &mut self,
            submission_outcome: TxOutcome,
            submission_estimated_cost: U256,
        ) {
            self.message
                .set_operation_outcome(submission_outcome, submission_estimated_cost)
        }

        fn next_attempt_after(&self) -> Option<Instant> {
            self.message.next_attempt_after()
        }

        fn set_next_attempt_after(&mut self, delay: Duration) {
            self.message.set_next_attempt_after(delay)
        }

        fn reset_attempts(&mut self) {
            self.message.reset_attempts();
        }

        fn set_retries(&mut self, retries: u32) {
            self.message.set_retries(retries);
        }

        fn get_retries(&self) -> u32 {
            self.message.get_retries()
        }

        fn try_get_mailbox(&self) -> Option<Arc<dyn Mailbox>> {
            self.message.try_get_mailbox()
        }

        fn get_metric(&self) -> Option<Arc<IntGauge>> {
            self.message.get_metric()
        }

        fn set_metric(&mut self, metric: Arc<IntGauge>) {
            self.message.set_metric(metric)
        }

        async fn payload(&self) -> ChainResult<Vec<u8>> {
            self.message.payload().await
        }

        fn on_reprepare(
            &mut self,
            err: Option<String>,
            reason: ReprepareReason,
        ) -> PendingOperationResult {
            self.message.on_reprepare(err, reason)
        }
    }

    impl TryBatchAs<HyperlaneMessage> for MockMessage {
        fn try_batch(&self) -> ChainResult<BatchItem<HyperlaneMessage>> {
            self.message.try_batch()
        }
    }

    fn dummy_metrics_and_label() -> (IntGaugeVec, String) {
        (
            IntGaugeVec::new(
                prometheus::Opts::new("op_queue", "OpQueue metrics"),
                &[
                    "destination",
                    "queue_metrics_label",
                    "operation_status",
                    "app_context",
                ],
            )
            .unwrap(),
            "queue_metrics_label".to_string(),
        )
    }

    mockall::mock! {
        pub Db {
            fn provider(&self) -> Box<dyn HyperlaneProvider>;
        }

        impl Debug for Db {
            fn fmt<'a>(&self, f: &mut std::fmt::Formatter<'a>) -> std::fmt::Result;
        }

        impl HyperlaneDb for Db {
            fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>>;
            fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>>;
            fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>>;
            fn domain(&self) -> &HyperlaneDomain;
            fn store_message_id_by_nonce(&self, nonce: &u32, id: &H256) -> DbResult<()>;
            fn retrieve_message_id_by_nonce(&self, nonce: &u32) -> DbResult<Option<H256>>;
            fn store_message_by_id(&self, id: &H256, message: &HyperlaneMessage) -> DbResult<()>;
            fn retrieve_message_by_id(&self, id: &H256) -> DbResult<Option<HyperlaneMessage>>;
            fn store_dispatched_block_number_by_nonce(
                &self,
                nonce: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>>;
            fn store_processed_by_nonce(&self, nonce: &u32, processed: &bool) -> DbResult<()>;
            fn store_processed_by_gas_payment_meta(
                &self,
                meta: &InterchainGasPaymentMeta,
                processed: &bool,
            ) -> DbResult<()>;
            fn retrieve_processed_by_gas_payment_meta(
                &self,
                meta: &InterchainGasPaymentMeta,
            ) -> DbResult<Option<bool>>;
            fn store_interchain_gas_expenditure_data_by_message_id(
                &self,
                message_id: &H256,
                data: &InterchainGasExpenditureData,
            ) -> DbResult<()>;
            fn retrieve_interchain_gas_expenditure_data_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<InterchainGasExpenditureData>>;
            fn store_status_by_message_id(
                &self,
                message_id: &H256,
                status: &PendingOperationStatus,
            ) -> DbResult<()>;
            fn retrieve_status_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<PendingOperationStatus>>;
            fn store_interchain_gas_payment_data_by_gas_payment_key(
                &self,
                key: &GasPaymentKey,
                data: &InterchainGasPaymentData,
            ) -> DbResult<()>;
            fn retrieve_interchain_gas_payment_data_by_gas_payment_key(
                &self,
                key: &GasPaymentKey,
            ) -> DbResult<Option<InterchainGasPaymentData>>;
            fn store_gas_payment_by_sequence(
                &self,
                sequence: &u32,
                payment: &InterchainGasPayment,
            ) -> DbResult<()>;
            fn retrieve_gas_payment_by_sequence(
                &self,
                sequence: &u32,
            ) -> DbResult<Option<InterchainGasPayment>>;
            fn store_gas_payment_block_by_sequence(
                &self,
                sequence: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_gas_payment_block_by_sequence(&self, sequence: &u32) -> DbResult<Option<u64>>;
            fn store_pending_message_retry_count_by_message_id(
                &self,
                message_id: &H256,
                count: &u32,
            ) -> DbResult<()>;
            fn retrieve_pending_message_retry_count_by_message_id(
                &self,
                message_id: &H256,
            ) -> DbResult<Option<u32>>;
            fn store_merkle_tree_insertion_by_leaf_index(
                &self,
                leaf_index: &u32,
                insertion: &MerkleTreeInsertion,
            ) -> DbResult<()>;
            fn retrieve_merkle_tree_insertion_by_leaf_index(
                &self,
                leaf_index: &u32,
            ) -> DbResult<Option<MerkleTreeInsertion>>;
            fn store_merkle_leaf_index_by_message_id(
                &self,
                message_id: &H256,
                leaf_index: &u32,
            ) -> DbResult<()>;
            fn retrieve_merkle_leaf_index_by_message_id(&self, message_id: &H256) -> DbResult<Option<u32>>;
            fn store_merkle_tree_insertion_block_number_by_leaf_index(
                &self,
                leaf_index: &u32,
                block_number: &u64,
            ) -> DbResult<()>;
            fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                &self,
                leaf_index: &u32,
            ) -> DbResult<Option<u64>>;
            fn store_highest_seen_message_nonce_number(&self, nonce: &u32) -> DbResult<()>;
            fn retrieve_highest_seen_message_nonce_number(&self) -> DbResult<Option<u32>>;
            fn store_payload_ids_by_message_id(&self, message_id: &H256, payload_ids: Vec<UniqueIdentifier>) -> DbResult<()>;
            fn retrieve_payload_ids_by_message_id(&self, message_id: &H256) -> DbResult<Option<Vec<UniqueIdentifier>>>;
        }
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_status_error() {
        let domain = HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Arbitrum);
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

        let cache = OptionalCache::new(None);
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
            origin_gas_payment_enforcer: Arc::new(GasPaymentEnforcer::new(vec![], base_db.clone())),
            transaction_gas_limit: Default::default(),
            metrics: dummy_submission_metrics(),
            application_operation_verifier: Some(Arc::new(DummyApplicationOperationVerifier {})),
        });
        let metadata =
        "0x000000100000001000000010000001680000000000000000000000100000015800000000000000000000000019dc38aeae620380430c200a6e990d5af5480117dbd3d5e656de9dcf604fcc90b52a3b97d9f3573b4a0733e824f1358e515698cf00139eaa5452e030aa937f6b14162a44ec3327f6832bbf16e4b0d6df452524af1c1a04e875b4ce7ac0da92aa08838a89f2a126eef23f6b6a08b6cdbe9e9e804b321088b91b034f9466eed2da1dcc36cb220b887b15f3e111a179142c27e4a0b6d6b7a291e22577d6296d82b7c3f29e8989ec1161d853aba0982b2db28b9a9917226c2c27111c41c99e6a84e7717740f901528062385e659b4330e7227593a334be532d27bcf24f3f13bf4fc1a860e96f8d6937984ea83ef61c8ea30d48cc903f6ff725406a4d1ce73f46064b3403ea4c720b770f4389d7259b275f085c6a98cef9a04880a249b42c382ba34a63031debbfb5b9b232ffd9ee45ff63a7249e83c7e9720f9e978a431b".as_bytes().to_vec();

        let mut pending_message = PendingMessage::new(
            message.clone(),
            message_context.clone(),
            PendingOperationStatus::FirstPrepareAttempt,
            Some(format!("test-{}", 0)),
            2,
        );
        pending_message.submission_data = Some(Box::new(MessageSubmissionData {
            metadata: metadata.clone(),
            gas_limit: U256::from(615293),
        }));

        let vec_deque: VecDeque<_> = [
            PendingOperationResult::Success,
            PendingOperationResult::Reprepare(ReprepareReason::ErrorEstimatingGas),
            PendingOperationResult::Success,
            PendingOperationResult::Reprepare(ReprepareReason::ErrorEstimatingGas),
            PendingOperationResult::Success,
            PendingOperationResult::Reprepare(ReprepareReason::ErrorEstimatingGas),
            PendingOperationResult::Success,
        ]
        .into_iter()
        .collect();

        let message = MockMessage {
            message: pending_message,
            prepare_responses: Arc::new(Mutex::new(vec_deque)),
        };

        let broadcaster = sync::broadcast::Sender::new(100);

        let receiver = Arc::new(Mutex::new(broadcaster.subscribe()));
        let (metrics, _) = dummy_metrics_and_label();
        let prepare_queue = OpQueue::new(metrics.clone(), "prepare".into(), receiver.clone());
        let submit_queue = OpQueue::new(metrics.clone(), "submit".into(), receiver.clone());
        let confirm_queue = OpQueue::new(metrics.clone(), "confirm".into(), receiver.clone());

        let submitter_queue_length = register_int_gauge_vec!(
            opts!("submitter_queue_length", "Submitter queue length",),
            &["remote", "queue_name", "operation_status", "app_context"],
        )
        .unwrap();
        let operations_processed_count = IntCounter::new(
            "operations_processed_count",
            "Number of operations processed",
        )
        .unwrap();

        let serial_submitter_metrics = SerialSubmitterMetrics {
            submitter_queue_length,
            ops_confirmed: operations_processed_count.clone(),
            ops_dropped: operations_processed_count.clone(),
            ops_failed: operations_processed_count.clone(),
            ops_prepared: operations_processed_count.clone(),
            ops_submitted: operations_processed_count.clone(),
        };

        prepare_queue
            .push(
                Box::new(message),
                Some(PendingOperationStatus::FirstPrepareAttempt),
            )
            .await;

        let prepare_task = tokio::task::Builder::new()
            .spawn(prepare_classic_task(
                domain.clone(),
                prepare_queue.clone(),
                submit_queue.clone(),
                confirm_queue.clone(),
                10,
                None,
                serial_submitter_metrics.clone(),
            ))
            .unwrap();

        let submit_task = tokio::task::Builder::new()
            .spawn(submit_classic_task(
                domain.clone(),
                prepare_queue.clone(),
                submit_queue.clone(),
                confirm_queue.clone(),
                10,
                serial_submitter_metrics.clone(),
            ))
            .unwrap();

        let confirm_task = tokio::task::Builder::new()
            .spawn(confirm_classic_task(
                domain.clone(),
                prepare_queue.clone(),
                confirm_queue.clone(),
                10,
                serial_submitter_metrics.clone(),
            ))
            .unwrap();

        let tasks = [prepare_task, submit_task, confirm_task];

        if let Err(err) = try_join_all(tasks).await {
            eprintln!("Error {:?}", err);
        }
    }
}
