use cosmwasm_std::StdError;
use cw_trie_verifier::TrieError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("Standard error: {0}")]
    Std(#[from] StdError),

    #[error("Trie verification error: {0}")]
    Trie(#[from] TrieError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Invalid message length: expected at least 77 bytes, got {0}")]
    InvalidMessageLength(usize),

    #[error("Origin domain mismatch: expected {expected}, got {actual}")]
    OriginDomainMismatch { expected: u32, actual: u32 },

    #[error("Invalid metadata format: {0}")]
    InvalidMetadata(String),

    #[error("Execution state root not found on light client for slot {slot}")]
    StateRootNotFound { slot: u64 },

    #[error("Dispatched hook address mismatch: expected {expected}, got {actual}")]
    DispatchedHookMismatch { expected: String, actual: String },

    #[error("Storage proof verification failed: message ID mismatch")]
    MessageIdMismatch {},

    #[error("Invalid address format: {0}")]
    InvalidAddress(String),
}
