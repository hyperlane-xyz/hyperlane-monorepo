//! Stable public errors assembled from typed observations, never Display/Debug output.
use hyperlane_core::DiagnosticError;
use serde_json::Value;

use super::{MetadataBuildError, OffchainReadState};

pub fn retry_diagnostic(reason: &hyperlane_core::ReprepareReason) -> Option<DiagnosticError> {
    use hyperlane_core::ReprepareReason::*;
    if matches!(reason, Manual) {
        return None;
    }
    let code = match reason {
        GasPaymentNotFound => "gas_payment_missing",
        GasPaymentRequirementNotMet => "gas_payment_requirement_not_met",
        ExceedsMaxGasLimit => "gas_limit_exceeded",
        AwaitingValidatorSignatures => "validator_quorum_unavailable",
        AwaitingIcaReveal => "ica_commit_not_confirmed",
        ApplicationReport(_) => "application_verification_failed",
        RevertedOrReorged => "transaction_reverted_or_reorged",
        _ => "message_retry",
    };
    Some(DiagnosticError::new(code, &reason.to_string(), "relayer"))
}

pub fn metadata_diagnostic(error: &MetadataBuildError) -> DiagnosticError {
    use MetadataBuildError::*;
    let (code, message) = match error {
        FailedToBuild(_) => ("metadata_build_failed", Some("Metadata build failed")),
        ChainError(error) => {
            return DiagnosticError::new(
                "metadata_chain_call_failed",
                "Chain call failed while building ISM metadata",
                "ism",
            )
            .with_cause(error.as_ref().clone())
        }
        FastPathError(_) => (
            "fast_path_metadata_failed",
            Some("Fast path metadata failed"),
        ),
        Refused(_) => (
            "validator_reorg_reported",
            Some("Validator reported a reorg"),
        ),
        CouldNotFetch => ("metadata_unavailable", None),
        AwaitingValidatorSignatures => ("validator_quorum_unavailable", None),
        UnsupportedModuleType(_) => ("unsupported_ism_type", None),
        MaxIsmDepthExceeded(_) => ("ism_depth_exceeded", None),
        MaxIsmCountReached(_) => ("ism_count_exceeded", None),
        MaxValidatorCountReached(_) => ("validator_count_exceeded", None),
        AggregationThresholdNotMet(_) => ("aggregation_threshold_not_met", None),
        MerkleRootMismatch {
            root,
            canonical_root,
        } => {
            return DiagnosticError::new(
                "merkle_root_mismatch",
                &format!("Merkle root mismatch ({root:#x}, {canonical_root:#x})"),
                "ism",
            )
            .with_detail("root", format!("{root:#x}"))
            .with_detail("canonical_root", format!("{canonical_root:#x}"))
        }
    };
    // None selects Display only for variants containing typed public data.
    let message = message
        .map(str::to_owned)
        .unwrap_or_else(|| error.to_string());
    let diagnostic = DiagnosticError::new(code, &message, "ism");
    match error {
        AggregationThresholdNotMet(threshold) => diagnostic.with_detail("threshold", *threshold),
        MaxIsmDepthExceeded(value)
        | MaxIsmCountReached(value)
        | MaxValidatorCountReached(value) => diagnostic.with_detail("limit_observed", *value),
        _ => diagnostic,
    }
}

pub fn offchain_diagnostic(state: OffchainReadState) -> Option<DiagnosticError> {
    use OffchainReadState::*;
    let (code, message) = match state {
        Succeeded => return None,
        LookupFailed => (
            "offchain_lookup_failed",
            "Could not obtain offchain lookup configuration",
        ),
        OriginTransactionMissing => (
            "origin_transaction_missing",
            "Origin transaction hash is not available locally",
        ),
        OriginTransactionLookupFailed => (
            "origin_transaction_lookup_failed",
            "Origin transaction lookup failed",
        ),
        UrlRejected => ("gateway_url_rejected", "Offchain gateway URL was rejected"),
        ClientFailed => (
            "gateway_client_failed",
            "Offchain HTTP client initialization failed",
        ),
        SigningFailed => ("gateway_signing_failed", "Offchain request signing failed"),
        RequestTimeout => (
            "gateway_request_timeout",
            "Offchain gateway did not respond within the request timeout",
        ),
        RequestFailed => ("gateway_request_failed", "Offchain gateway request failed"),
        BodyReadFailed => (
            "gateway_body_read_failed",
            "Offchain gateway response could not be read",
        ),
        Pending => (
            "attestation_pending",
            "Offchain attestation is not available yet",
        ),
        InvalidResponse => (
            "gateway_invalid_response",
            "Offchain gateway returned an invalid response",
        ),
        PendingRetriesExhausted => (
            "attestation_pending_retries_exhausted",
            "Attestation remained pending after gateway polling",
        ),
        NoEndpoints => (
            "offchain_no_endpoints",
            "ISM returned no offchain gateway endpoints",
        ),
    };
    Some(DiagnosticError::new(code, message, "ccip_gateway"))
}

pub fn checkpoint_diagnostic(
    validator: &str,
    reason: &str,
    index: &Value,
    discovery: bool,
) -> DiagnosticError {
    let (code, message) = match reason {
        "missing" if discovery => (
            "validator_latest_index_missing",
            "Validator latest checkpoint index was unavailable",
        ),
        "fetch_error" if discovery => (
            "validator_latest_index_fetch_failed",
            "Validator latest checkpoint index could not be read",
        ),
        "no_storage" => (
            "validator_storage_unavailable",
            "No usable checkpoint storage was discovered for this validator",
        ),
        "missing" => (
            "validator_checkpoint_missing",
            "Validator checkpoint was not available at the requested index",
        ),
        "fetch_error" => (
            "validator_checkpoint_fetch_failed",
            "Validator checkpoint storage could not be read",
        ),
        "index_mismatch" => (
            "validator_checkpoint_index_mismatch",
            "Validator checkpoint index did not match the requested index",
        ),
        "invalid_signature" => (
            "validator_signature_invalid",
            "Validator checkpoint signature could not be recovered",
        ),
        "signer_mismatch" => (
            "validator_signer_mismatch",
            "Checkpoint signer did not match the expected validator",
        ),
        _ => (
            "validator_checkpoint_unavailable",
            "Validator checkpoint was unavailable",
        ),
    };
    DiagnosticError::new(code, message, "validator")
        .with_detail("validator", validator)
        .with_detail(
            "checkpoint_index",
            if discovery {
                Value::Null
            } else {
                index.clone()
            },
        )
}
