use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("Standard error: {0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Invalid execution state root length: expected 32 bytes")]
    InvalidStateRootLength {},

    #[error("Slot not found: {slot}")]
    SlotNotFound { slot: u64 },

    #[error("Slot must be greater than zero")]
    InvalidSlot {},

    #[error("Invalid sync committee proof")]
    InvalidProof {},

    #[error("Sync committee poseidon hash mismatch")]
    SyncCommitteeMismatch {},

    #[error("Slot {slot} already has a state root registered")]
    SlotAlreadyRegistered { slot: u64 },
}
