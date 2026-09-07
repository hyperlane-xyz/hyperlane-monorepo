use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum TrieError {
    #[error("Standard error: {0}")]
    Std(#[from] StdError),

    #[error("RLP decode error: {0}")]
    RlpError(String),

    #[error("Root hash mismatch: expected {expected}, actual {actual}")]
    RootMismatch { expected: String, actual: String },

    #[error("Node hash mismatch at path: expected {expected}, actual {actual}")]
    NodeHashMismatch { expected: String, actual: String },

    #[error("Invalid path encoding or prefix: {0}")]
    InvalidPathEncoding(String),

    #[error("Path not found or mismatched in trie at depth {depth}")]
    KeyNotFound { depth: usize },

    #[error("Invalid branch node length: expected 17, got {0}")]
    InvalidBranchNode(usize),

    #[error("Invalid node structure: {0}")]
    InvalidNodeStructure(String),

    #[error("Account RLP format invalid: {0}")]
    InvalidAccountRlp(String),

    #[error("Proof list empty")]
    EmptyProof,

    #[error("Storage value mismatch: expected {expected}, actual {actual}")]
    ValueMismatch { expected: String, actual: String },
}
