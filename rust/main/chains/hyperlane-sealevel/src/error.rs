use hyperlane_core::{rpc_clients::RpcClientError, ChainCommunicationError, H512};
use solana_client::{
    client_error::{ClientError, ClientErrorKind},
    rpc_custom_error::{
        JSON_RPC_SERVER_ERROR_BLOCK_CLEANED_UP, JSON_RPC_SERVER_ERROR_BLOCK_NOT_AVAILABLE,
        JSON_RPC_SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED, JSON_RPC_SERVER_ERROR_SLOT_SKIPPED,
    },
    rpc_request::RpcError,
};
use solana_sdk::pubkey::ParsePubkeyError;
use solana_transaction_status::{EncodedTransaction, UiMessage};

/// Errors from the crates specific to the hyperlane-sealevel
/// implementation.
/// This error can then be converted into the broader error type
/// in hyperlane-core using the `From` trait impl
#[derive(Debug, thiserror::Error)]
pub enum HyperlaneSealevelError {
    /// ParsePubkeyError error
    #[error("{0}")]
    ParsePubkeyError(#[from] ParsePubkeyError),
    /// ClientError error
    #[error("{0}")]
    ClientError(#[from] Box<ClientError>),
    /// Decoding error
    #[error("{0}")]
    Decoding(#[from] solana_sdk::bs58::decode::Error),
    /// No transaction in block error
    #[error("{0}")]
    NoTransactions(String),
    /// Too many transactions of particular content in block
    #[error("{0}")]
    TooManyTransactions(String),
    /// Unsupported transaction encoding
    #[error("{0:?}")]
    UnsupportedTransactionEncoding(Box<EncodedTransaction>),
    /// Unsupported message encoding
    #[error("{0:?}")]
    UnsupportedMessageEncoding(Box<UiMessage>),
    /// Unsigned transaction
    #[error("{0}")]
    UnsignedTransaction(Box<H512>),
    /// Incorrect transaction
    #[error("received incorrect transaction, expected hash: {0:?}, received hash: {1:?}")]
    IncorrectTransaction(Box<H512>, Box<H512>),
    /// Empty metadata
    #[error("received empty metadata in transaction")]
    EmptyMetadata,
    /// Empty compute units consumed
    #[error("received empty compute units consumed in transaction")]
    EmptyComputeUnitsConsumed,
    /// Too many non-native programs
    #[error("transaction contains too many non-native programs, hash: {0:?}")]
    TooManyNonNativePrograms(Box<H512>),
    /// No non-native programs
    #[error("transaction contains no non-native programs, hash: {0:?}")]
    NoNonNativePrograms(Box<H512>),
}

impl HyperlaneSealevelError {
    /// Whether this error means a specific event's log meta could not be
    /// resolved from the block recorded on its storage account (the block does
    /// not contain the expected transaction after filtering, or contains more
    /// than one). These are non-retryable: the block will never contain the
    /// transaction, so sequence-aware indexing should fall back to basic log
    /// meta and advance rather than rewinding on the same sequence forever.
    pub fn is_log_meta_unresolvable(&self) -> bool {
        matches!(self, Self::NoTransactions(_) | Self::TooManyTransactions(_))
    }
}

/// Whether every exhausted RPC provider reports the requested block as
/// unavailable or skipped. `BlockNotAvailable` can be transient at one
/// provider, but after fallback exhaustion we prefer durable basic log meta to
/// stalling the sequence cursor; transport, health, and not-yet-available
/// errors remain retryable.
pub fn is_get_block_unresolvable_after_retries(err: &ChainCommunicationError) -> bool {
    if let ChainCommunicationError::RpcClientError(RpcClientError::FallbackProvidersFailed(
        errors,
    )) = err
    {
        return !errors.is_empty() && errors.iter().all(is_get_block_unresolvable_after_retries);
    }

    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(error) = source {
        if let Some(client_error) = error.downcast_ref::<ClientError>() {
            return is_fallback_get_block_error_kind(client_error.kind());
        }
        if let Some(client_error) = error.downcast_ref::<Box<ClientError>>() {
            return is_fallback_get_block_error_kind(client_error.kind());
        }
        if let Some(kind) = error.downcast_ref::<ClientErrorKind>() {
            return is_fallback_get_block_error_kind(kind);
        }
        if let Some(kind) = error.downcast_ref::<Box<ClientErrorKind>>() {
            return is_fallback_get_block_error_kind(kind);
        }
        if let Some(rpc_error) = error.downcast_ref::<RpcError>() {
            return is_fallback_get_block_rpc_error(rpc_error);
        }
        if let Some(rpc_error) = error.downcast_ref::<Box<RpcError>>() {
            return is_fallback_get_block_rpc_error(rpc_error);
        }
        source = error.source();
    }
    false
}

fn is_fallback_get_block_error_kind(kind: &ClientErrorKind) -> bool {
    match kind {
        ClientErrorKind::RpcError(error) => is_fallback_get_block_rpc_error(error),
        _ => false,
    }
}

fn is_fallback_get_block_rpc_error(error: &RpcError) -> bool {
    matches!(
        error,
        RpcError::RpcResponseError { code, .. }
            if matches!(
                *code,
                JSON_RPC_SERVER_ERROR_BLOCK_CLEANED_UP
                    | JSON_RPC_SERVER_ERROR_BLOCK_NOT_AVAILABLE
                    | JSON_RPC_SERVER_ERROR_SLOT_SKIPPED
                    | JSON_RPC_SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED
            )
    )
}

impl From<HyperlaneSealevelError> for ChainCommunicationError {
    fn from(value: HyperlaneSealevelError) -> Self {
        ChainCommunicationError::from_other(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_client::rpc_request::RpcResponseErrorData;

    fn rpc_error(code: i64) -> ChainCommunicationError {
        HyperlaneSealevelError::ClientError(Box::new(ClientError::from(ClientErrorKind::RpcError(
            RpcError::RpcResponseError {
                code,
                message: "test".to_owned(),
                data: RpcResponseErrorData::Empty,
            },
        ))))
        .into()
    }

    #[test]
    fn log_meta_unresolvable_errors_are_non_retryable() {
        assert!(HyperlaneSealevelError::NoTransactions("x".into()).is_log_meta_unresolvable());
        assert!(HyperlaneSealevelError::TooManyTransactions("x".into()).is_log_meta_unresolvable());
    }

    #[test]
    fn other_errors_are_not_log_meta_unresolvable() {
        assert!(!HyperlaneSealevelError::EmptyMetadata.is_log_meta_unresolvable());
        assert!(!HyperlaneSealevelError::EmptyComputeUnitsConsumed.is_log_meta_unresolvable());
        assert!(
            !HyperlaneSealevelError::UnsignedTransaction(Box::new(H512::zero()))
                .is_log_meta_unresolvable()
        );
    }

    #[test]
    fn exhausted_get_block_errors_are_classified_across_fallback_providers() {
        for code in [
            JSON_RPC_SERVER_ERROR_BLOCK_CLEANED_UP,
            JSON_RPC_SERVER_ERROR_BLOCK_NOT_AVAILABLE,
            JSON_RPC_SERVER_ERROR_SLOT_SKIPPED,
            JSON_RPC_SERVER_ERROR_LONG_TERM_STORAGE_SLOT_SKIPPED,
        ] {
            assert!(is_get_block_unresolvable_after_retries(&rpc_error(code)));
        }

        let all_unresolvable = RpcClientError::FallbackProvidersFailed(vec![
            rpc_error(JSON_RPC_SERVER_ERROR_BLOCK_CLEANED_UP),
            rpc_error(JSON_RPC_SERVER_ERROR_SLOT_SKIPPED),
        ])
        .into();
        assert!(is_get_block_unresolvable_after_retries(&all_unresolvable));
    }

    #[test]
    fn transient_get_block_errors_remain_retryable() {
        const BLOCK_STATUS_NOT_AVAILABLE_YET: i64 = -32014;
        assert!(!is_get_block_unresolvable_after_retries(&rpc_error(
            BLOCK_STATUS_NOT_AVAILABLE_YET
        )));

        let mixed = RpcClientError::FallbackProvidersFailed(vec![
            rpc_error(JSON_RPC_SERVER_ERROR_BLOCK_CLEANED_UP),
            rpc_error(BLOCK_STATUS_NOT_AVAILABLE_YET),
        ])
        .into();
        assert!(!is_get_block_unresolvable_after_retries(&mixed));
    }
}
