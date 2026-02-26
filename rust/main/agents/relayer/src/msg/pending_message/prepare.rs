use lander::{Entrypoint, FullPayload, PayloadUuid};
use tracing::instrument;
use tracing::{debug, info, trace};
use uuid::Uuid;

use hyperlane_core::PendingOperationResult;
use hyperlane_core::ReprepareReason;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ConfirmReason, HyperlaneMessage, MessageSubmissionData,
    Metadata, PendingOperation, TxCostEstimate, H256,
};

use crate::msg::pending_message::PendingMessage;
use crate::msg::pending_message::{
    GasPaymentRequirementOutcome, MessageContext, CONFIRM_DELAY, USE_CACHE_METADATA_LOG,
};

#[instrument(skip(pending_message), fields(id=?pending_message.message.id()), level = "debug")]
pub async fn handler(pending_message: &mut PendingMessage) -> PendingOperationResult {
    if !pending_message.is_ready() {
        trace!("Message is not ready to be submitted yet");
        return PendingOperationResult::NotReady;
    }

    let message_id = pending_message.message.id();
    // If the message has already been processed, e.g. due to another relayer having
    // already processed, then mark it as already-processed, and move on to
    // the next tick.
    let is_already_delivered = match pending_message
        .ctx
        .destination_mailbox
        .delivered(message_id)
        .await
    {
        Ok(is_delivered) => is_delivered,
        Err(err) => {
            return pending_message
                .on_reprepare(Some(err), ReprepareReason::ErrorCheckingDeliveryStatus);
        }
    };
    if is_already_delivered {
        debug!("Message has already been delivered, marking as submitted.");
        pending_message.submitted = true;
        pending_message.set_next_attempt_after(CONFIRM_DELAY);
        return PendingOperationResult::Confirm(ConfirmReason::AlreadySubmitted);
    }

    // We cannot deliver to an address that is not a contract so check and drop if it isn't.
    let is_contract = match pending_message.is_recipient_contract().await {
        Ok(is_contract) => is_contract,
        Err(reprepare_reason) => return reprepare_reason,
    };
    if !is_contract {
        info!(
            recipient=?pending_message.message.recipient,
            "Dropping message because recipient is not a contract"
        );
        return PendingOperationResult::Drop;
    }

    // Perform a preflight check to see if we can short circuit the gas
    // payment requirement check early without performing expensive
    // operations like metadata building or gas estimation.
    if let GasPaymentRequirementOutcome::RequirementNotMet(op_result) = pending_message
        .meets_gas_payment_requirement_preflight_check()
        .await
    {
        info!("Message does not meet the gas payment requirement preflight check");
        return op_result;
    }

    // If metadata is already built, check gas estimation works.
    // If gas estimation fails, invalidate cache and rebuild it again.
    let tx_cost_estimate = match pending_message.metadata.as_ref() {
        None => None,
        Some(metadata) => {
            match estimate_gas_costs(&pending_message.ctx, &pending_message.message, metadata).await
            {
                Ok(gas_estimate) => Some(gas_estimate),
                Err(err) => {
                    debug!(
                        error = ?err,
                        "Cached metadata gas estimation failed; rebuilding metadata"
                    );
                    pending_message.clear_metadata();
                    None
                }
            }
        }
    };

    let metadata = match pending_message.metadata.as_ref() {
        Some(metadata) => {
            tracing::debug!(USE_CACHE_METADATA_LOG);
            metadata.clone()
        }
        _ => match pending_message.build_metadata().await {
            Ok(metadata) => {
                pending_message.metadata = Some(metadata.clone());
                metadata
            }
            Err(err) => {
                return err;
            }
        },
    };

    // Estimate transaction costs for the process call. If there are issues, it's
    // likely that gas estimation has failed because the message is
    // reverting. This is defined behavior, so we just log the error and
    // move onto the next tick.
    let tx_cost_estimate = match tx_cost_estimate {
        // reuse old gas cost estimate if it succeeded
        Some(cost) => cost,
        None => {
            match estimate_gas_costs(&pending_message.ctx, &pending_message.message, &metadata)
                .await
            {
                Ok(gas_estimate) => gas_estimate,
                Err(err) => {
                    let reason = pending_message
                        .clarify_reason(ReprepareReason::ErrorEstimatingGas)
                        .await
                        .unwrap_or(ReprepareReason::ErrorEstimatingGas);
                    pending_message.clear_metadata();
                    return pending_message.on_reprepare(Some(err), reason);
                }
            }
        }
    };

    // Get the gas_limit if the gas payment requirement has been met,
    // otherwise return a PendingOperationResult and move on.
    let gas_limit = match pending_message
        .meets_gas_payment_requirement(&tx_cost_estimate)
        .await
    {
        GasPaymentRequirementOutcome::MeetsRequirement(gas_limit) => gas_limit,
        GasPaymentRequirementOutcome::RequirementNotMet(op_result) => {
            info!("Message does not meet the gas payment requirement after gas estimation");
            return op_result;
        }
    };

    // Go ahead and attempt processing of message to destination chain.
    debug!(
        ?gas_limit,
        ?tx_cost_estimate,
        "Gas payment requirement met, ready to process message"
    );

    if let Some(max_limit) = pending_message.ctx.transaction_gas_limit {
        if gas_limit > max_limit {
            // TODO: consider dropping instead of repreparing in this case
            pending_message.clear_metadata();
            return pending_message
                .on_reprepare::<String>(None, ReprepareReason::ExceedsMaxGasLimit);
        }
    }

    pending_message.submission_data = Some(Box::new(MessageSubmissionData {
        metadata,
        gas_limit,
    }));
    PendingOperationResult::Success
}

