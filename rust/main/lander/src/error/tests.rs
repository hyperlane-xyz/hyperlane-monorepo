use hyperlane_core::ChainCommunicationError;

use crate::error::{IsRetryable, LanderError};

fn make_chain_comm_err(msg: &str) -> LanderError {
    LanderError::ChainCommunicationError(ChainCommunicationError::from(eyre::eyre!(msg.to_owned())))
}

#[test]
fn test_exceeds_block_gas_limit_non_retryable() {
    let err = make_chain_comm_err("exceeds block gas limit");
    assert!(
        !err.is_retryable(),
        "Should not be retryable if exceeds block gas limit"
    );
}

#[test]
fn test_exceeds_block_gas_limit_with_retryable_string_non_retryable() {
    let err = make_chain_comm_err("already known; exceeds block gas limit");
    assert!(
        !err.is_retryable(),
        "Should not be retryable if exceeds block gas limit is present, even with retryable string"
    );
}

#[test]
fn test_retryable_string_only() {
    let err = make_chain_comm_err("already known");
    assert!(
        err.is_retryable(),
        "Should be retryable if only retryable string is present"
    );
}
