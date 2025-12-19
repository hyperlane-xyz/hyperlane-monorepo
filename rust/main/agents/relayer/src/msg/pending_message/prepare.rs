use lander::{Entrypoint, FullPayload, PayloadUuid};
use tracing::instrument;
use tracing::{debug, info, trace};

use hyperlane_core::PendingOperationResult;
use hyperlane_core::ReprepareReason;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ConfirmReason, HyperlaneMessage, MessageSubmissionData,
    Metadata, PendingOperation, TxCostEstimate,
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
            match estimate_gas_costs(
                &pending_message.ctx,
                &pending_message.message,
                &pending_message.cached_payload,
                &metadata,
            )
            .await
            {
                Ok(Some((gas_estimate, full_payload))) => {
                    pending_message.cached_payload = full_payload;
                    Some(gas_estimate)
                }
                _ => {
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
            match estimate_gas_costs(
                &pending_message.ctx,
                &pending_message.message,
                &pending_message.cached_payload,
                &metadata,
            )
            .await
            {
                Ok(Some((gas_estimate, full_payload))) => {
                    pending_message.cached_payload = full_payload;
                    gas_estimate
                }
                Ok(None) => {
                    let reason = pending_message
                        .clarify_reason(ReprepareReason::ErrorEstimatingGas)
                        .await
                        .unwrap_or(ReprepareReason::ErrorEstimatingGas);
                    pending_message.clear_metadata();
                    return pending_message.on_reprepare::<ChainCommunicationError>(None, reason);
                }
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
    cached_payload: &Option<FullPayload>,
    metadata: &Metadata,
) -> ChainResult<Option<(TxCostEstimate, Option<FullPayload>)>> {
    match &message_context.payload_dispatcher_entrypoint {
        None => {
            let gas_estimate = message_context
                .destination_mailbox
                .process_estimate_costs(message, metadata)
                .await?;
            Ok(Some((gas_estimate, None)))
        }
        Some(entrypoint) => {
            let payload = match cached_payload.as_ref() {
                Some(s) => s.clone(),
                None => create_payload(message_context, message, metadata).await?,
            };
            let gas_estimate = entrypoint
                .estimate_gas_limit(&payload)
                .await
                .map_err(|e| ChainCommunicationError::from_other(e))?;
            Ok(gas_estimate.map(|ge| (ge, Some(payload))))
        }
    }
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

    // Create FullPayload with a random UUID and the message ID as identifier
    Ok(FullPayload::new(
        PayloadUuid::random(),
        format!("{:?}", message_id),
        operation_payload,
        success_criteria,
        message_context.destination_mailbox.address().into(),
    ))
}