/// Get tx gas estimate
pub async fn estimate_gas_costs(
    message_context: &MessageContext,
    message: &HyperlaneMessage,
    metadata: &Metadata,
) -> ChainResult<TxCostEstimate> {
    match &message_context.payload_dispatcher_entrypoint {
        None => {
            let gas_estimate = message_context
                .destination_mailbox
                .process_estimate_costs(message, metadata)
                .await?;
            tracing::debug!(?gas_estimate, "Estimating gas with Classical");
            Ok(gas_estimate)
        }
        Some(entrypoint) => {
            let payload = create_payload(message_context, message, metadata).await?;
            let gas_estimate = entrypoint
                .estimate_gas_limit_for_preparation(&payload)
                .await
                .map_err(|err| {
                    tracing::warn!(error = ?err, "Lander preparation gas estimation failed");
                    ChainCommunicationError::from_other(err)
                })?;
            tracing::debug!(?gas_estimate, "Estimated gas with Lander");

            Ok(gas_estimate)
        }
    }
}

fn payload_uuid_from_message_id(message_id: H256) -> PayloadUuid {
    let message_id_bytes = message_id.to_fixed_bytes();
    // UUID is 128-bit. We use the first 16 bytes of the 256-bit message id for
    // deterministic retry identity; collision risk is negligible in practice.
    let mut uuid_bytes = [0u8; 16];
    uuid_bytes.copy_from_slice(&message_id_bytes[..16]);
    PayloadUuid::new(Uuid::from_bytes(uuid_bytes))
}

