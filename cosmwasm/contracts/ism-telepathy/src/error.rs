use cosmwasm_std::StdError;
use mpt_verify::MptError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("MPT verification error: {0}")]
    Mpt(String),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Invalid metadata format")]
    InvalidMetadataFormat {},

    #[error("Invalid Hyperlane message format: length {0} is less than minimum 77 bytes")]
    InvalidMessageLength(usize),

    #[error("Invalid origin domain: expected {expected}, got {actual}")]
    InvalidOriginDomain { expected: u32, actual: u32 },

    #[error("No state root found in Telepathy Light Client for slot {0}")]
    NoStateRootForSlot(u64),

    #[error("Invalid mailbox address in metadata")]
    InvalidMailboxAddress {},

    #[error("Message verification failed: storage proof value mismatch")]
    VerificationFailed {},

    #[error("URLs cannot be empty")]
    EmptyUrls {},
}

impl From<MptError> for ContractError {
    fn from(err: MptError) -> Self {
        ContractError::Mpt(err.to_string())
    }
}