/// Create a FullPayload from the message and metadata for Lander estimation
pub async fn create_payload(
    message_context: &MessageContext,
    message: &HyperlaneMessage,
    metadata: &Metadata,
) -> ChainResult<FullPayload> {
    // Get operation calldata using Mailbox's process_calldata
    let operation_payload = message_context
        .destination_mailbox
        .process_calldata(message, metadata)
        .await?;

    let message_id = message.id();
    // Get success criteria calldata using Mailbox's delivered_calldata
    let success_criteria = message_context
        .destination_mailbox
        .delivered_calldata(message_id)?;

    // Use a deterministic UUID keyed by message ID so retries preserve payload identity.
    Ok(FullPayload::new(
        payload_uuid_from_message_id(message_id),
        format!("{message_id:?}"),
        operation_payload,
        success_criteria,
        message_context.destination_mailbox.address(),
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use tempfile::TempDir;
    use uuid::Uuid;

    use crate::msg::pending_message::MessageContext;
    use crate::test_utils::dummy_data::{dummy_message_context, dummy_metadata_builder};
    use hyperlane_base::cache::OptionalCache;
    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{
        BatchResult, ChainCommunicationError, FixedPointNumber, HyperlaneChain, HyperlaneContract,
        HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Mailbox, Metadata, QueueOperation,
        ReorgPeriod, TxCostEstimate, TxOutcome, H256, U256,
    };

    use super::{create_payload, estimate_gas_costs, payload_uuid_from_message_id};

    #[derive(Debug)]
    struct TestMailbox {
        domain: HyperlaneDomain,
        address: H256,
        estimate_response: TxCostEstimate,
        process_calldata_response: Vec<u8>,
        delivered_calldata_response: Option<Vec<u8>>,
        fail_process_estimate_costs: bool,
        fail_process_calldata: bool,
        fail_delivered_calldata: bool,
        process_estimate_costs_calls: AtomicUsize,
    }

    impl Default for TestMailbox {
        fn default() -> Self {
            Self {
                domain: HyperlaneDomain::new_test_domain("destination"),
                address: H256::zero(),
                estimate_response: TxCostEstimate {
                    gas_limit: U256::from(21_000),
                    gas_price: FixedPointNumber::zero(),
                    l2_gas_limit: None,
                },
                process_calldata_response: vec![1, 2, 3],
                delivered_calldata_response: Some(vec![4, 5, 6]),
                fail_process_estimate_costs: false,
                fail_process_calldata: false,
                fail_delivered_calldata: false,
                process_estimate_costs_calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl Mailbox for TestMailbox {
        async fn count(&self, _reorg_period: &ReorgPeriod) -> hyperlane_core::ChainResult<u32> {
            unimplemented!()
        }

        async fn delivered(&self, _id: H256) -> hyperlane_core::ChainResult<bool> {
            unimplemented!()
        }

        async fn default_ism(&self) -> hyperlane_core::ChainResult<H256> {
            unimplemented!()
        }

        async fn recipient_ism(&self, _recipient: H256) -> hyperlane_core::ChainResult<H256> {
            unimplemented!()
        }

        async fn process(
            &self,
            _message: &HyperlaneMessage,
            _metadata: &Metadata,
            _tx_gas_limit: Option<U256>,
        ) -> hyperlane_core::ChainResult<TxOutcome> {
            unimplemented!()
        }

        async fn process_estimate_costs(
            &self,
            _message: &HyperlaneMessage,
            _metadata: &Metadata,
        ) -> hyperlane_core::ChainResult<TxCostEstimate> {
            self.process_estimate_costs_calls
                .fetch_add(1, Ordering::Relaxed);
            if self.fail_process_estimate_costs {
                Err(ChainCommunicationError::CustomError(
                    "process_estimate_costs_failed".to_string(),
                ))
            } else {
                Ok(self.estimate_response.clone())
            }
        }

        async fn process_calldata(
            &self,
            _message: &HyperlaneMessage,
            _metadata: &Metadata,
        ) -> hyperlane_core::ChainResult<Vec<u8>> {
            if self.fail_process_calldata {
                Err(ChainCommunicationError::CustomError(
                    "process_calldata_failed".to_string(),
                ))
            } else {
                Ok(self.process_calldata_response.clone())
            }
        }

        fn delivered_calldata(
            &self,
            _message_id: H256,
        ) -> hyperlane_core::ChainResult<Option<Vec<u8>>> {
            if self.fail_delivered_calldata {
                Err(ChainCommunicationError::CustomError(
                    "delivered_calldata_failed".to_string(),
                ))
            } else {
                Ok(self.delivered_calldata_response.clone())
            }
        }

        async fn process_batch<'a>(
            &self,
            _ops: Vec<&'a QueueOperation>,
        ) -> hyperlane_core::ChainResult<BatchResult> {
            unimplemented!()
        }
    }

    impl HyperlaneChain for TestMailbox {
        fn domain(&self) -> &HyperlaneDomain {
            &self.domain
        }

        fn provider(&self) -> Box<dyn HyperlaneProvider> {
            panic!("provider is unused in prepare.rs unit tests")
        }
    }

    impl HyperlaneContract for TestMailbox {
        fn address(&self) -> H256 {
            self.address
        }
    }

    fn test_message_context(mailbox: Arc<dyn Mailbox>) -> (MessageContext, TempDir) {
        let origin_domain = HyperlaneDomain::new_test_domain("origin");
        let destination_domain = HyperlaneDomain::new_test_domain("destination");
        let cache = OptionalCache::new(None);

        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let base_db = HyperlaneRocksDB::new(&origin_domain, db);

        let base_metadata_builder =
            dummy_metadata_builder(&origin_domain, &destination_domain, &base_db, cache.clone());
        let mut message_context =
            dummy_message_context(Arc::new(base_metadata_builder), &base_db, cache);
        message_context.destination_mailbox = mailbox;

        (message_context, temp_dir)
    }

    fn test_message() -> HyperlaneMessage {
        HyperlaneMessage {
            nonce: 1,
            origin: 11,
            destination: 22,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn estimate_gas_costs_uses_mailbox_when_lander_entrypoint_is_absent() {
        let mailbox = Arc::new(TestMailbox::default());
        let (message_context, _temp_dir) =
            test_message_context(mailbox.clone() as Arc<dyn Mailbox>);

        let message = test_message();
        let metadata = Metadata::new(vec![1, 2, 3]);

        let gas_estimate = estimate_gas_costs(&message_context, &message, &metadata)
            .await
            .unwrap();

        assert_eq!(gas_estimate, mailbox.estimate_response);
        assert_eq!(
            mailbox.process_estimate_costs_calls.load(Ordering::Relaxed),
            1
        );
    }

    #[tokio::test]
    async fn create_payload_builds_deterministic_uuid_and_metadata_from_message_id() {
        let mailbox = Arc::new(TestMailbox::default());
        let (message_context, _temp_dir) = test_message_context(mailbox as Arc<dyn Mailbox>);

        let message = test_message();
        let metadata = Metadata::new(vec![7, 8, 9]);

        let payload_a = create_payload(&message_context, &message, &metadata)
            .await
            .unwrap();
        let payload_b = create_payload(&message_context, &message, &metadata)
            .await
            .unwrap();

        assert_eq!(payload_a.uuid(), payload_b.uuid());
        assert_eq!(
            *payload_a.uuid(),
            payload_uuid_from_message_id(message.id())
        );
        assert_eq!(payload_a.details.metadata, format!("{:?}", message.id()));
        assert_eq!(payload_a.data, vec![1, 2, 3]);
        assert_eq!(payload_a.details.success_criteria, Some(vec![4, 5, 6]));
        assert!(Uuid::parse_str(&payload_a.uuid().to_string()).is_ok());
    }

    #[tokio::test]
    async fn create_payload_propagates_process_calldata_errors() {
        let mailbox = Arc::new(TestMailbox {
            fail_process_calldata: true,
            ..Default::default()
        });
        let (message_context, _temp_dir) = test_message_context(mailbox as Arc<dyn Mailbox>);

        let message = test_message();
        let metadata = Metadata::new(vec![1]);

        let err = create_payload(&message_context, &message, &metadata)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("process_calldata_failed"));
    }

    #[tokio::test]
    async fn create_payload_propagates_delivered_calldata_errors() {
        let mailbox = Arc::new(TestMailbox {
            fail_delivered_calldata: true,
            ..Default::default()
        });
        let (message_context, _temp_dir) = test_message_context(mailbox as Arc<dyn Mailbox>);

        let message = test_message();
        let metadata = Metadata::new(vec![1]);

        let err = create_payload(&message_context, &message, &metadata)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("delivered_calldata_failed"));
    }
}
